import { describe, expect, it } from 'vitest';
import { destinoGpio, gpioEnPlaca } from '../../web/gpio-destination.js';
const boards = [{ id: 'board', board: 'esp32', language: 'micropython' }, { id: 'board2', board: 'uno', language: 'arduino' }];
const catalog = new Map<string, { board?: { pins: Record<string, { gpio?: number }> }; passthrough?: boolean; pins?: { name: string }[] }>([
  ['esp32', { board: { pins: { GPIO7: { gpio: 7 }, GND: {} } } }],
  ['uno', { board: { pins: { D7: { gpio: 7 }, GND: {} } } }],
  ['resistor', { passthrough: true, pins: [{ name: 'A' }, { name: 'B' }] }],
]);
describe('destino GPIO con varias placas', () => {
  it('no mezcla el mismo GPIO de placas distintas', () => {
    expect(gpioEnPlaca('board.GPIO7', boards, catalog)).toEqual({ boardId: 'board', gpio: 7 });
    expect(gpioEnPlaca('board2.D7', boards, catalog)).toEqual({ boardId: 'board2', gpio: 7 });
    expect(gpioEnPlaca('board2.GND', boards, catalog)).toBeNull();
  });
  it('sigue pasivos conservando el id de la placa', () => {
    const modules = [{ id: 'r1', type: 'resistor' }];
    const wires = [{ from: 'led.IN', to: 'r1.A' }, { from: 'r1.B', to: 'board2.D7' }];
    expect(destinoGpio('led.IN', modules, wires, boards, catalog)).toEqual({ boardId: 'board2', gpio: 7 });
  });
  it('corta lazos y no inventa GPIO para módulos desconectados', () => {
    const modules = [{ id: 'r1', type: 'resistor' }, { id: 'r2', type: 'resistor' }];
    const wires = [{ from: 'r1.A', to: 'r2.B' }, { from: 'r1.B', to: 'r2.A' }];
    expect(destinoGpio('r1.A', modules, wires, boards, catalog)).toBeNull();
    expect(destinoGpio('led.IN', [], [], boards, catalog)).toBeNull();
  });
});
