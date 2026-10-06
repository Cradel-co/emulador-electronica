import { describe, expect, it, vi } from 'vitest';
import { pararPlacasSinEnergia, type MotorDetenible } from './pararPlacasSinEnergia.js';

function motor(running = true) {
  return { getStatus: () => ({ running }), stop: vi.fn(async () => undefined) };
}

describe('parar sólo placas sin energía', () => {
  it('no aplica un diagnóstico viejo a una corrida iniciada mientras esperaba otra parada', async () => {
    let vigente = true;
    const primero = { getStatus: () => ({ running: true }), stop: async () => { vigente = false; } };
    const segundo = motor();
    const resultado = await pararPlacasSinEnergia([{ id: 'a', motivo: 'Sin VCC' }, { id: 'b', motivo: 'Sin VCC' }],
      new Map<string, MotorDetenible>([['a', primero], ['b', segundo]]), () => vigente);
    expect(resultado).toEqual(['a']);
    expect(segundo.stop).not.toHaveBeenCalled();
  });

  it('detiene la placa con brownout y deja corriendo la otra independiente', async () => {
    const mala = motor(), sana = motor();
    const paradas = await pararPlacasSinEnergia([
      { id: 'a', motivo: 'Brownout' }, { id: 'b', motivo: null },
    ], new Map([['a', mala], ['b', sana]]));
    expect(paradas).toEqual(['a']);
    expect(mala.stop).toHaveBeenCalledTimes(1);
    expect(sana.stop).not.toHaveBeenCalled();
  });

  it('ignora placas ya detenidas, motores ausentes y entradas repetidas', async () => {
    const detenida = motor(false), activa = motor();
    expect(await pararPlacasSinEnergia([
      { id: 'a', motivo: 'Sin VCC' }, { id: 'ausente', motivo: 'Sin VCC' },
      { id: 'b', motivo: 'Sin VCC' }, { id: 'b', motivo: 'Sin VCC' },
    ], new Map([['a', detenida], ['b', activa]]))).toEqual(['b']);
    expect(detenida.stop).not.toHaveBeenCalled();
    expect(activa.stop).toHaveBeenCalledTimes(1);
  });

  it('espera cada parada y propaga errores sin declarar éxitos falsos', async () => {
    const orden: string[] = [];
    const primero = { getStatus: () => ({ running: true }), stop: async () => { orden.push('a'); throw new Error('no pudo detenerse'); } };
    const segundo = motor();
    await expect(pararPlacasSinEnergia([{ id: 'a', motivo: 'Sin VCC' }, { id: 'b', motivo: 'Sin VCC' }],
      new Map<string, MotorDetenible>([['a', primero], ['b', segundo]]))).rejects.toThrow('no pudo detenerse');
    expect(orden).toEqual(['a']);
    expect(segundo.stop).not.toHaveBeenCalled();
  });
});
