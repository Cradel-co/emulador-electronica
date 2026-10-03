import { gpioDe, gpioDeRef, nombrePinGpio } from '../../web/consultas.js';
import { describe, expect, it } from 'vitest';
import { consultasOriginales } from './fixtures/gpio-original.js';

function actuales(state: any) {
  const descriptor = state.placa?.board ?? null;
  return {
    gpioDeRef: (ref: string) => gpioDeRef(ref, descriptor),
    nombrePinGpio: (g: number) => nombrePinGpio(g, descriptor),
    gpioDe: (id: string, pin: string) => gpioDe(id, pin, state.diagrama.modules,
      state.diagrama.wires, (type) => state.catalogo.get(type), descriptor),
  };
}
const estado = (wires: any[] = [], modules: any[] = [], board: any = null) => ({
  diagrama: { wires, modules }, placa: board ? { board } : null,
  catalogo: new Map([
    ['resistor', { passthrough: true, pins: [{ name: 'A' }, { name: 'B' }] }],
    ['led', { pins: [{ name: 'IN' }, { name: 'GND' }] }],
    ['triple', { passthrough: true, pins: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }],
  ]),
});
const cable = (from: string, to: string) => ({ from, to });
const modulo = (id: string, type = 'resistor') => ({ id, type });

describe('consultas GPIO del dibujo', () => {
  it('interpreta los pines del descriptor sin inventar GPIO y conserva el primer alias', () => {
    const q = actuales(estado([], [], { pins: { D13: { gpio: 13 }, LED: { gpio: 13 }, GND: {} } }));
    expect(q.gpioDeRef('board.D13')).toBe(13);
    expect(q.gpioDeRef('board.GPIO13')).toBeNull();
    expect(q.gpioDeRef('board.GND')).toBeNull();
    expect(q.gpioDeRef('led.D13')).toBeNull();
    expect(q.nombrePinGpio(13)).toBe('D13');
    expect(q.nombrePinGpio(6)).toBe('GPIO6');
  });
  it('sin descriptor usa solamente GPIO de uno o dos dígitos', () => {
    const q = actuales(estado());
    expect(q.gpioDeRef('board.GPIO0')).toBe(0);
    expect(q.gpioDeRef('board.GPIO99')).toBe(99);
    for (const ref of ['board.GPIO100', 'board.D13', 'board.GPIO6.extra', 'x.GPIO6']) expect(q.gpioDeRef(ref)).toBeNull();
  });
  it('sigue resistencias en serie y corta ciclos sin perder otras ramas', () => {
    const q = actuales(estado([
      cable('led.IN', 'r1.A'), cable('r1.B', 'r2.A'), cable('r2.B', 'r1.A'),
      cable('r2.B', 'board.GPIO0'),
    ], [modulo('led', 'led'), modulo('r1'), modulo('r2')]));
    expect(q.gpioDe('led', 'IN')).toBe(0);
    expect(q.gpioDe('led', 'GND')).toBeNull();
  });
  it('no atraviesa módulos sin passthrough, ausentes o con tres pines', () => {
    for (const type of ['led', 'triple', 'ausente']) {
      const q = actuales(estado([cable('x.IN', 'r.A'), cable('r.B', 'board.GPIO6')], [modulo('r', type)]));
      expect(q.gpioDe('x', 'IN')).toBeNull();
    }
  });
  it('respeta el orden de los cables al haber más de un GPIO alcanzable', () => {
    const wires = [cable('x.IN', 'board.GPIO7'), cable('board.GPIO6', 'x.IN')];
    expect(actuales(estado(wires)).gpioDe('x', 'IN')).toBe(7);
    expect(actuales(estado([...wires].reverse())).gpioDe('x', 'IN')).toBe(6);
  });
  it('coincide con la versión original en 3000 circuitos deterministas', () => {
    let semilla = 12345;
    const azar = (n: number) => { semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0; return semilla % n; };
    const refs = ['x.IN', 'r1.A', 'r1.B', 'r2.A', 'r2.B', 'r3.A', 'r3.B', 'board.GPIO0', 'board.GPIO6', 'board.D13', 'board.GND'];
    for (let i = 0; i < 3000; i++) {
      const wires = Array.from({ length: azar(15) }, () => cable(refs[azar(refs.length)], refs[azar(refs.length)]));
      const state = estado(wires, [modulo('r1'), modulo('r2'), modulo('r3', ['resistor', 'led', 'triple'][azar(3)])], i % 2 ? { pins: { D13: { gpio: 13 }, GPIO0: { gpio: 0 }, GND: {} } } : null);
      const q = actuales(state), viejo = consultasOriginales(state);
      expect(q.gpioDe('x', 'IN')).toBe(viejo.gpioDe('x', 'IN'));
      for (const ref of refs) expect(q.gpioDeRef(ref)).toBe(viejo.gpioDeRef(ref));
      expect(q.nombrePinGpio(13)).toBe(viejo.nombrePinGpio(13));
    }
  });
});
