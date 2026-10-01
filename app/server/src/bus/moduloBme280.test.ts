import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleInstance, Project, Wire } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { descriptorDe } from '../diagramOps.js';
import { analizarCircuito } from '../sim/analisis.js';
import { precalentar } from '../sim/spice.js';
import { chipsDelProyecto } from './proyectoChips.js';

/**
 * El módulo del catálogo modules/bme280-adafruit: la placa de Adafruit con su electrónica real
 * (MIC5225, BSS138, pull-ups de 10 kΩ, R4 en SDO) y el chip bosch-bme280 en el bus del Uno.
 */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);
beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

const w = (from: string, to: string): Wire => ({ from, to });
function proyecto(placa: string, cables: Wire[], extra: Omit<ModuleInstance, 'x' | 'y'>[] = []): Project {
  return {
    schemaVersion: 1, name: 't', board: placa, language: 'arduino', sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false },
    modules: [
      { id: 'board', type: placa, x: 0, y: 0, props: { usb: true } },
      { id: 'bme', type: 'bme280-adafruit', x: 0, y: 0, props: {} },
      ...extra.map((m) => ({ x: 0, y: 0, ...m })),
    ],
    wires: cables,
  };
}
const BASICO = [w('bme.VIN', 'board.5V'), w('bme.GND', 'board.GND'), w('bme.SCK', 'board.A5'), w('bme.SDI', 'board.A4')];

describe('módulo BME280 de Adafruit en el bus del Uno', () => {
  it('cableado a A4/A5 queda en el bus I2C, alimentado y en 0x77 (SDO con su pull-up)', () => {
    const p = proyecto('arduino-uno', BASICO);
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.avisos).toEqual([]);
    expect(r.chips).toHaveLength(1);
    expect(r.chips[0]).toMatchObject({ id: 'bme', chip: 'bosch-bme280', alimentado: true, props: { sdo: 'alto' } });
    expect(r.chips[0]!.entorno).toEqual({ temperatura: 22, humedad: 45, presion: 1013.25 });
  });

  it('también por los pines SDA/SCL del header del Uno (son los mismos A4/A5)', () => {
    const p = proyecto('arduino-uno', [w('bme.VIN', 'board.5V'), w('bme.GND', 'board.GND'), w('bme.SCK', 'board.SCL'), w('bme.SDI', 'board.SDA')]);
    expect(chipsDelProyecto(p, b, descriptorDe(p, b)).chips).toHaveLength(1);
  });

  it('SDO a GND pasa a 0x76, como en la placa real; SDO a 3V3 queda en 0x77', () => {
    const p = proyecto('arduino-uno', [...BASICO, w('bme.SDO', 'board.GND')]);
    expect(chipsDelProyecto(p, b, descriptorDe(p, b)).chips[0]!.props.sdo).toBe('bajo');
    const q = proyecto('arduino-uno', [...BASICO, w('bme.SDO', 'board.3V3')]);
    expect(chipsDelProyecto(q, b, descriptorDe(q, b)).chips[0]!.props.sdo).toBe('alto');
  });

  it('SDO a un pin del micro: avisa que la dirección la decide el programa', () => {
    const p = proyecto('arduino-uno', [...BASICO, w('bme.SDO', 'board.D7')]);
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.avisos.join()).toMatch(/SDO va a un pin del micro/);
  });

  it('SDA y SCL cruzados: no responde y se dice por qué', () => {
    const p = proyecto('arduino-uno', [w('bme.VIN', 'board.5V'), w('bme.GND', 'board.GND'), w('bme.SCK', 'board.A4'), w('bme.SDI', 'board.A5')]);
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.chips).toHaveLength(0);
    expect(r.avisos.join()).toMatch(/cruzados/);
  });

  it('a otros pines (no los del bus): no responde y se dice adónde van', () => {
    const p = proyecto('arduino-uno', [w('bme.VIN', 'board.5V'), w('bme.GND', 'board.GND'), w('bme.SCK', 'board.D3'), w('bme.SDI', 'board.D2')]);
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.chips).toHaveLength(0);
    expect(r.avisos.join()).toMatch(/tienen que ir a los pines SDA y SCL/);
  });

  it('sin VIN cableado queda en el bus pero sin alimentación (no contesta)', () => {
    const p = proyecto('arduino-uno', BASICO.slice(1));
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.chips[0]!.alimentado).toBe(false);
    expect(r.avisos.join()).toMatch(/sin alimentación/);
  });

  it('en un ESP32 (esp-emu no emula dispositivos I2C) se avisa en vez de fallar callado', () => {
    const p = proyecto('esp32-s3-devkitc-1', [w('bme.VIN', 'board.3V3'), w('bme.GND', 'board.GND'), w('bme.SCK', 'board.GPIO9'), w('bme.SDI', 'board.GPIO8')]);
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.chips).toHaveLength(0);
    expect(r.avisos.join()).toMatch(/no emula el bus I2C/);
  });
});

