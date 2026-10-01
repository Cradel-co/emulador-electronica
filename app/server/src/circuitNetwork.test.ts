import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ModuleDefSchema, type ModuleDef, type Project } from '@emu/shared';
import { construirRed } from './circuitNetwork.js';
import { solveMNA } from './solver.js';

/** El catálogo de verdad: si cambia un module.json, estos tests lo reflejan. */
const CATALOGO = new Map<string, ModuleDef>(
  ['esp32-s3-devkitc-1', 'led', 'button', 'resistor', 'fuente-regulable'].map((t) => [
    t,
    ModuleDefSchema.parse(JSON.parse(readFileSync(new URL(`../../../modules/${t}/module.json`, import.meta.url), 'utf8'))),
  ]),
);
const buscar = (t: string): ModuleDef | undefined => CATALOGO.get(t);

function proyecto(modules: Project['modules'], wires: Project['wires']): Project {
  return {
    schemaVersion: 1, name: 'test', board: 'esp32-s3-devkitc-1', language: 'micropython',
    modules, wires, sim: { wifiSsid: 'sim', wifiPassword: 'sim' },
  };
}

type Props = Record<string, string | number | boolean>;

const placa = (props: Props = {}) => ({ id: 'board', type: 'esp32-s3-devkitc-1', x: 0, y: 0, props });
const led = (id = 'led1') => ({ id, type: 'led', x: 0, y: 0, props: { color: 'red' } });
const boton = (id = 'btn1') => ({ id, type: 'button', x: 0, y: 0, props: {} });
const resistencia = (id: string, ohms: number) => ({ id, type: 'resistor', x: 0, y: 0, props: { ohms } });

/** mA que circulan por un módulo del circuito. */
function mA(project: Project, estado: Parameters<typeof construirRed>[2], id: string): number {
  const { circuit } = construirRed(project, buscar, estado);
  const sol = solveMNA(circuit);
  return (sol.branchCurrents[id] ?? 0) * 1000;
}

describe('construirRed: la topología sale del circuito, no del rol del módulo', () => {
  it('la placa alimenta y el pulsador está en serie: GPIO7 → btn → R → LED → GND', () => {
    // El circuito que circuitPhysics no arma (corta el recorrido en el pulsador).
    const p = proyecto(
      [placa({ usb: true }), led(), boton(), resistencia('r1', 110)],
      [
        { from: 'board.GPIO7', to: 'btn1.OUT' },
        { from: 'btn1.GND', to: 'r1.1' },
        { from: 'r1.2', to: 'led1.IN' },
        { from: 'led1.GND', to: 'board.GND' },
      ],
    );
    const salidas = new Map<number, 0 | 1>([[7, 1]]);

    // I = (3.3 − 2) / (33 del pin + 110 + 15 del LED) = 8.23 mA
    expect(mA(p, { nivelesGpio: salidas, cerrados: new Set(['btn1']) }, 'led1')).toBeCloseTo(8.23, 2);
    // Pulsador suelto: el circuito está abierto.
    expect(Math.abs(mA(p, { nivelesGpio: salidas, cerrados: new Set() }, 'led1'))).toBeLessThan(0.001);
    // Pulsador apretado pero el firmware puso el pin en bajo: tampoco hay corriente.
    expect(Math.abs(mA(p, { nivelesGpio: new Map([[7, 0]]), cerrados: new Set(['btn1']) }, 'led1'))).toBeLessThan(0.001);
  });

  it('el cátodo del LED en un GPIO en bajo: el pin hunde la corriente y el LED prende', () => {
    // "Active low", clásico en hardware real. El pin no es una etiqueta: en bajo es un sumidero.
    const p = proyecto(
      [placa({ usb: true }), led(), resistencia('r1', 110)],
      [
        { from: 'board.GPIO7', to: 'r1.1' },
        { from: 'r1.2', to: 'led1.IN' },
        { from: 'led1.GND', to: 'board.GPIO6' },
      ],
    );
    // I = (3.3 − 2) / (33 + 110 + 15 + 33 del pin que hunde) = 6.81 mA
    const niveles = new Map<number, 0 | 1>([[7, 1], [6, 0]]);
    expect(mA(p, { nivelesGpio: niveles }, 'led1')).toBeCloseTo(6.81, 2);
    // Los dos pines en alto: sin diferencia de potencial, no pasa corriente.
    expect(Math.abs(mA(p, { nivelesGpio: new Map([[7, 1], [6, 1]]) }, 'led1'))).toBeLessThan(0.001);
  });

  it('circuito continuo sin firmware: fuente → pulsador → LED → R → GND', () => {
    const p = proyecto(
      [
        placa(),
        { id: 'fuente1', type: 'fuente-regulable', x: 0, y: 0, props: { voltage: 5, currentLimitMa: 300 } },
        boton(), led(), resistencia('r1', 150),
      ],
      [
        { from: 'fuente1.GND', to: 'board.GND' },
        { from: 'fuente1.V', to: 'btn1.OUT' },
        { from: 'btn1.GND', to: 'led1.IN' },
        { from: 'led1.GND', to: 'r1.1' },
        { from: 'r1.2', to: 'board.GND_2' },
      ],
    );
    // Ningún GPIO manejado por el firmware: la corriente sale de la fuente.
    // I = (5 − 2) / (150 + 15) = 18.2 mA
    expect(mA(p, { cerrados: new Set(['btn1']) }, 'led1')).toBeCloseTo(18.2, 1);
    expect(Math.abs(mA(p, { cerrados: new Set() }, 'led1'))).toBeLessThan(0.001);
  });

  it('el clásico: GPIO → LED → R → GND, con el mismo número que daba el motor viejo', () => {
    const p = proyecto(
      [placa({ usb: true }), led(), resistencia('r1', 110)],
      [
        { from: 'board.GPIO7', to: 'led1.IN' },
        { from: 'led1.GND', to: 'r1.1' },
        { from: 'r1.2', to: 'board.GND' },
      ],
    );
    expect(mA(p, { nivelesGpio: new Map([[7, 1]]) }, 'led1')).toBeCloseTo(8.23, 2);
  });
});
