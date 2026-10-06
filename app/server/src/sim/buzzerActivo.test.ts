import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleInstance, Project, Wire } from '@emu/shared';
import { eventoPorNivel, SalidaSonidoSchema } from '@emu/shared';
import { readFileSync } from 'node:fs';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito, type AnalisisCircuito } from './analisis.js';
import { precalentar } from './spice.js';

/**
 * El buzzer activo contra el motor real: los números son los de su hoja de datos (TMB12A05),
 * no los que convenga. El sonido no se calcula acá — la frecuencia sale de `salidas` en el
 * module.json — pero QUÉ tensión le llega y SI el oscilador arranca sí los resuelve el motor,
 * y de esa tensión sale la amplitud. Ver SDD-AUDIO.md.
 */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);

beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

const SIM = { wifiSsid: 'x', wifiPassword: 'y', autoReload: false };
const w = (from: string, to: string): Wire => ({ from, to });
const mod = (id: string, type: string, props: Record<string, unknown> = {}): ModuleInstance =>
  ({ id, type, props, x: 0, y: 0 }) as ModuleInstance;

/** El buzzer alimentado por la fuente de laboratorio, a la tensión que se le pida. */
function aTension(voltage: number, invertido = false): Project {
  return {
    schemaVersion: 1, name: 't', board: null, language: null, sim: SIM,
    modules: [mod('f', 'fuente-regulable', { voltage, currentLimitMa: 1000 }), mod('bz1', 'buzzer-activo')],
    wires: invertido
      ? [w('f.V', 'bz1.GND'), w('bz1.IN', 'f.GND')]
      : [w('f.V', 'bz1.IN'), w('bz1.GND', 'f.GND')],
  };
}

const analizar = (p: Project): Promise<AnalisisCircuito> => analizarCircuito(p, b, {});
const mA = (r: AnalisisCircuito) => r.elementos.find((e) => e.id === 'bz1.bobina')!.i * 1000;

describe('buzzer activo: el modelo eléctrico', () => {
  it('a 5 V arranca y consume lo de la hoja de datos (~30 mA)', async () => {
    const r = await analizar(aTension(5));
    expect(mA(r)).toBeGreaterThan(29);
    expect(mA(r)).toBeLessThan(32);
    expect(r.modulos.bz1!.ui?.on).toBe(true);
  });

  it('a 2 V el oscilador no arranca: ni zumba ni consume', async () => {
    const r = await analizar(aTension(2));
    expect(mA(r)).toBeLessThan(0.1);
    expect(r.modulos.bz1!.ui?.on).toBe(false);
  });

  it('a 3 V, el mínimo de trabajo, ya zumba', async () => {
    expect((await analizar(aTension(3))).modulos.bz1!.ui?.on).toBe(true);
  });

  it('a 12 V avisa que se daña', async () => {
    const r = await analizar(aTension(12));
    expect(r.avisos.some((a) => a.severidad === 'peligro' && /máximo es 6 V/.test(a.mensaje))).toBe(true);
  });

  it('al revés no zumba y lo avisa', async () => {
    const r = await analizar(aTension(5, true));
    expect(r.modulos.bz1!.ui?.on).toBe(false);
    expect(r.avisos.some((a) => /al revés/.test(a.mensaje))).toBe(true);
  });
});

describe('buzzer activo: de la tensión del motor al sonido', () => {
  const salida = () => {
    const def = JSON.parse(readFileSync(new URL('../../../../modules/buzzer-activo/module.json', import.meta.url), 'utf8'));
    return SalidaSonidoSchema.parse(def.salidas[0]);
  };

  it('el module.json declara una salida de sonido válida, con la frecuencia de la hoja de datos', () => {
    expect(salida()).toMatchObject({ tipo: 'sonido', fuente: 'nivel', hz: 2400, umbralV: 2.5, dbA: 85 });
  });

  it('a 5 V suena a amplitud plena y a los 85 dBA de la hoja de datos', async () => {
    const r = await analizar(aTension(5));
    const v = r.tensiones['bz1.IN']! - r.tensiones['bz1.GND']!;
    const e = eventoPorNivel('bz1', salida(), v);
    expect(e.sonando).toBe(true);
    expect(e.hz).toBe(2400);
    expect(e.ganancia).toBeCloseTo(1, 2);
    expect(e.dbA!).toBeCloseTo(85, 0);
  });

  it('a 3 V suena, pero más bajo: la amplitud sigue a la tensión', async () => {
    const r = await analizar(aTension(3));
    const v = r.tensiones['bz1.IN']! - r.tensiones['bz1.GND']!;
    const e = eventoPorNivel('bz1', salida(), v);
    expect(e.sonando).toBe(true);
    expect(e.ganancia).toBeCloseTo(0.6, 1);
    expect(e.dbA!).toBeLessThan(81);
  });

  it('a 2 V el sonido se corta, igual que el modelo eléctrico', async () => {
    const r = await analizar(aTension(2));
    const v = r.tensiones['bz1.IN']! - r.tensiones['bz1.GND']!;
    expect(eventoPorNivel('bz1', salida(), v).sonando).toBe(false);
  });
});
