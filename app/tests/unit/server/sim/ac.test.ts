import { beforeAll, expect, it } from 'vitest';
import { Netlist } from '../../../../server/src/sim/netlist.js';
import { precalentar } from '../../../../server/src/sim/spice.js';
import { transferenciaAc, correrAc } from '../../../../server/src/sim/ac.js';
import { extraerAcSpice } from '../../../../server/src/sim/validacionAc.js';
import { ParametrosAcSchema } from '@emu/shared';
beforeAll(precalentar, 60_000);
const parametros = { fuente: 'm.fuente', entrada: 'in', salida: 'out', inicioHz: 10, finHz: 10000, puntosPorDecada: 10 };
it('RC real: transferencia compleja y corte sin alterar DC', async () => {
  const n = new Netlist('RC AC');
  n.agregar('m', { tipo: 'V', nombre: 'fuente', a: 'in', b: '0', voltios: 5 });
  n.agregar('m', { tipo: 'R', nombre: 'r', a: 'in', b: 'out', ohms: 1000 });
  n.agregar('m', { tipo: 'C', nombre: 'c', a: 'out', b: '0', faradios: 1e-6 });
  const op = n.texto(); const fc = 1 / (2 * Math.PI * 0.001);
  const r = await correrAc(n, { ...parametros, inicioHz: fc / 10, finHz: fc * 10 }, 'in', 'out');
  expect(n.texto()).toBe(op); expect(r.frecuenciaHz).toHaveLength(21);
  for (const [k, f] of r.frecuenciaHz.entries()) {
    const wrc = 2 * Math.PI * f * 0.001;
    expect(r.gananciaDb[k]).toBeCloseTo(-10 * Math.log10(1 + wrc ** 2), 6);
    expect(r.faseGrados[k]).toBeCloseTo(-Math.atan(wrc) * 180 / Math.PI, 6);
    expect(r.transferencia[k]?.real).toBeCloseTo(1 / (1 + wrc ** 2), 7);
    expect(r.transferencia[k]?.imaginaria).toBeCloseTo(-wrc / (1 + wrc ** 2), 7);
  }
  expect(r.gananciaDb[10]).toBeCloseTo(-3.0103, 4); expect(r.faseGrados[10]).toBeCloseTo(-45, 6);
});
it('rechaza frecuencias y presupuesto inválidos', () => {
  for (const cambios of [{ inicioHz: 0 }, { finHz: 1 }, { puntosPorDecada: 0.5 }, { inicioHz: 1e-200, finHz: 1e200, puntosPorDecada: 1000 }]) expect(ParametrosAcSchema.safeParse({ ...parametros, ...cambios }).success).toBe(false);
});
it('no acepta raw incompleto ni valores complejos no finitos', () => {
  const raw = { dataType: 'complex', data: [{ name: 'frequency', values: [{ real: 10, img: 0 }, { real: 100, img: 0 }] }, { name: 'v(out)', values: [{ real: 1, img: 0 }, { real: 0, img: NaN }] }] };
  expect(() => extraerAcSpice(raw, [], '', [10, 100])).toThrow(/finito/);
  expect(() => extraerAcSpice({ ...raw, data: [raw.data[0]] }, [], '', [10, 1000])).toThrow(/incompleto/);
});

it('RL real: respuesta en frecuencia y fuente limitada conservan la normalización real', async () => {
  const n = new Netlist('RL AC');
  n.agregar('m', { tipo: 'V', nombre: 'fuente', a: 'in', b: '0', voltios: 5, limiteA: 1 });
  n.agregar('m', { tipo: 'R', nombre: 'r', a: 'in', b: 'out', ohms: 100 });
  n.agregar('m', { tipo: 'L', nombre: 'l', a: 'out', b: '0', henrios: 0.01 });
  const r = await correrAc(n, parametros, 'in', 'out');
  for (const [k, f] of r.frecuenciaHz.entries()) {
    const x = 2 * Math.PI * f * 0.01 / 100;
    expect(r.gananciaDb[k]).toBeCloseTo(20 * Math.log10(x / Math.hypot(1, x)), 6);
    expect(r.faseGrados[k]).toBeCloseTo(90 - Math.atan(x) * 180 / Math.PI, 6);
  }
});
it('cero de transferencia deja hueco y una entrada nula falla', () => {
  const uno = { real: 1, imaginaria: 0 }, cero = { real: 0, imaginaria: 0 };
  expect(transferenciaAc([uno, uno], [cero, cero])).toEqual({ transferencia: [cero, cero], gananciaDb: [null, null], faseGrados: [null, null] });
  expect(() => transferenciaAc([cero, uno], [uno, uno])).toThrow(/Entrada AC/);
});
it('barrido con fin fuera de grilla conserva las frecuencias efectivas de ngspice', async () => {
  const n = new Netlist('divisor AC');
  n.agregar('m', { tipo: 'V', nombre: 'fuente', a: 'in', b: '0', voltios: 5 });
  n.agregar('m', { tipo: 'R', nombre: 'r', a: 'in', b: 'out', ohms: 1000 });
  n.agregar('m', { tipo: 'R', nombre: 'r2', a: 'out', b: '0', ohms: 1000 });
  const r = await correrAc(n, { ...parametros, finHz: 153 }, 'in', 'out');
  expect(r.frecuenciaHz).toHaveLength(12); expect(r.frecuenciaHz.at(-1)).toBeCloseTo(153, 8);
  for (const g of r.gananciaDb) expect(g).toBeCloseTo(20 * Math.log10(0.5), 6);
});
