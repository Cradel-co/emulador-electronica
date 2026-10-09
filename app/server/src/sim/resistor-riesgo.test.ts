import { beforeAll, expect, it } from 'vitest';
import { loadCatalog } from '../catalog.js';
import { modeloDe, type ModeloEjecutable } from './modelos.js';
let modelo: ModeloEjecutable;
beforeAll(async () => {
  const d = (await loadCatalog()).find(m => m.type === 'resistor');
  if (!d) throw new Error('Falta resistor del catálogo');
  modelo = modeloDe(d);
});
const observar = (potencia: number, powerRatedW = 0.25) => modelo.observar({
  props: { ohms: 100, powerRatedW }, vars: {}, estado: {}, control: false,
  v: { '1': 12, '2': 0 }, i: { r: 0.12 }, p: { r: potencia },
});
it('una sobrecarga indica riesgo y no afirma una avería ni tiempo de vida', () => {
  const avisos = observar(1.44).avisos ?? [];
  expect(avisos).toHaveLength(1);
  expect(avisos[0]?.mensaje).not.toMatch(/se quema/i);
  expect(avisos[0]?.mensaje).toMatch(/riesgo/i);
});
it('la potencia nominal configurada gobierna el aviso, no siempre 1/4 W', () => {
  expect(observar(1.44, 2).avisos ?? []).toHaveLength(0);
});
it.each(['100', false, NaN])('rechaza resistencia inválida sin coerción: %s', ohms => {
  expect(() => modelo.circuito({ pines: ['1', '2'], props: { ohms: ohms as number, powerRatedW: 0.25 }, vars: {}, estado: {}, control: false })).toThrow();
});
