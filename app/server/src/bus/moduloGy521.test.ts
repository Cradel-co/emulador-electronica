import { beforeAll, describe, expect, it } from 'vitest';
import type { Project, Wire } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { descriptorDe } from '../diagramOps.js';
import { analizarCircuito } from '../sim/analisis.js';
import { precalentar } from '../sim/spice.js';
import { chipsDelProyecto } from './proyectoChips.js';

/** Módulo GY-521 (modules/mpu6050-gy521): dirección por AD0, INT a un pin del micro y su electrónica. */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);
beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

const w = (from: string, to: string): Wire => ({ from, to });
const proyecto = (vcc: string, extra: Wire[] = []): Project => ({
  schemaVersion: 1, name: 't', board: 'arduino-uno', language: 'arduino', sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false },
  modules: [{ id: 'board', type: 'arduino-uno', x: 0, y: 0, props: { usb: true } }, { id: 'imu', type: 'mpu6050-gy521', x: 0, y: 0, props: {} }],
  wires: [w('imu.VCC', `board.${vcc}`), w('imu.GND', 'board.GND'), w('imu.SCL', 'board.A5'), w('imu.SDA', 'board.A4'), ...extra],
});

describe('GY-521 en el bus del Uno', () => {
  it('0x68 con AD0 suelto (pull-down) y 0x69 con AD0 a VCC; INT va al pin del micro', () => {
    let p = proyecto('5V', [w('imu.INT', 'board.D2')]);
    let c = chipsDelProyecto(p, b, descriptorDe(p, b)).chips[0]!;
    expect(c.props.ad0).toBe('bajo');
    expect(c.pinesGpio).toEqual({ INT: 2 });
    p = proyecto('5V', [w('imu.AD0', 'board.3V3')]);
    c = chipsDelProyecto(p, b, descriptorDe(p, b)).chips[0]!;
    expect(c.props.ad0).toBe('alto');
  });

  it('los pull-ups van a los 3,3 V del regulador: con VCC = 5 V, SDA queda en ~3,3 V, no en 5 V', async () => {
    const r = await analizarCircuito(proyecto('5V'), b);
    const pull = r.elementos.find((e) => e.dueno === 'imu' && e.local === 'pullupSDA')!;
    expect(pull.vb).toBeCloseTo(3.3, 1);
  });

  it('a 3,3 V anda (al MPU-6050 le llegan ~3,05 V) y no avisa', async () => {
    const r = await analizarCircuito(proyecto('3V3'), b);
    expect(r.modulos.imu?.ui?.on).toBe(true);
    expect(r.avisos.some((a) => /MPU-6050/.test(a.mensaje))).toBe(false);
  });
});
