import { it, expect, vi } from 'vitest';
import { ControladorCamara } from '../../web/camera.js';
import { crearControladorCamara } from '../../web/camera.js';
import type { CameraSession } from '../../shared/src/camera.js';
const fake = () => {
  const stop = vi.fn();
  const track = { stop, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream, stop };
};
it('detiene un stream cuando el permiso se resuelve después de cancelar', async () => {
  let resolver!: (s: MediaStream) => void;
  const f = fake(), fetcher = vi.fn();
  const c = new ControladorCamara('/camera', { media: { getUserMedia: () => new Promise(r => { resolver = r; }), enumerateDevices: async () => [] }, fetch: fetcher });
  const inicio = c.activar(); await c.detener(); resolver(f.stream); await inicio;
  expect(f.stop).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
});
it('libera el stream si el backend rechaza la sesión', async () => {
  const f = fake();
  const c = new ControladorCamara('/camera', { media: { getUserMedia: async () => f.stream, enumerateDevices: async () => [] }, fetch: async () => new Response(JSON.stringify({ message: 'Ocupada' }), { status: 409 }) });
  await c.activar(); expect(f.stop).toHaveBeenCalledOnce(); expect(c.snapshot.error).toBe('Ocupada');
});
it('cierra una sesión creada después de cancelar la activación', async () => {
  const f = fake(); let resolver!: (r: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(r => { resolver = r; })).mockResolvedValue(new Response('{}'));
  const c = new ControladorCamara('/camera', { media: { getUserMedia: async () => f.stream, enumerateDevices: async () => [] }, fetch: fetcher });
  const inicio = c.activar(); await Promise.resolve(); await c.detener();
  resolver(new Response(JSON.stringify({ id: 's', expiresAt: Date.now() + 45000 } satisfies CameraSession)));
  await inicio;
  expect(fetcher).toHaveBeenLastCalledWith('/camera/session/s', expect.objectContaining({ method: 'DELETE' }));
  expect(f.stop).toHaveBeenCalled(); expect(c.snapshot.phase).toBe('inactive');
});
it('muestra permisos denegados sin abrir sesión', async () => {
  const c = new ControladorCamara('/camera', { media: { getUserMedia: async () => { throw new Error('Permiso denegado'); }, enumerateDevices: async () => [] }, fetch: vi.fn() });
  await c.activar(); expect(c.snapshot.error).toContain('Permiso denegado');
});

it('reanuda la cámara automáticamente cuando el navegador ya guardó el permiso', async () => {
  const f = fake(), pedir = vi.fn().mockResolvedValue({ state: 'granted' });
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 's', expiresAt: Date.now() + 45000 })));
  const media = { getUserMedia: vi.fn(async () => f.stream), enumerateDevices: async () => [] };
  const c = new ControladorCamara('/camera', { media, permissions: { query: pedir }, fetch: fetcher });
  await c.reanudarSiAutorizada();
  expect(pedir).toHaveBeenCalledWith({ name: 'camera' });
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(c.snapshot.phase).toBe('active');
  await c.destruir();
});

it('reutiliza una sesión de cámara al desmontar y volver a montar el panel', () => {
  const primera = crearControladorCamara('persistencia-test', 'camera', '/camera', {
    media: { getUserMedia: async () => fake().stream, enumerateDevices: async () => [] }, fetch: vi.fn(),
  });
  const segunda = crearControladorCamara('persistencia-test', 'camera', '/camera');
  expect(segunda).toBe(primera);
  primera.destruir();
});

it('respeta Detener y no reanuda automáticamente hasta que el usuario la active de nuevo', async () => {
  const f = fake(), media = { getUserMedia: vi.fn(async () => f.stream), enumerateDevices: async () => [] };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 's', expiresAt: Date.now() + 45000 })));
  const c = new ControladorCamara('/camera', { media, permissions: { query: async () => ({ state: 'granted' }) as PermissionStatus }, fetch: fetcher });
  await c.activar();
  await c.detener(true);
  await c.reanudarSiAutorizada();
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  c.destruir();
});

it('fallo de heartbeat detiene pistas y no reactiva la cámara', async () => {
  vi.useFakeTimers();
  try {
    const f = fake();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 's', expiresAt: 45000 }))).mockRejectedValueOnce(new Error('Sin red')).mockResolvedValue(new Response('{}'));
    const c = new ControladorCamara('/camera', { media: { getUserMedia: async () => f.stream, enumerateDevices: async () => [] }, fetch: fetcher });
    await c.activar();
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.stop).toHaveBeenCalledOnce(); expect(c.snapshot.phase).toBe('inactive'); expect(c.snapshot.error).toBe('Sin red');
    c.destruir();
  } finally { vi.useRealTimers(); }
});

it('solo el propietario responde a la solicitud, y notifica si la vista previa no está lista', async () => {
  const f = fake();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({id:'s',expiresAt:45000}))).mockImplementation(async () => new Response('{}'));
  const c = new ControladorCamara('/camera', {media:{getUserMedia:async()=>f.stream,enumerateDevices:async()=>[]},fetch:fetcher},undefined,'p','a');
  await c.activar();
  await c.solicitud('otro','a','req'); expect(fetcher).toHaveBeenCalledTimes(1);
  await c.solicitud('p','a','req');
  expect(fetcher).toHaveBeenLastCalledWith('/camera/session/s/requests/req/error',expect.objectContaining({method:'POST'}));
  expect(c.snapshot.error).toContain('firmware');
  c.errorFirmware('p','a','La captura venció.'); expect(c.snapshot.error).toBe('La captura venció.');
  c.destruir();
});
