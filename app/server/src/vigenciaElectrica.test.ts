import { describe, expect, it } from 'vitest';
import { VigenciaElectrica } from './vigenciaElectrica.js';
import { pararPlacasSinEnergia } from './pararPlacasSinEnergia.js';

function diferida<T>() {
  let resolver: (valor: T) => void = () => undefined;
  const promesa = new Promise<T>(r => { resolver = r; });
  return { promesa, resolver };
}

describe('vigencia de soluciones eléctricas durante una recarga', () => {
  it('un resultado anterior no sobrescribe ADC/cámara ni corta energía después del relanzamiento', async () => {
    const vigencia = new VigenciaElectrica();
    const solver = diferida<number>();
    const runtime = { adc: 512, camara: 'actual', alimentado: true };
    const consulta = vigencia.consultar(() => solver.promesa, adc => {
      runtime.adc = adc; runtime.camara = 'obsoleta'; runtime.alimentado = false;
    });
    await vigencia.cambiar(async () => { runtime.adc = 256; });
    solver.resolver(0);
    await consulta;
    expect(runtime).toEqual({ adc: 256, camara: 'actual', alimentado: true });
  });

  it('una consulta iniciada durante stop/start tampoco gana a la instantánea inicial', async () => {
    const vigencia = new VigenciaElectrica();
    const arranque = diferida<void>(), solver = diferida<number>();
    const efectos: number[] = [];
    const cambio = vigencia.cambiar(() => arranque.promesa);
    const consulta = vigencia.consultar(() => solver.promesa, adc => { efectos.push(adc); });
    arranque.resolver(); await cambio;
    solver.resolver(123); await consulta;
    await vigencia.consultar(async () => 456, adc => { efectos.push(adc); });
    expect(efectos).toEqual([456]);
  });

  it('mantiene el guard original en efectos posteriores a un await', async () => {
    const vigencia = new VigenciaElectrica();
    const pausa = diferida<void>(), aplicadaPrimeraFase = diferida<void>();
    const efectos: string[] = [];
    const consulta = vigencia.consultar(async () => 'viejo', async (dato, vigente) => {
      efectos.push(`adc:${dato}`); aplicadaPrimeraFase.resolver();
      await pausa.promesa;
      if (vigente()) efectos.push(`camara:${dato}`);
    });
    await aplicadaPrimeraFase.promesa;
    await vigencia.cambiar(async () => { efectos.push('reset'); });
    pausa.resolver(); await consulta;
    expect(efectos).toEqual(['adc:viejo', 'reset']);
  });

  it('un brownout viejo no detiene la segunda placa si hubo recarga al esperar la primera', async () => {
    const vigencia = new VigenciaElectrica();
    const primeraDetenida = diferida<void>(), terminarParada = diferida<void>();
    const detenidas: string[] = [];
    const motores = new Map([
      ['uno', { getStatus: () => ({ running: true }), stop: async () => { detenidas.push('uno'); primeraDetenida.resolver(); await terminarParada.promesa; } }],
      ['dos', { getStatus: () => ({ running: true }), stop: async () => { detenidas.push('dos'); } }],
    ]);
    const consulta = vigencia.consultar(async () => ['uno', 'dos'].map(id => ({ id, motivo: 'brownout' })), async (r, vigente) => {
      await pararPlacasSinEnergia(r, motores, vigente);
    });
    await primeraDetenida.promesa;
    await vigencia.cambiar(async () => undefined);
    terminarParada.resolver(); await consulta;
    expect(detenidas).toEqual(['uno']);
  });

  it('con cambios superpuestos sólo admite consultas después del último cambio', async () => {
    const vigencia = new VigenciaElectrica();
    const a = diferida<void>(), b = diferida<void>();
    const efectos: number[] = [];
    const ca = vigencia.cambiar(() => a.promesa), cb = vigencia.cambiar(() => b.promesa);
    a.resolver(); await ca;
    await vigencia.consultar(async () => 1, n => { efectos.push(n); });
    b.resolver(); await cb;
    await vigencia.consultar(async () => 2, n => { efectos.push(n); });
    expect(efectos).toEqual([2]);
  });

  it('libera el bloqueo tras un fallo y conserva la cancelación externa de la corrida', async () => {
    const vigencia = new VigenciaElectrica();
    const efectos: number[] = [];
    await expect(vigencia.cambiar(async () => { throw new Error('falló arranque'); })).rejects.toThrow('falló arranque');
    await vigencia.consultar(async () => 1, n => { efectos.push(n); });
    const solver = diferida<number>();
    let corridaActual = true;
    const consulta = vigencia.consultar(() => solver.promesa, n => { efectos.push(n); }, () => corridaActual);
    corridaActual = false; solver.resolver(2); await consulta;
    expect(efectos).toEqual([1]);
  });
});
