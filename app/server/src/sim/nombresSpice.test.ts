import { describe, expect, it } from 'vitest';
import { NombresSpice } from './nombresSpice.js';
describe('nombres SPICE unívocos', () => {
  it('distingue puntuación y mayúsculas que SPICE o la sanitización confundirían', () => {
    const n = new NombresSpice('i');
    const nombres = ['x-y', 'x_y', 'X_y', 'x.y'].map(raw => n.de(raw));
    expect(new Set(nombres.map(x => x.toLowerCase())).size).toBe(4);
    expect(n.de('x-y')).toBe(nombres[0]);
  });
});
