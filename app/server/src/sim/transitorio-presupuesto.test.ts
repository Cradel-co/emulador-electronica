import { expect, it, vi } from 'vitest';
import { Netlist } from './netlist.js';
import { correrTransitorio } from './transitorio.js';
import { correrSpiceTransitorio } from './spice.js';

vi.mock('./spice.js', () => ({ correrSpiceTransitorio: vi.fn() }));

it('rechaza expansión de muestras adaptativas antes de asignar las series derivadas', async () => {
  const n = new Netlist('presupuesto adaptativo');
  for (let k = 0; k < 256; k++) n.agregar('m', { tipo: 'R', nombre: `r${k}`, a: `a${k}`, b: '0', ohms: 1000 });
  const t = Array.from({ length: 1000 }, (_, k) => k / 999);
  const cero = t.map(() => 0);
  const valores = new Map([['time', t], ...n.elementos.map(el => [`v(${el.a})`, cero] as [string, number[]])]);
  vi.mocked(correrSpiceTransitorio).mockResolvedValue({ t, valores, errores: [] });
  await expect(correrTransitorio(n, { pasoS: 0.5, duracionS: 1, inicializacion: 'equilibrio' })).rejects.toThrow(/presupuesto|valores/i);
  expect(correrSpiceTransitorio).toHaveBeenCalledOnce();
});

it('rechaza series finitas cuyo balance de corriente viola Kirchhoff', async () => {
  const n = new Netlist('corriente transitoria inconsistente');
  n.agregar('m', { tipo: 'R', nombre: 'r', a: 'a', b: '0', ohms: 1000 });
  const c = n.agregar('m', { tipo: 'C', nombre: 'c', a: 'a', b: '0', faradios: 1e-6, v0: 1 });
  if (!c.medidor) throw new Error('Falta medidor del capacitor');
  const t = [0, 1];
  // El resistor absorbe 1 mA y el capacitor supuestamente no lo entrega.
  const valores = new Map([['time', t], ['v(a)', [1, 1]], [`i(${c.medidor})`, [0, 0]]]);
  vi.mocked(correrSpiceTransitorio).mockResolvedValue({ t, valores, errores: [] });
  await expect(correrTransitorio(n, { pasoS: 0.5, duracionS: 1, inicializacion: 'explicita' })).rejects.toThrow(/Kirchhoff/);
});
