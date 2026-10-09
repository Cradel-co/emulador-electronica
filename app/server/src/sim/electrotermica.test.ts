import { expect, it, vi } from 'vitest';
import { integrarElectrotermica, resistenciaATemperatura, type ModeloResistenciaElectrotermica, type ParametrosElectrotermicos, type ResolverElectrotermica } from './electrotermica.js';

const modelo: ModeloResistenciaElectrotermica = {
  resistenciaReferenciaOhm: 100, temperaturaReferenciaC: 25, coeficientePorK: 0.01,
  dominioElectrico: { tensionMaxAbsV: 100, corrienteMaxAbsA: 10, potenciaMaxW: 100 },
  termica: { id: 'sintetico', fuente: 'Oráculo matemático sintético, sin caracterización de pieza', condiciones: 'Cuerpo único y ambiente constante',
    resistenciaKPorW: 10, capacidadJPorK: 1, ambienteC: 25, inicialC: 25, rangoDeclaradoC: [0, 200] },
};
const parametros: ParametrosElectrotermicos = { duracionS: 1, pasoInicialS: 0.5, pasoMaximoS: 0.5, pasoMinimoS: 1e-5, toleranciaC: 0.001 };
const fuenteCorriente: ResolverElectrotermica = async resistencias => {
  const r = resistencias.get('r.r');
  if (r === undefined) throw new Error('Falta resistencia');
  return new Map([['r.r', { v: 0.1 * r, i: 0.1, p: 0.01 * r }]]);
};

it('R(T) usa coeficiente y referencia declarados, sin constantes universales', () => {
  expect(resistenciaATemperatura(modelo, 75)).toBe(150);
  expect(resistenciaATemperatura({ ...modelo, coeficientePorK: -0.001 }, 75)).toBe(95);
  expect(() => resistenciaATemperatura(modelo, 201)).toThrow(/dominio/);
  expect(() => resistenciaATemperatura({ ...modelo, coeficientePorK: -0.1 }, 75)).toThrow(/positiva/);
});

it('corriente constante: acopla P=I²R(T) y converge hacia la solución analítica al refinar', async () => {
  const solve = (h: number) => integrarElectrotermica({ 'r.r': modelo }, { ...parametros, pasoInicialS: h, pasoMaximoS: h, toleranciaC: 1 }, fuenteCorriente);
  const grueso = await solve(0.5), fino = await solve(0.25);
  const tasa = 0.01 - 0.1; // I²Rref alpha/C − 1/(Rth C)
  const exacta = 25 + Math.expm1(tasa) / tasa;
  const a = grueso.elementos['r.r'], b = fino.elementos['r.r'];
  if (!a || !b) throw new Error('Falta resultado');
  const errorA = Math.abs((a.temperaturaC.at(-1) ?? NaN) - exacta);
  const errorB = Math.abs((b.temperaturaC.at(-1) ?? NaN) - exacta);
  expect(errorB).toBeLessThan(errorA / 3);
  expect(b.resistenciaOhm.at(-1)).toBeGreaterThan(100);
  expect(b.p.at(-1)).toBeGreaterThan(1);
  expect(Math.abs(b.residuoEnergiaJ)).toBeLessThan(1e-11);
  expect(b.energiaDisipadaJ - b.energiaEvacuadaJ).toBeCloseTo(b.energiaAlmacenadaDeltaJ, 10);
  expect(fino.caracterizadoEnLaboratorio).toBe(false);
});

it('alpha cero recupera RC térmica; con tensión fija P cae cuando R(T) aumenta', async () => {
  const fuenteTension: ResolverElectrotermica = async rs => new Map([...rs].map(([id, r]) => [id, { v: 10, i: 10 / r, p: 100 / r }]));
  const fijo = await integrarElectrotermica({ 'r.r': { ...modelo, coeficientePorK: 0 } }, parametros, fuenteTension);
  const variable = await integrarElectrotermica({ 'r.r': modelo }, parametros, fuenteTension);
  expect(fijo.elementos['r.r']?.temperaturaC.at(-1)).toBeCloseTo(25 + 10 * (1 - Math.exp(-0.1)), 3);
  expect(variable.elementos['r.r']?.p.at(-1)).toBeLessThan(1);
  expect(variable.elementos['r.r']?.temperaturaC.at(-1)).toBeLessThan(fijo.elementos['r.r']?.temperaturaC.at(-1) ?? NaN);
});

it('rechaza dominio incompleto, paso absurdo y R(T) no positiva antes de resolver', async () => {
  const resolver = vi.fn(fuenteCorriente);
  const casos: Record<string, ModeloResistenciaElectrotermica>[] = [
    {}, { 'r.r': { ...modelo, termica: { ...modelo.termica, fuente: '' } } },
    { 'r.r': { ...modelo, coeficientePorK: -0.1 } },
  ];
  for (const modelos of casos) await expect(integrarElectrotermica(modelos, parametros, resolver)).rejects.toThrow();
  await expect(integrarElectrotermica({ 'r.r': modelo }, { ...parametros, pasoMaximoS: 1e-10 }, resolver)).rejects.toThrow();
  expect(resolver).not.toHaveBeenCalled();
});

it('rechaza datos ausentes, calor negativo y operación fuera del dominio eléctrico', async () => {
  for (const muestra of [undefined, { v: 10, i: 0.1, p: -1 }, { v: Infinity, i: 0.1, p: 1 }, { v: 101, i: 0.1, p: 1 }]) {
    const resolver: ResolverElectrotermica = async () => muestra ? new Map([['r.r', muestra]]) : new Map();
    await expect(integrarElectrotermica({ 'r.r': modelo }, parametros, resolver)).rejects.toThrow();
  }
});

it('aplica un plazo total aunque cada solución eléctrica individual sea válida', async () => {
  let ahora = 0;
  const resolver: ResolverElectrotermica = async r => { ahora += 25_000; return fuenteCorriente(r); };
  await expect(integrarElectrotermica({ 'r.r': modelo }, parametros, resolver, () => ahora)).rejects.toThrow(/plazo/);
});

it('vence el plazo total sin esperar una solución eléctrica que quedó pendiente', async () => {
  vi.useFakeTimers();
  try {
    const resolver = vi.fn<ResolverElectrotermica>(() => new Promise(() => {}));
    const resultado = integrarElectrotermica({ 'r.r': modelo }, parametros, resolver, () => Date.now());
    const rechazo = expect(resultado).rejects.toThrow(/plazo/);
    await vi.advanceTimersByTimeAsync(20_000);
    await rechazo;
    expect(resolver).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('aborta sin resultado parcial cuando no converge dentro del paso mínimo', async () => {
  await expect(integrarElectrotermica({ 'r.r': modelo }, { ...parametros, pasoMinimoS: 0.5, toleranciaC: 1e-12 }, fuenteCorriente)).rejects.toThrow(/convergencia|mínimo/);
});

it('acota las evaluaciones eléctricas agregadas de una solicitud', async () => {
  const resolver = vi.fn(fuenteCorriente);
  await expect(integrarElectrotermica({ 'r.r': modelo }, { ...parametros, duracionS: 1, pasoInicialS: 0.005, pasoMaximoS: 0.005 }, resolver)).rejects.toThrow(/evaluaciones/);
  expect(resolver.mock.calls.length).toBeLessThanOrEqual(256);
});
