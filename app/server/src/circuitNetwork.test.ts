import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ModuleDefSchema, type ModuleDef, type Project } from '@emu/shared';
import { construirRed } from './circuitNetwork.js';
import { solveMNA } from './solver.js';
import { nivelesDeEntrada } from './circuitEngine.js';

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

    // Arreglo de la revisión: el Vf del LED (2 V) es su caída a 20 mA, así que el codo del modelo
    // queda en 2 − 15·0,02 = 1,7 V (antes se sumaban 15 Ω encima y a 20 mA caían 2,3 V).
    // I = (3.3 − 1.7) / (33 del pin + 110 + 15 del LED) = 10.13 mA
    expect(mA(p, { nivelesGpio: salidas, cerrados: new Set(['btn1']) }, 'led1')).toBeCloseTo(10.13, 2);
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
    // Arreglo de la revisión: el Vf del LED (2 V) es su caída a 20 mA, así que el codo del modelo
    // queda en 2 − 15·0,02 = 1,7 V (antes se sumaban 15 Ω encima y a 20 mA caían 2,3 V).
    // I = (3.3 − 1.7) / (33 + 110 + 15 + 33 del pin que hunde) = 8.38 mA
    const niveles = new Map<number, 0 | 1>([[7, 1], [6, 0]]);
    expect(mA(p, { nivelesGpio: niveles }, 'led1')).toBeCloseTo(8.38, 2);
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
    // Arreglo de la revisión: el Vf del LED (2 V) es su caída a 20 mA, así que el codo del modelo
    // queda en 2 − 15·0,02 = 1,7 V (antes se sumaban 15 Ω encima y a 20 mA caían 2,3 V).
    // I = (5 − 1.7) / (150 + 15) = 20.0 mA: justo lo que da la cuenta de la hoja de datos, (5 − 2) / 150.
    expect(mA(p, { cerrados: new Set(['btn1']) }, 'led1')).toBeCloseTo(20.0, 1);
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
    // Arreglo de la revisión: el Vf del LED (2 V) es su caída a 20 mA, así que el codo del modelo
    // queda en 2 − 15·0,02 = 1,7 V (antes se sumaban 15 Ω encima y a 20 mA caían 2,3 V).
    expect(mA(p, { nivelesGpio: new Map([[7, 1]]) }, 'led1')).toBeCloseTo(10.13, 2);
  });
});

