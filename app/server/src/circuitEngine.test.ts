import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ModuleDefSchema, type ModuleDef, type Project } from '@emu/shared';
import { ledsDelSolver, nivelesDeEntrada } from './circuitEngine.js';

const CATALOGO = new Map<string, ModuleDef>(
  ['esp32-s3-devkitc-1', 'led', 'button', 'switch', 'resistor'].map((t) => [
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
    // Arreglo de la revisión: el Vf del LED (2 V) es su caída a 20 mA, así que el codo del modelo
    // queda en 2 − 15·0,02 = 1,7 V (antes se sumaban 15 Ω encima y a 20 mA caían 2,3 V).
    expect(led?.mA).toBeCloseTo(10.13, 2);
    expect(led?.mAFijo).toBeCloseTo(10.13, 2);
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
    // Por encima de los 20 mA recomendados del LED.
    const [led] = ledsDelSolver(sinR, buscar, new Map([[7, 1]]), new Set());
    // Arreglo de la revisión: el Vf del LED (2 V) es su caída a 20 mA, así que el codo del modelo
    // queda en 2 − 15·0,02 = 1,7 V (antes se sumaban 15 Ω encima y a 20 mA caían 2,3 V).
    // Sin resistencia: (3.3 − 1.7) / (33 + 15) = 33.3 mA.
    expect(led?.mA).toBeCloseTo(33.3, 1);
    expect(led?.estado).toBe('sobreexigido');
  });
});

describe('nivelesDeEntrada: lo que un GPIO de entrada lee del circuito', () => {
  /** Interruptor en serie con la carga y un GPIO sensando el nodo del medio. */
  const SENSADO: Project = {
    schemaVersion: 1, name: 'test', board: 'esp32-s3-devkitc-1', language: 'micropython',
    sim: { wifiSsid: 'sim', wifiPassword: 'sim' },
    modules: [
      { id: 'board', type: 'esp32-s3-devkitc-1', x: 0, y: 0, props: { usb: true } },
      { id: 'led1', type: 'led', x: 0, y: 0, props: { color: 'red' } },
      { id: 'sw1', type: 'switch', x: 0, y: 0, props: {} },
      { id: 'r1', type: 'resistor', x: 0, y: 0, props: { ohms: 220 } },
    ],
    wires: [
      { from: 'board.GPIO7', to: 'sw1.OUT' },   // la placa alimenta
      { from: 'sw1.GND', to: 'r1.1' },          // interruptor en serie con la carga
      { from: 'sw1.GND', to: 'board.GPIO5' },   // y el firmware sensa ese mismo nodo
      { from: 'r1.2', to: 'led1.IN' },
      { from: 'led1.GND', to: 'board.GND' },
    ],
  };

  it('cerrado: el nodo queda arriba y el GPIO de entrada lee 1', () => {
    const niveles = nivelesDeEntrada(SENSADO, buscar, new Map([[7, 1]]), new Set(['sw1']));
    expect(niveles.get(5)).toBe(1);
  });

  it('abierto: la carga tira el nodo a masa y lee 0, sin necesidad de pull-down', () => {
    const niveles = nivelesDeEntrada(SENSADO, buscar, new Map([[7, 1]]), new Set());
    expect(niveles.get(5)).toBe(0);
  });

  it('con el pin de salida en bajo lee 0 aunque el interruptor esté cerrado', () => {
    const niveles = nivelesDeEntrada(SENSADO, buscar, new Map([[7, 0]]), new Set(['sw1']));
    expect(niveles.get(5)).toBe(0);
  });

  it('no inventa un nivel para un GPIO que el firmware maneja como salida', () => {
    const niveles = nivelesDeEntrada(SENSADO, buscar, new Map([[7, 1]]), new Set(['sw1']));
    expect(niveles.has(7)).toBe(false);
  });
});
