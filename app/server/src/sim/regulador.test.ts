import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleDef, ModuleInstance, Project, Wire } from '@emu/shared';
import { ModuleDefSchema } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito, type AnalisisCircuito } from './analisis.js';
import { precalentar } from './spice.js';

/**
 * `ctx.regulador()` en el SDK de los modelos de módulo: un regulador lineal que saca de su
 * entrada lo que entrega. Antes, un módulo solo podía hacerlo con `fuenteTension`, que crea
 * energía: con la entrada en 0 V la salida seguía en 3,3 V (SDD-MODULOS.md, sección 6, prueba B).
 */

let cat: ModuloCatalogo[] = [];
beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

/** Placa con regulador de 3,3 V (caída 0,25 V, hasta 150 mA, 50 µA propios) y una carga de 330 Ω en su salida. */
const PLACA: ModuleDef & { modeloCodigo: string } = {
  ...ModuleDefSchema.parse({
    type: 'placa-reg', name: 'Placa con regulador', category: 'Pruebas', svg: 'module.svg', model: 'model.js',
    pins: [
      { name: 'VIN', x: 0, y: 0, kind: 'power' },
      { name: '3VO', x: 10, y: 0, kind: 'power' },
      { name: 'GND', x: 20, y: 0, kind: 'ground' },
    ],
  }),
  modeloCodigo: `module.exports = {
    circuito(ctx) {
      ctx.regulador(ctx.pin('VIN'), ctx.pin('3VO'), ctx.pin('GND'), { voltios: 3.3, caida: 0.25, limiteA: 0.15, iq: 50e-6 }, 'ldo');
      ctx.resistencia(ctx.pin('3VO'), ctx.pin('GND'), 330, 'carga');
    },
  };`,
};

const buscar = (t: string) => (t === PLACA.type ? PLACA : cat.find((m) => m.type === t));
const w = (from: string, to: string): Wire => ({ from, to });
const mods = (ms: Omit<ModuleInstance, 'x' | 'y'>[]): ModuleInstance[] => ms.map((m) => ({ x: 0, y: 0, ...m }));

function proyecto(vin: number, extra: Wire[] = []): Project {
  return {
    schemaVersion: 1, name: 't', board: null, language: null, sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false },
    modules: mods([{ id: 'f', type: 'fuente-regulable', props: { voltage: vin, currentLimitMa: 1000 } }, { id: 'p', type: PLACA.type, props: {} }]),
    wires: [w('f.V', 'p.VIN'), w('f.GND', 'p.GND'), ...extra],
  };
}

const el = (r: AnalisisCircuito, local: string) => r.elementos.find((e) => e.dueno === 'p' && e.local === local);
const fuenteMa = (r: AnalisisCircuito) => r.fuentes.find((f) => f.id === 'f')?.mA ?? NaN;

/** Conservación de la energía en todo lo resuelto. */
function energiaCierra(r: AnalisisCircuito): void {
  const neta = r.elementos.reduce((s, e) => s + e.p, 0);
  const bruta = r.elementos.reduce((s, e) => s + Math.abs(e.p), 0);
  expect(Math.abs(neta), 'conservación de la energía').toBeLessThan(1e-3 * bruta + 1e-9);
}

describe('ctx.regulador (regulador lineal de un módulo)', () => {
  it('con 5 V a la entrada regula 3,3 V, y la fuente entrega la carga más su consumo propio', async () => {
    const r = await analizarCircuito(proyecto(5), buscar);
    const carga = el(r, 'carga')!;
    expect(carga.va - carga.vb).toBeCloseTo(3.3, 2);
    expect(fuenteMa(r)).toBeCloseTo((3.3 / 330) * 1000 + 0.05, 1);
    energiaCierra(r);
  });

  it('sin tensión a la entrada no entrega nada: no crea energía de la nada', async () => {
    const r = await analizarCircuito(proyecto(0.0001), buscar);
    const carga = el(r, 'carga')!;
    expect(Math.abs(carga.va - carga.vb)).toBeLessThan(0.01);
    energiaCierra(r);
  });

  it('en caída (dropout): con 3,4 V a la entrada la salida queda en 3,4 − 0,25 V', async () => {
    const r = await analizarCircuito(proyecto(3.4), buscar);
    const carga = el(r, 'carga')!;
    expect(carga.va - carga.vb).toBeCloseTo(3.15, 1);
    energiaCierra(r);
  });

  it('disipa (Vin − Vout)·I: a 12 V calienta más que a 5 V', async () => {
    const a5 = el(await analizarCircuito(proyecto(5), buscar), 'ldo')!;
    const a12 = el(await analizarCircuito(proyecto(12), buscar), 'ldo')!;
    expect(a12.p).toBeGreaterThan(a5.p * 3);
    expect(a12.p).toBeCloseTo((12 - 3.3) * (3.3 / 330), 2);
  });

  it('con la salida en corto entrega su límite de corriente y no más', async () => {
    const r = await analizarCircuito(proyecto(5, [w('p.3VO', 'p.GND')]), buscar);
    expect(fuenteMa(r)).toBeGreaterThan(140);
    expect(fuenteMa(r)).toBeLessThan(160);
    energiaCierra(r);
  });

  it('no devuelve corriente a su entrada: 3,3 V de afuera en la salida y la entrada suelta queda sin tensión', async () => {
    const p: Project = {
      ...proyecto(3.3),
      wires: [w('f.V', 'p.3VO'), w('f.GND', 'p.GND')],
    };
    const r = await analizarCircuito(p, buscar);
    expect(Math.abs(r.tensiones['p.VIN'] ?? 0)).toBeLessThan(0.5);
    energiaCierra(r);
  });

  it('un módulo que no es fuente y usa fuenteTension recibe un aviso (crea energía de la nada)', async () => {
    const trucho = { ...PLACA, type: 'placa-trucha', modeloCodigo: `module.exports = { circuito(ctx) {
      ctx.fuenteTension(ctx.pin('3VO'), ctx.pin('GND'), 3.3, { soloEntrega: true }, 'reg');
      ctx.resistencia(ctx.pin('3VO'), ctx.pin('GND'), 330, 'carga');
    } };` };
    const p = proyecto(0.0001);
    p.modules[1]!.type = trucho.type;
    const r = await analizarCircuito(p, (t) => (t === trucho.type ? trucho : buscar(t)));
    expect(r.avisos.some((a) => /fuenteTension sin ser una fuente/.test(a.mensaje))).toBe(true);
  });
});
