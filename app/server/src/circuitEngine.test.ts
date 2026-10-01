import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ModuleDefSchema, type ModuleDef, type Project } from '@emu/shared';
import { ledsDelSolver } from './circuitEngine.js';

const CATALOGO = new Map<string, ModuleDef>(
  ['esp32-s3-devkitc-1', 'led', 'button', 'resistor'].map((t) => [
    t,
    ModuleDefSchema.parse(JSON.parse(readFileSync(new URL(`../../../modules/${t}/module.json`, import.meta.url), 'utf8'))),
  ]),
);
const buscar = (t: string): ModuleDef | undefined => CATALOGO.get(t);

/** El circuito que la app hoy reporta en 0 mA: la placa alimenta y el pulsador está en serie. */
const PROYECTO: Project = {
  schemaVersion: 1, name: 'test', board: 'esp32-s3-devkitc-1', language: 'micropython',
  sim: { wifiSsid: 'sim', wifiPassword: 'sim' },
  modules: [
    { id: 'board', type: 'esp32-s3-devkitc-1', x: 0, y: 0, props: { usb: true } },
    { id: 'led1', type: 'led', x: 0, y: 0, props: { color: 'red' } },
    { id: 'btn1', type: 'button', x: 0, y: 0, props: {} },
    { id: 'r1', type: 'resistor', x: 0, y: 0, props: { ohms: 110 } },
  ],
  wires: [
    { from: 'board.GPIO7', to: 'btn1.OUT' },
    { from: 'btn1.GND', to: 'r1.1' },
    { from: 'r1.2', to: 'led1.IN' },
    { from: 'led1.GND', to: 'board.GND' },
  ],
};

describe('ledsDelSolver: lo que la UI necesita para prender un LED', () => {
  it('da la corriente real y la deja en mAFijo, que es lo que mira el canvas', () => {
    const [led] = ledsDelSolver(PROYECTO, buscar, new Map([[7, 1]]), new Set(['btn1']));
    expect(led?.id).toBe('led1');
    expect(led?.mA).toBeCloseTo(8.23, 2);
    expect(led?.mAFijo).toBeCloseTo(8.23, 2);
    expect(led?.estado).toBe('ok');
  });

  it('pulsador suelto: el LED queda en cero', () => {
    const [led] = ledsDelSolver(PROYECTO, buscar, new Map([[7, 1]]), new Set());
    expect(led?.mA).toBeLessThan(0.001);
    expect(led?.mAFijo).toBeLessThan(0.001);
  });

  it('sin resistencia el LED se exige de más, y con mucha corriente se quema', () => {
    const sinR: Project = {
      ...PROYECTO,
      modules: PROYECTO.modules.filter((m) => m.id !== 'r1'),
      wires: [
        { from: 'board.GPIO7', to: 'led1.IN' },
        { from: 'led1.GND', to: 'board.GND' },
      ],
    };
    // (3.3 − 2) / (33 + 15) = 27 mA: por encima de los 20 mA recomendados del LED.
    const [led] = ledsDelSolver(sinR, buscar, new Map([[7, 1]]), new Set());
    expect(led?.mA).toBeCloseTo(27.1, 1);
    expect(led?.estado).toBe('sobreexigido');
  });
});
