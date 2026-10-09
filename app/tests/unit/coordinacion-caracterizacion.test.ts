import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColaCorridas } from '../../server/src/colaCorridas.js';
import { GuardadoDiagrama } from '../../web/guardado-diagrama.js';
import { colaOriginal, guardadoOriginal } from './fixtures/coordinacion-original.js';

function original<T>(fuente: string, entorno: object, salida: string): T {
  return runInNewContext(ts.transpileModule(`${fuente}\n${salida}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, entorno) as T;
}
const diferida = () => { let resolver: () => void = () => { throw new Error("Promesa no inicializada"); }; const promesa = new Promise<void>(r => { resolver = r; }); return { promesa, resolver }; };

function colaVieja() {
  const tareas = new Map<string, () => Promise<unknown>>();
  const entorno = { tareas, ejecutarProyecto: (p: { name: string }) => {
    const tarea = tareas.get(p.name);
    if (!tarea) throw new Error('Tarea ausente');
    return tarea();
  } };
  return original<{ ejecutar<T>(nombre: string, tarea: () => Promise<T>): Promise<T>; readonly enCurso: string | null; esperar(): Promise<unknown> }>(
    `let runGeneration = 0; let runQueue = Promise.resolve(); let executingProject = null; ${colaOriginal}`,
    entorno, `({ ejecutar(nombre, tarea) { tareas.set(nombre, tarea); return runProject({name:nombre}, false); }, get enCurso() { return executingProject; }, esperar() { return runQueue.catch(() => {}); } })`);
}

function guardadoViejo(d: { proyecto: () => string | null; contenido: () => string; enviar: (p: string, c: string) => Promise<unknown>; alGuardar: () => Promise<void>; alError: (e: unknown) => void; alSalir: (p: string, c: string) => void }) {
  const state = { get proyecto() { const name = d.proyecto(); return name ? { name } : null; }, get diagrama() { return JSON.parse(d.contenido()); }, timerDiagrama: null as ReturnType<typeof setTimeout> | null };
  return original<{ programar(): void; esperarCamara(p: string): Promise<void>; esperarPendiente(): Promise<unknown>; descartar(): void; alSalir(): void; readonly revision: number; readonly pendiente: boolean }>(guardadoOriginal, {
    state, setTimeout, clearTimeout, notificar: () => {}, topologiaObservada: 'igual', firmaDiagramaElectrico: () => 'igual',
    invalidarObservacionFisica: () => {}, lienzo: {}, CLIENTE: 'fixture',
    api: (url: string, opts: { body: string }) => d.enviar(decodeURIComponent(url.split('/')[3] ?? ''), opts.body),
    fetch: (url: string, opts: { body: string }) => { d.alSalir(url.split('/')[3] ?? '', opts.body); return Promise.resolve(); },
    refrescarAvisos: d.alGuardar, nota: d.alError,
  }, `({ programar: guardarDiagrama, esperarCamara: esperarDiagramaCamara, esperarPendiente() { if (state.timerDiagrama && state.proyecto) { clearTimeout(state.timerDiagrama); state.timerDiagrama=null; void enviarDiagrama(state.proyecto.name, JSON.stringify(state.diagrama)); } return guardadoDiagrama; }, descartar() { clearTimeout(state.timerDiagrama); state.timerDiagrama=null; }, alSalir: guardarDiagramaYa, get revision() { return revisionDiagrama; }, get pendiente() { return Boolean(state.timerDiagrama); } })`);
}

afterEach(() => vi.useRealTimers());

describe.each(['original', 'extraída'] as const)('caracterización de la cola de corridas: %s', version => {
  it('serializa, libera el proyecto tras un fallo y no pierde el siguiente resultado', async () => {
    const cola = version === 'original' ? colaVieja() : new ColaCorridas(), pausa = diferida();
    const eventos: string[] = [];
    const uno = cola.ejecutar('uno', async () => { eventos.push('uno'); await pausa.promesa; throw new Error('fallo'); });
    await Promise.resolve(); await Promise.resolve();
    expect(cola.enCurso).toBe('uno');
    const dos = cola.ejecutar('dos', async () => { eventos.push('dos'); return 7; });
    expect(eventos).toEqual(['uno']);
    pausa.resolver();
    await expect(uno).rejects.toThrow('fallo');
    expect(await dos).toBe(7);
    await cola.esperar();
    expect(cola.enCurso).toBeNull();
    expect(eventos).toEqual(['uno', 'dos']);
  });
});

describe.each(['original', 'extraído'] as const)('caracterización del guardado de diagrama: %s', version => {
  function arnes() {
    let proyecto: string | null = 'uno', contenido = '{"valor":1}';
    const enviar = vi.fn(async (_p: string, _c: string) => undefined), alGuardar = vi.fn(async () => {}), alError = vi.fn(), alSalir = vi.fn();
    const puertos = { proyecto: () => proyecto, contenido: () => contenido, enviar, alGuardar, alError, alSalir };
    const g = version === 'original' ? guardadoViejo(puertos) : new GuardadoDiagrama({ ...puertos, notificar: () => {}, enviarAlSalir: alSalir });
    return { g, enviar, alGuardar, alError, alSalir, proyecto(p: string | null) { proyecto = p; }, contenido(c: string) { contenido = c; } };
  }
  it('agrupa cambios a 300 ms, captura proyecto/contenido y no refresca otro proyecto', async () => {
    vi.useFakeTimers(); const a = arnes();
    a.g.programar(); a.contenido('{"valor":2}'); a.g.programar(); a.proyecto('dos');
    await vi.advanceTimersByTimeAsync(299); expect(a.enviar).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(a.enviar).toHaveBeenCalledTimes(1); expect(a.enviar).toHaveBeenCalledWith('uno', '{"valor":2}');
    expect(a.alGuardar).not.toHaveBeenCalled(); expect(a.g.revision).toBe(2);
  });
  it('una cámara espera también las ediciones que llegan mientras se guarda', async () => {
    vi.useFakeTimers(); const a = arnes(), pausa = diferida();
    a.enviar.mockImplementationOnce(async () => { await pausa.promesa; });
    a.g.programar(); const esperando = a.g.esperarCamara('uno'); await Promise.resolve(); await Promise.resolve();
    a.contenido('{"valor":3}'); a.g.programar(); pausa.resolver(); await esperando;
    expect(a.enviar.mock.calls.map(c => c[1])).toEqual(['{"valor":1}', '{"valor":3}']); expect(a.g.pendiente).toBe(false);
  });
  it('un error de guardado se propaga a la barrera y el siguiente envío recupera la cola', async () => {
    vi.useFakeTimers(); const a = arnes(); a.enviar.mockRejectedValueOnce(new Error('sin red'));
    a.g.programar(); await expect(a.g.esperarPendiente()).rejects.toThrow('sin red');
    a.g.programar(); await expect(a.g.esperarPendiente()).resolves.toBeUndefined();
    expect(a.enviar).toHaveBeenCalledTimes(2);
  });
  it('descarta el debounce externo y conserva el envío keepalive directo al salir', async () => {
    vi.useFakeTimers(); const a = arnes(); a.g.programar(); a.g.descartar(); await vi.advanceTimersByTimeAsync(300);
    expect(a.enviar).not.toHaveBeenCalled(); a.g.programar(); a.g.alSalir();
    expect(a.alSalir).toHaveBeenCalledTimes(1); expect(a.alSalir).toHaveBeenCalledWith('uno', '{"valor":1}'); expect(a.g.pendiente).toBe(false);
  });
  it('rechaza una espera de cámara cuando cambia el proyecto durante el envío', async () => {
    vi.useFakeTimers(); const a = arnes(), pausa = diferida(); a.enviar.mockImplementationOnce(async () => { await pausa.promesa; });
    a.g.programar(); const esperando = a.g.esperarCamara('uno'); a.proyecto('dos'); pausa.resolver();
    await expect(esperando).rejects.toThrow('El proyecto cambió.');
  });
});
