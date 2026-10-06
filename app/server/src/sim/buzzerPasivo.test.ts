import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleInstance, Project, Wire } from '@emu/shared';
import { sonidosDelCircuito } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito, type AnalisisCircuito } from './analisis.js';
import { precalentar } from './spice.js';

/**
 * Buzzer pasivo (piezo). El tono no sale del motor: lo declara el firmware por PWM. Lo que el
 * motor resuelve es lo eléctrico, y lo que importa verificar es que **no carga el pin**: un piezo
 * es un capacitor, y en continua no conduce.
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

function aTension(voltage: number): Project {
  return {
    schemaVersion: 1, name: 't', board: null, language: null, sim: SIM,
    modules: [
      mod('f', 'fuente-regulable', { voltage, currentLimitMa: 500 }),
      mod('bz1', 'buzzer-pasivo', { capacidadNf: 20 }),
    ],
    wires: [w('f.V', 'bz1.IN'), w('bz1.GND', 'f.GND')],
  };
}

const analizar = (p: Project): Promise<AnalisisCircuito> => analizarCircuito(p, b, {});
const uA = (r: AnalisisCircuito) => (r.elementos.find((e) => e.id === 'bz1.fuga')?.i ?? 0) * 1e6;

describe('buzzer pasivo: lo eléctrico', () => {
  it('en continua no carga el pin: un piezo es un capacitor', async () => {
    const r = await analizar(aTension(3.3));
    // Solo la corriente de fuga del disco: microamperes, no miliamperes.
    expect(Math.abs(uA(r))).toBeLessThan(10);
    expect(r.resuelto).toBe(true);
  });

  it('no se queda flotando ni rompe la solución sin alimentación', async () => {
    const r = await analizar(aTension(0));
    expect(r.resuelto).toBe(true);
  });

  it('pasarse de tensión de pico es peligro', async () => {
    const r = await analizar(aTension(20));
    expect(r.avisos.some((a) => a.severidad === 'peligro' && /máximo es 12,5 V/.test(a.mensaje))).toBe(true);
  });
});

describe('buzzer pasivo: el tono viene del PWM', () => {
  const salidasDe = (t: string) => b(t)?.salidas;

  it('sin PWM declarado no suena, aunque tenga tensión', async () => {
    const r = await analizar(aTension(3.3));
    const s = sonidosDelCircuito([{ id: 'bz1', type: 'buzzer-pasivo' }], salidasDe, r.tensiones)[0];
    expect(s).toMatchObject({ modulo: 'bz1', sonando: false, ganancia: 0 });
  });

  it('con el PWM declarado suena a esa frecuencia', async () => {
    const r = await analizar(aTension(3.3));
    const pwmDe = () => ({ hz: 440, duty: 0.5 });
    const s = sonidosDelCircuito([{ id: 'bz1', type: 'buzzer-pasivo' }], salidasDe, r.tensiones, undefined, pwmDe)[0];
    expect(s).toMatchObject({ sonando: true, hz: 440 });
    expect(s!.ganancia).toBeGreaterThan(0.9);
  });

  it('cambiar la nota cambia solo la frecuencia, no el volumen', async () => {
    const r = await analizar(aTension(3.3));
    const nota = (hz: number) => sonidosDelCircuito([{ id: 'bz1', type: 'buzzer-pasivo' }], salidasDe,
      r.tensiones, undefined, () => ({ hz, duty: 0.5 }))[0]!;
    const la = nota(440), si = nota(494);
    expect([la.hz, si.hz]).toEqual([440, 494]);
    expect(la.ganancia).toBeCloseTo(si.ganancia, 6);
  });
});
