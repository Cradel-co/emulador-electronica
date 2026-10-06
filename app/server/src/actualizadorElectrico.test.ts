import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearActualizadorElectrico } from './actualizadorElectrico.js';

afterEach(() => vi.useRealTimers());
describe('actualizaciones eléctricas sin acumulación', () => {
  it('coalesce 100 pedidos durante un solver bloqueado en un solo rerun con el proyecto más reciente', async () => {
    vi.useFakeTimers();
    let liberar: () => void = () => undefined;
    const bloqueo = new Promise<void>(r => { liberar = r; });
    const nombres: string[] = [];
    let activos = 0, maximos = 0;
    const a = crearActualizadorElectrico(async n => {
      nombres.push(n); activos++; maximos = Math.max(maximos, activos);
      if (nombres.length === 1) await bloqueo;
      activos--;
    });
    const primero = a.solicitar('inicial');
    await vi.advanceTimersByTimeAsync(50);
    const pendientes = Array.from({ length: 100 }, (_, i) => a.solicitar(`proyecto-${i}`));
    expect(new Set(pendientes).size).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(nombres).toEqual(['inicial']);
    liberar();
    await primero;
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(pendientes);
    expect(nombres).toEqual(['inicial', 'proyecto-99']);
    expect(maximos).toBe(1);
  });

  it('agrupa solicitudes antes del inicio y permite ajustar la demora', async () => {
    vi.useFakeTimers();
    const trabajo = vi.fn(async (_n: string) => undefined);
    const a = crearActualizadorElectrico(trabajo, 20);
    const p = a.solicitar('uno');
    expect(a.solicitar('dos')).toBe(p);
    await vi.advanceTimersByTimeAsync(19);
    expect(trabajo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(trabajo).toHaveBeenCalledTimes(1);
    expect(trabajo).toHaveBeenCalledWith('dos');
  });

  it('rechaza el grupo que falla y atiende el pendiente sin dejar el motor ocupado', async () => {
    vi.useFakeTimers();
    let fallar: (e: Error) => void = () => undefined;
    const bloqueo = new Promise<void>((_r, j) => { fallar = j; });
    const trabajo = vi.fn(async (n: string) => { if (n === 'malo') await bloqueo; });
    const a = crearActualizadorElectrico(trabajo);
    const primero = a.solicitar('malo');
    const resultado = primero.catch(e => e.message);
    await vi.advanceTimersByTimeAsync(50);
    const segundo = a.solicitar('bueno');
    fallar(new Error('falló solver'));
    expect(await resultado).toBe('falló solver');
    await vi.advanceTimersByTimeAsync(50);
    await segundo;
    expect(trabajo.mock.calls.map(c => c[0])).toEqual(['malo', 'bueno']);
  });
});
