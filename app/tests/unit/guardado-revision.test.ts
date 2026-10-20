import { afterEach, expect, it, vi } from 'vitest';
import { GuardadoDiagrama } from '../../web/guardado-diagrama.js';
function pausa() { let liberar: () => void = () => {}; const promesa = new Promise<void>(r => { liberar = r; }); return { promesa, liberar }; }
function arnes() {
  let proyecto = 'uno';
  const enviar = vi.fn(async () => {});
  const g = new GuardadoDiagrama({ proyecto: () => proyecto, contenido: () => '{}', enviar, enviarAlSalir: () => {}, notificar: () => {}, alGuardar: async () => {}, alError: () => {} });
  return { g, enviar, proyecto(nombre: string) { proyecto = nombre; } };
}
afterEach(() => vi.useRealTimers());
it('un envío anterior no declara guardadas las ediciones hechas durante la espera', async () => {
  vi.useFakeTimers(); const a = arnes(), b = pausa();
  a.enviar.mockImplementationOnce(async () => { await b.promesa; });
  a.g.programar(); const envio = a.g.esperarPendiente(); a.g.programar(); b.liberar(); await envio;
  expect(a.g.sucio).toBe(true); await a.g.esperarPendiente(); expect(a.g.sucio).toBe(false);
});
it('aceptar una carga libera una barrera que había fallado', async () => {
  vi.useFakeTimers(); const a = arnes(); a.enviar.mockRejectedValueOnce(new Error('conflicto'));
  a.g.programar(); await expect(a.g.esperarPendiente()).rejects.toThrow('conflicto');
  a.g.aceptarCarga(); await expect(a.g.esperarPendiente()).resolves.toBeUndefined(); expect(a.g.sucio).toBe(false);
});
it('un guardado de otro contexto no limpia el dibujo recién cargado y editado', async () => {
  vi.useFakeTimers(); const a = arnes(), b = pausa(); a.enviar.mockImplementationOnce(async () => { await b.promesa; });
  a.g.programar(); const anterior = a.g.esperarPendiente();
  a.proyecto('dos'); a.g.aceptarCarga(); a.g.programar(); b.liberar(); await anterior;
  expect(a.g.sucio).toBe(true); await a.g.esperarPendiente(); expect(a.g.sucio).toBe(false);
});
