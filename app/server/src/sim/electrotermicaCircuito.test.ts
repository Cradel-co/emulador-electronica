import { beforeAll, expect, it } from 'vitest';
import { Netlist } from './netlist.js';
import { analizarElectrotermicaNetlist } from './electrotermicaCircuito.js';
import { precalentar } from './spice.js';
import type { ModeloResistenciaElectrotermica } from './electrotermica.js';

beforeAll(precalentar, 60_000);
const modelo: ModeloResistenciaElectrotermica = {
  resistenciaReferenciaOhm: 100, temperaturaReferenciaC: 25, coeficientePorK: 0.02,
  dominioElectrico: { tensionMaxAbsV: 20, corrienteMaxAbsA: 1, potenciaMaxW: 5 },
  termica: { id: 'test', fuente: 'Modelo sintético de test', condiciones: 'Cuerpo único; ambiente fijo',
    resistenciaKPorW: 10, capacidadJPorK: 0.1, ambienteC: 25, inicialC: 25, rangoDeclaradoC: [0, 100] },
};
const parametros = { duracionS: 0.1, pasoInicialS: 0.1, pasoMinimoS: 1e-4, pasoMaximoS: 0.1, toleranciaC: 0.01 };
const red = (): Netlist => {
  const n = new Netlist('realimentación electrotérmica');
  n.agregar('m', { tipo: 'V', nombre: 'f', a: 'a', b: '0', voltios: 10 });
  n.agregar('m', { tipo: 'R', nombre: 'r', a: 'a', b: '0', ohms: 100 });
  return n;
};

it('ngspice vuelve a resolver la carga con R(T), corriente y potencia reducidas al calentarse', async () => {
  const n = red();
  const r = await analizarElectrotermicaNetlist(n, { 'm.r': modelo }, parametros);
  const s = r.elementos['m.r'];
  if (!s) throw new Error('Falta resistencia');
  expect(s.temperaturaC.at(-1)).toBeGreaterThan(25.9);
  expect(s.resistenciaOhm.at(-1)).toBeGreaterThan(101.8);
  expect(s.i.at(-1)).toBeLessThan(s.i[0] ?? NaN);
  expect(s.p.at(-1)).toBeLessThan(s.p[0] ?? NaN);
  expect(r.estadisticas.evaluacionesElectricas).toBeLessThanOrEqual(12);
  expect(Math.abs(s.residuoEnergiaJ)).toBeLessThan(1e-12);
});

it('actualizar R preserva nombres/topología, valida valor y no acepta otro tipo', () => {
  const n = red(), antes = n.texto();
  n.actualizarResistencia('m.r', 200);
  expect(n.texto()).toBe(antes.replace('r_m_r_2 a 0 100', 'r_m_r_2 a 0 200'));
  expect(n.elementos.find(e => e.id === 'm.r')?.ohms).toBe(200);
  expect(() => n.actualizarResistencia('m.r', -1)).toThrow();
  expect(() => n.actualizarResistencia('m.f', 200)).toThrow();
});

it('mantiene la cabecera SPICE en ASCII para el lector binario del adaptador', () => {
  const n = new Netlist('Análisis térmico 🔥\nsegunda línea');
  expect(n.texto().split('\n')[0]).toMatch(/^[\x20-\x7E]+$/);
});

it('rechaza C/L, IDs inventados y nominales contradictorios antes de simular', async () => {
  const n = red();
  await expect(analizarElectrotermicaNetlist(n, { 'inexistente.r': modelo }, parametros)).rejects.toThrow(/requiere/);
  await expect(analizarElectrotermicaNetlist(n, { 'm.r': { ...modelo, resistenciaReferenciaOhm: 200 } }, parametros)).rejects.toThrow(/Rref/);
  n.agregar('m', { tipo: 'C', nombre: 'c', a: 'a', b: '0', faradios: 1e-6 });
  await expect(analizarElectrotermicaNetlist(n, { 'm.r': modelo }, parametros)).rejects.toThrow(/C\/L/);
});
