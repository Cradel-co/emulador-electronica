import { expect, it } from 'vitest';
import { verificarConservacionDc } from './conservacion.js';
import type { ElementoResuelto } from './netlist.js';
const red: ElementoResuelto[] = [
  { id: 'f', local: 'f', dueno: 'f', tipo: 'V', a: 'n1', b: '0', va: 5, vb: 0, i: -0.001, p: -0.005 },
  { id: 'r', local: 'r', dueno: 'r', tipo: 'R', a: 'n1', b: '0', va: 5, vb: 0, i: 0.001, p: 0.005, ohms: 5000 },
];
it('acepta un circuito balanceado por KCL y potencia', () => {
  expect(() => verificarConservacionDc(red)).not.toThrow();
});
it('rechaza una carga omitida aun con todos los vectores finitos', () => {
  expect(() => verificarConservacionDc([red[0]!])).toThrow(/Kirchhoff/);
});
it('rechaza potencia con signo incorrecto aunque KCL cierre', () => {
  expect(() => verificarConservacionDc([red[0]!, { ...red[1]!, p: -0.005 }])).toThrow(/potencia/);
});
it('rechaza dato no finito', () => {
  expect(() => verificarConservacionDc([{ ...red[0]!, i: NaN }, red[1]!])).toThrow(/finito/);
});