describe('construirRed: arreglos de la revisión (lo que haría el circuito en la mesa)', () => {
  const fuente = (v: number, limiteMa: number, id = 'f') => ({ id, type: 'fuente-regulable', x: 0, y: 0, props: { voltage: v, currentLimitMa: limiteMa } });
  const sinPlaca = (modules: Project['modules'], wires: Project['wires']): Project => ({ ...proyecto(modules, wires), board: null, language: null });
  const resolver = (p: Project, estado: Parameters<typeof construirRed>[2] = {}) => solveMNA(construirRed(p, buscar, estado).circuit);

  it('una fuente en corto (V con GND) no rompe el cálculo: entrega su límite, como una de laboratorio', () => {
    const p = proyecto([placa(), fuente(5, 100)], [{ from: 'f.V', to: 'f.GND' }, { from: 'f.GND', to: 'board.GND' }]);
    const sol = resolver(p);
    expect(Math.abs((sol.sourceCurrents['f'] ?? 0) * 1000)).toBeCloseTo(100, 0);
  });

  it('respeta el límite de corriente de la fuente (modo CC): LED directo a 5 V limitado a 100 mA', () => {
    const p = proyecto([placa(), fuente(5, 100), led()], [{ from: 'f.V', to: 'led1.IN' }, { from: 'led1.GND', to: 'f.GND' }, { from: 'f.GND', to: 'board.GND' }]);
    expect(mA(p, {}, 'led1')).toBeCloseTo(100, 0);
  });

  it('una fuente con su GND sin cablear no cierra circuito', () => {
    const p = proyecto([placa(), fuente(5, 1000), led(), resistencia('r1', 220)],
      [{ from: 'f.V', to: 'led1.IN' }, { from: 'led1.GND', to: 'r1.1' }, { from: 'r1.2', to: 'board.GND' }]);
    expect(Math.abs(mA(p, {}, 'led1'))).toBeLessThan(0.001);
  });

  it('el Vf del LED es su caída a 20 mA: con 150 Ω a 5 V pasan 20 mA (no 18,2)', () => {
    const p = proyecto([placa(), fuente(5, 1000), led(), resistencia('r1', 150)],
      [{ from: 'f.V', to: 'led1.IN' }, { from: 'led1.GND', to: 'r1.1' }, { from: 'r1.2', to: 'f.GND' }, { from: 'f.GND', to: 'board.GND' }]);
    expect(mA(p, {}, 'led1')).toBeCloseTo(20, 0);
  });

  it('un GPIO en alto cableado directo a GND es un corto: el pin entrega lo que su resistencia interna deja (~100 mA)', () => {
    const p = proyecto([placa({ usb: true })], [{ from: 'board.GPIO7', to: 'board.GND' }]);
    expect(Math.abs(mA(p, { nivelesGpio: new Map([[7, 1]]) }, 'board.GPIO7#drv'))).toBeCloseTo(100, -1);
  });

  it('placa alimentada por una fuente en el pin 5V: el 3V3 sale del regulador y alimenta un LED', () => {
    const p = proyecto([placa(), fuente(5, 1000), led(), resistencia('r1', 220)],
      [{ from: 'f.V', to: 'board.5V' }, { from: 'f.GND', to: 'board.GND' }, { from: 'board.3V3', to: 'led1.IN' }, { from: 'led1.GND', to: 'r1.1' }, { from: 'r1.2', to: 'board.GND' }]);
    expect(mA(p, {}, 'led1')).toBeGreaterThan(5);
  });

  it('dos fuentes a distinta tensión en el mismo nodo: no se pisa una con otra, chocan y entra el límite', () => {
    const p = proyecto([placa(), fuente(5, 1000), fuente(3, 1000, 'f2')],
      [{ from: 'f.V', to: 'f2.V' }, { from: 'f.GND', to: 'board.GND' }, { from: 'f2.GND', to: 'board.GND' }]);
    const sol = resolver(p);
    expect(Math.abs((sol.sourceCurrents['f'] ?? 0) * 1000)).toBeCloseTo(1000, -1);
  });

  it('un proyecto sin placa se resuelve con la tierra de la fuente', () => {
    const p = sinPlaca([fuente(5, 1000), led(), resistencia('r1', 220)],
      [{ from: 'f.V', to: 'led1.IN' }, { from: 'led1.GND', to: 'r1.1' }, { from: 'r1.2', to: 'f.GND' }]);
    const i = mA(p, {}, 'led1');
    expect(i).toBeGreaterThan(13);
    expect(i).toBeLessThan(15);
  });

  it('una placa sin alimentar no maneja sus pines aunque el firmware los "ponga" en alto', () => {
    const p = proyecto([placa(), led(), resistencia('r1', 220)],
      [{ from: 'board.GPIO7', to: 'led1.IN' }, { from: 'led1.GND', to: 'r1.1' }, { from: 'r1.2', to: 'board.GND' }]);
    expect(Math.abs(mA(p, { nivelesGpio: new Map([[7, 1]]) }, 'led1'))).toBeLessThan(0.001);
  });

  it('nivelesDeEntrada con el pull-up interno: pulsador a GND suelto lee 1, apretado lee 0', () => {
    const p = proyecto([placa({ usb: true }), boton()], [{ from: 'board.GPIO6', to: 'btn1.OUT' }, { from: 'btn1.GND', to: 'board.GND' }]);
    const pulls = new Map([[6, 'up' as const]]);
    expect(nivelesDeEntrada(p, buscar, new Map(), new Set(), pulls).get(6)).toBe(1);
    expect(nivelesDeEntrada(p, buscar, new Map(), new Set(['btn1']), pulls).get(6)).toBe(0);
  });
});
