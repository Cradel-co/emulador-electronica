import { afterEach, expect, it, vi } from 'vitest';
import { analizarAudio } from '../../web/microfono-senal.js';
import { ControladorMicrofono } from '../../web/microfono.js';
import type { CapturaMicrofono } from '../../web/microfono-captura.js';
import { nivelDesdeDbfs, MuestraEntradaSonidoSchema } from '@emu/shared';

afterEach(() => { vi.useRealTimers(); });
it('calcula RMS digital de un seno, silencio y envolvente acotada que conserva picos', () => {
  const seno = Float32Array.from({ length: 2048 }, (_, i) => .5 * Math.sin(2 * Math.PI * i / 32));
  const v = analizarAudio(seno);
  expect(v.rms).toBeCloseTo(.5 / Math.sqrt(2), 6);
  expect(v.dbfs).toBeCloseTo(-9.0309, 4);
  expect(v.envolvente).toHaveLength(128);
  expect(analizarAudio(new Float32Array(2048)).dbfs).toBeNull();
  const pulso = new Float32Array(2048); pulso[731] = 1;
  expect(analizarAudio(pulso)).toMatchObject({ pico: 1, saturada: true });
  expect(analizarAudio(pulso).envolvente.some(b => b.max === 1)).toBe(true);
  for (const muestras of [new Float32Array(), new Float32Array([NaN]), new Float32Array([Infinity]), new Float32Array([2])]) {
    expect(() => analizarAudio(muestras)).toThrow();
  }
});
it('la referencia estima un estímulo sin confundirlo con dBA ni recortarlo antes del sensor', () => {
  expect(nivelDesdeDbfs(-10, { dbfs: -20, nivel: 80 })).toBe(90);
  expect(nivelDesdeDbfs(null, { dbfs: -20, nivel: 80 })).toBe(0);
  expect(nivelDesdeDbfs(-10, { dbfs: -100, nivel: 100 })).toBe(190);
  const muestra = { secuencia: 1, dbfs: -20, referencia: { dbfs: -20, nivel: 80 } };
  expect(MuestraEntradaSonidoSchema.safeParse({ ...muestra, audio: [1] }).success).toBe(false);
  expect(MuestraEntradaSonidoSchema.safeParse({ ...muestra, dbfs: NaN }).success).toBe(false);
});
function banco() {
  const cerrar = vi.fn(async () => {});
  const captura: CapturaMicrofono = { cerrar, ajustes: {}, leer: () => ({ muestras: new Float32Array(2048).fill(.1), frecuenciaHz: 48000, tiempoAudioS: 1 }) };
  const pedidos: { metodo: string; cuerpo: unknown }[] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    pedidos.push({ metodo: init?.method ?? '', cuerpo: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(init?.method === 'POST' ? { id: 'sesion' } : { ok: true }), { status: 200 });
  });
  const abrir = vi.fn(async () => captura);
  const deps = { abrir, dispositivos: async () => [], fetch: fetcher as typeof fetch };
  return { cerrar, captura, pedidos, deps, control: new ControladorMicrofono('/sound', deps) };
}
it('envía solo métricas a 4 Hz y libera la captura y sesión al detenerse', async () => {
  vi.useFakeTimers(); const b = banco();
  await b.control.activar();
  expect(b.control.leer().fase).toBe('activo');
  expect(b.pedidos[1]?.cuerpo).toEqual({ secuencia: 1, dbfs: expect.closeTo(-20, 4), referencia: { dbfs: -20, nivel: 80 } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(b.pedidos.filter(p => p.metodo === 'PUT')).toHaveLength(5);
  await b.control.detener();
  expect(b.cerrar).toHaveBeenCalledOnce();
  expect(b.pedidos.at(-1)?.metodo).toBe('DELETE');
  expect(vi.getTimerCount()).toBe(0);
});
it('una captura concedida después de cancelar se cierra sin abrir sesión', async () => {
  const b = banco(); let conceder: (c: CapturaMicrofono) => void = () => {};
  b.deps.abrir = () => new Promise(resolve => { conceder = resolve; });
  const control = new ControladorMicrofono('/sound', b.deps);
  const inicio = control.activar();
  await vi.waitFor(() => expect(conceder.toString()).not.toContain('() => {}'));
  await control.detener(); conceder(b.captura); await inicio;
  expect(b.cerrar).toHaveBeenCalledOnce(); expect(b.pedidos).toEqual([]);
});
it('permiso denegado conserva entrada manual y un fallo de transporte libera el micrófono', async () => {
  const b = banco(); b.deps.abrir = async () => { throw new DOMException('denegado', 'NotAllowedError'); };
  const denegado = new ControladorMicrofono('/sound', b.deps); await denegado.activar();
  expect(denegado.leer()).toMatchObject({ fase: 'inactivo', error: expect.stringContaining('denegado') });
  const fallo = banco(); fallo.deps.fetch = async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { id: 'sesion' } : { message: 'falló' }), { status: init?.method === 'PUT' ? 500 : 200 });
  const control = new ControladorMicrofono('/sound', fallo.deps); await control.activar();
  expect(control.leer()).toMatchObject({ fase: 'inactivo', error: 'falló' });
  expect(fallo.cerrar).toHaveBeenCalledOnce();
});
it('no acumula solicitudes cuando el servidor tarda; conserva la última ventana', async () => {
  vi.useFakeTimers(); const b = banco(); let completar: (r: Response) => void = () => {};
  const normal = b.deps.fetch;
  b.deps.fetch = (url, init) => init?.method === 'PUT' ? new Promise(resolve => { completar = resolve; }) : normal(url, init);
  const control = new ControladorMicrofono('/sound', b.deps); const inicio = control.activar();
  await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(1000);
  expect(b.pedidos.filter(p => p.metodo === 'POST')).toHaveLength(1);
  expect(b.pedidos).toHaveLength(1);
  completar(new Response('{}')); await inicio; await control.detener();
});
it('libera una sesión concedida tarde sin reactivar la captura cancelada', async () => {
  const b = banco(); let conceder: (r: Response) => void = () => {};
  const normal = b.deps.fetch;
  b.deps.fetch = (url, init) => init?.method === 'POST' ? new Promise(resolve => { conceder = resolve; }) : normal(url, init);
  const control = new ControladorMicrofono('/sound', b.deps); const inicio = control.activar();
  await vi.waitFor(() => expect(b.deps.abrir).toHaveBeenCalled());
  await control.detener(); conceder(new Response('{"id":"tardia"}')); await inicio;
  expect(b.cerrar).toHaveBeenCalledOnce(); expect(b.pedidos.at(-1)?.metodo).toBe('DELETE');
  expect(control.leer().fase).toBe('inactivo');
});
it('el fin de la pista detiene la captura y permite elegir otro dispositivo', async () => {
  const b = banco(); let fin: (m: string) => void = () => {};
  b.deps.abrir = async (_id, terminar) => { fin = terminar; return b.captura; };
  const control = new ControladorMicrofono('/sound', b.deps); await control.activar('dispositivo-1');
  fin('pista desconectada');
  await vi.waitFor(() => expect(control.leer().fase).toBe('inactivo'));
  await control.activar('dispositivo-2'); expect(control.leer().fase).toBe('activo');
  await control.detener(); expect(b.cerrar).toHaveBeenCalledTimes(2);
});
