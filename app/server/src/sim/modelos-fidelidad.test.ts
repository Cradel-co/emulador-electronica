import { expect, it } from 'vitest';
import { ModuleDefSchema } from '@emu/shared';
import { modeloDe } from './modelos.js';
it('cambiar el descriptor bajo el mismo tipo cambia el modelo por flags', () => {
  const a = ModuleDefSchema.parse({ type: 'led-cache-audit', name: 'LED', category: 'Test', svg: 'led.svg', diode: true, diodeVfDefault: 2, pins: [{ name: 'A', x: 0, y: 0, kind: 'other' }, { name: 'K', x: 0, y: 1, kind: 'ground' }] });
  const entrada = { pines: ['A', 'K'], props: {}, vars: {}, control: false, estado: {} };
  const primero = modeloDe(a).circuito(entrada);
  const segundo = modeloDe({ ...a, diodeVfDefault: 3 }).circuito(entrada);
  expect(segundo).not.toEqual(primero);
});