describe('módulo BME280 de Adafruit: electricidad (esquemático real)', () => {
  it('con 5 V: 3VO en 3,3 V; consume el sensor + el regulador; los pull-ups de 10 kΩ van a VIN', async () => {
    const p = proyecto('arduino-uno', BASICO);
    const r = await analizarCircuito(p, b);
    const el = (n: string) => r.elementos.find((e) => e.dueno === 'bme' && e.local === n)!;
    expect(el('bme280').va - el('bme280').vb).toBeCloseTo(3.3, 2);
    expect(el('mic5225').i * 1000).toBeCloseTo(0.7 + 3.3 / 10000 * 1000 * 0, 1); // 0,7 mA del sensor (+ R4 si SDO a GND)
    expect(r.avisos.filter((a) => a.mensaje.includes('BME280'))).toEqual([]);
  });

  it('alimentado desde el 3V3 del Uno: el MIC5225 queda en caída y avisa (el sensor anda igual)', async () => {
    const p = proyecto('arduino-uno', [w('bme.VIN', 'board.3V3'), ...BASICO.slice(1)]);
    const r = await analizarCircuito(p, b);
    const el = r.elementos.find((e) => e.dueno === 'bme' && e.local === 'bme280')!;
    expect(el.va - el.vb).toBeGreaterThan(2.8);
    expect(el.va - el.vb).toBeLessThan(3.1);
    expect(r.avisos.some((a) => /regulador está en caída/.test(a.mensaje))).toBe(true);
  });

  it('SDO a GND: R4 (10 kΩ a 3,3 V) suma 0,33 mA, como en la placa real', async () => {
    const sin = await analizarCircuito(proyecto('arduino-uno', BASICO), b);
    const con = await analizarCircuito(proyecto('arduino-uno', [...BASICO, w('bme.SDO', 'board.GND')]), b);
    const i = (r: typeof sin) => r.elementos.find((e) => e.dueno === 'bme' && e.local === 'mic5225')!.i * 1000;
    expect(i(con) - i(sin)).toBeCloseTo(0.33, 2);
  });

  it('si está alimentado lo decide el motor eléctrico: VIN cableado a GND no enciende el sensor', async () => {
    const p = proyecto('arduino-uno', [w('bme.VIN', 'board.GND'), ...BASICO.slice(1)]);
    const r = await analizarCircuito(p, b);
    const res = chipsDelProyecto(p, b, descriptorDe(p, b), undefined, (id) => r.modulos[id]?.ui?.on);
    expect(res.chips[0]!.alimentado).toBe(false);
    expect(res.avisos.join()).toMatch(/no le llega la tensión/);
    // Y bien alimentado, el motor dice que sí.
    const q = proyecto('arduino-uno', BASICO);
    const rq = await analizarCircuito(q, b);
    expect(chipsDelProyecto(q, b, descriptorDe(q, b), undefined, (id) => rq.modulos[id]?.ui?.on).chips[0]!.alimentado).toBe(true);
  });
});
