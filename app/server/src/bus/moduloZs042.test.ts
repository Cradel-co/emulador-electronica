import { beforeAll, describe, expect, it } from 'vitest';
import type { Project, Wire } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { descriptorDe } from '../diagramOps.js';
import { analizarCircuito } from '../sim/analisis.js';
import { precalentar } from '../sim/spice.js';
import { chipsDelProyecto } from './proyectoChips.js';

/** Módulo ZS-042 (modules/ds3231-zs042): dos chips en el bus, SQW a un pin del micro, y su electrónica. */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);
beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

const w = (from: string, to: string): Wire => ({ from, to });
function proyecto(vcc: string, extra: Wire[] = [], props: Record<string, string> = {}): Project {
  return {
    schemaVersion: 1, name: 't', board: 'arduino-uno', language: 'arduino', sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false },
    modules: [
      { id: 'board', type: 'arduino-uno', x: 0, y: 0, props: { usb: true } },
      { id: 'rtc', type: 'ds3231-zs042', x: 0, y: 0, props },
    ],
    wires: [w('rtc.VCC', `board.${vcc}`), w('rtc.GND', 'board.GND'), w('rtc.SCL', 'board.A5'), w('rtc.SDA', 'board.A4'), ...extra],
  };
}

describe('ZS-042 en el bus del Uno', () => {
  it('quedan los dos chips (DS3231 en 0x68 y AT24C32), con ids propios y la misma instancia', () => {
    const p = proyecto('5V');
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.avisos).toEqual([]);
    expect(r.chips.map((c) => [c.id, c.instancia, c.chip])).toEqual([
      ['rtc:maxim-ds3231', 'rtc', 'maxim-ds3231'],
      ['rtc:atmel-at24c32', 'rtc', 'atmel-at24c32'],
    ]);
    expect(r.chips[1]!.props.direccion).toBe('0x57');
  });

  it('SQW cableado a D2: el pin INT/SQW del chip va al GPIO 2 y tiene el pull-up de la placa', () => {
    const p = proyecto('5V', [w('rtc.SQW', 'board.D2')]);
    const ds = chipsDelProyecto(p, b, descriptorDe(p, b)).chips[0]!;
    expect(ds.pinesGpio).toEqual({ 'INT/SQW': 2 });
    expect(ds.pullUps).toContain('INT/SQW');
  });
});

describe('ZS-042: electricidad', () => {
  const pila = async (p: Project) => {
    const r = await analizarCircuito(p, b);
    // Positiva: entra por el + de la pila y la atraviesa (la carga).
    return { r, carga: r.elementos.find((e) => e.dueno === 'rtc' && e.local === 'pila')?.i ?? 0 };
  };

  it('a 5 V el circuito de carga le mete ~6 mA a la CR2032 (no recargable): aviso de peligro', async () => {
    const { r, carga } = await pila(proyecto('5V'));
    expect(carga * 1000).toBeGreaterThan(5);
    expect(carga * 1000).toBeLessThan(8);
    expect(r.avisos.some((a) => /CR2032/.test(a.mensaje) && a.severidad === 'peligro')).toBe(true);
  });

  it('a 3,3 V la carga casi no pasa (el diodo no conduce): sin aviso', async () => {
    const { r, carga } = await pila(proyecto('3V3'));
    expect(carga).toBeLessThan(10e-6);
    expect(r.avisos.some((a) => /CR2032/.test(a.mensaje))).toBe(false);
  });

  it('con una LIR2032 (recargable) a 5 V carga igual, pero no es un problema: sin aviso', async () => {
    const { r, carga } = await pila(proyecto('5V', [], { pila: 'LIR2032' }));
    expect(carga).toBeGreaterThan(1e-3);
    expect(r.avisos.some((a) => /CR2032|LIR2032/.test(a.mensaje))).toBe(false);
  });

  it('la pila no crea el aviso de "fuenteTension sin ser una fuente" (es una batería, energía legítima)', async () => {
    const { r } = await pila(proyecto('5V'));
    expect(r.avisos.some((a) => /fuenteTension/.test(a.mensaje))).toBe(false);
  });
});
