import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleInstance, Project, Wire } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { nivelesDeEntrada } from '../circuitEngine.js';
import { construirRed } from '../circuitNetwork.js';
import { solveMNA } from '../solver.js';
import { analizarCircuito, type DireccionPin } from './analisis.js';
import { precalentar } from './spice.js';

/**
 * Los dos motores eléctricos del repo, resolviendo los mismos circuitos:
 *  - el motor ngspice (sim/): el que usa la app;
 *  - el solver de circuito libre del PR #5 (solver.ts + circuitNetwork.ts): MNA escrito a mano.
 * Están hechos de formas completamente distintas. Si coinciden, es una garantía fuerte de que los
 * dos están bien; si no, este test dice dónde y cuánto.
 *
 * Donde los modelos difieren a propósito, la tolerancia lo dice: el LED es la curva real del
 * diodo (Shockley) en ngspice y una recta con un codo en el solver, así que en LEDs se pide que
 * coincidan dentro del 10 %; en redes de resistencias, fuentes y su límite, casi exacto.
 */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);

beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

type Mod = Omit<ModuleInstance, 'x' | 'y'>;
const mods = (ms: Mod[]): ModuleInstance[] => ms.map((m) => ({ x: 0, y: 0, ...m }));
const w = (from: string, to: string): Wire => ({ from, to });
const SIM = { wifiSsid: 'x', wifiPassword: 'y' };
const sinPlaca = (m: Mod[], c: Wire[]): Project => ({ schemaVersion: 1, name: 't', board: null, language: null, modules: mods(m), wires: c, sim: SIM });
const conPlaca = (m: Mod[], c: Wire[], usb = true): Project => ({
  schemaVersion: 1, name: 't', board: 'esp32-s3-devkitc-1', language: 'micropython',
  modules: mods([{ id: 'board', type: 'esp32-s3-devkitc-1', props: { usb } }, ...m]), wires: c, sim: SIM,
});
const fuente = (id: string, v: number, ma = 10000): Mod => ({ id, type: 'fuente-regulable', props: { voltage: v, currentLimitMa: ma } });
const R = (id: string, ohms: number): Mod => ({ id, type: 'resistor', props: { ohms } });
const LED = (id: string, color = 'red'): Mod => ({ id, type: 'led', props: { color } });

interface Opc { niveles?: Map<number, 0 | 1>; cerrados?: Set<string> }

/** Corriente (A) por un módulo según cada motor. */
async function losDos(p: Project, o: Opc = {}) {
  const ng = await analizarCircuito(p, b, { niveles: o.niveles, cerrados: o.cerrados });
  const sol = solveMNA(construirRed(p, b, { nivelesGpio: o.niveles, cerrados: o.cerrados }).circuit);
  return {
    ngspice: (id: string) => {
      const e = ng.elementos.find((x) => x.dueno === id && (x.local === 'r' || x.local === 'led' || x.local === 'contacto'));
      return e?.i ?? 0;
    },
    solver: (id: string) => sol.branchCurrents[id] ?? 0,
    fuenteNgspice: (id: string) => (ng.fuentes.find((f) => f.id === id)?.mA ?? 0) / 1000,
    fuenteSolver: (id: string) => sol.sourceCurrents[id] ?? 0,
  };
}

describe('los dos motores coinciden', () => {
  it('30 redes de resistencias al azar: cada corriente coincide (±0,5 % o ±1 µA)', async () => {
    let semilla = 777;
    const azar = () => {
      semilla = (semilla * 1103515245 + 12345) % 2 ** 31;
      return semilla / 2 ** 31;
    };
    for (let caso = 0; caso < 30; caso++) {
      const nNodos = 3 + Math.floor(azar() * 5);
      const pinesDe: string[][] = Array.from({ length: nNodos }, (_, i) => (i === 0 ? ['f.GND'] : i === 1 ? ['f.V'] : []));
      const ramas: Mod[] = [];
      const rama = (a: number, c: number) => {
        const id = `r${ramas.length}`;
        ramas.push(R(id, Math.round(10 ** (1.5 + azar() * 3.5))));
        pinesDe[a]!.push(`${id}.1`);
        pinesDe[c]!.push(`${id}.2`);
      };
      for (let i = 1; i < nNodos; i++) rama(i, Math.floor(azar() * i));
      for (let k = Math.floor(azar() * nNodos); k > 0; k--) {
        const a = Math.floor(azar() * nNodos);
        rama(a, (a + 1 + Math.floor(azar() * (nNodos - 1))) % nNodos);
      }
      const cables = pinesDe.flatMap((ps) => ps.slice(1).map((p, i) => w(ps[i]!, p)));
      const r = await losDos(sinPlaca([fuente('f', Math.round((1 + azar() * 11) * 10) / 10), ...ramas], cables));
      for (const x of ramas) {
        const a = r.ngspice(x.id);
        const c = r.solver(x.id);
        expect(Math.abs(a - c), `caso ${caso}, ${x.id}: ngspice ${a} vs solver ${c}`).toBeLessThan(Math.max(1e-6, 5e-3 * Math.abs(a)));
      }
    }
  });

  it('una fuente limitada: los dos entran en CC y entregan exactamente el límite', async () => {
    const r = await losDos(sinPlaca([fuente('f', 12, 50), R('r', 10)], [w('f.V', 'r.1'), w('r.2', 'f.GND')]));
    expect(r.fuenteNgspice('f')).toBeCloseTo(0.05, 3);
    expect(r.fuenteSolver('f')).toBeCloseTo(0.05, 3);
  });

  it('LEDs con resistencia (fuente, GPIO, cátodo en un GPIO en bajo): dentro del 10 %', async () => {
    const casos: [string, Project, Opc][] = [
      ['fuente 5 V + 220 Ω', sinPlaca([fuente('f', 5), LED('l'), R('r', 220)], [w('f.V', 'l.IN'), w('l.GND', 'r.1'), w('r.2', 'f.GND')]), {}],
      ['fuente 5 V + 150 Ω (20 mA)', sinPlaca([fuente('f', 5), LED('l'), R('r', 150)], [w('f.V', 'l.IN'), w('l.GND', 'r.1'), w('r.2', 'f.GND')]), {}],
      ['LED azul, 9 V + 1 kΩ', sinPlaca([fuente('f', 9), LED('l', 'blue'), R('r', 1000)], [w('f.V', 'l.IN'), w('l.GND', 'r.1'), w('r.2', 'f.GND')]), {}],
      ['GPIO7 → LED → 110 Ω', conPlaca([LED('l'), R('r', 110)], [w('board.GPIO7', 'l.IN'), w('l.GND', 'r.1'), w('r.2', 'board.GND')]), { niveles: new Map([[7, 1]]) }],
      ['GPIO7 → 110 Ω → LED → GPIO6 en bajo', conPlaca([LED('l'), R('r', 110)], [w('board.GPIO7', 'r.1'), w('r.2', 'l.IN'), w('l.GND', 'board.GPIO6')]), { niveles: new Map([[7, 1], [6, 0]]) }],
    ];
    for (const [nombre, p, o] of casos) {
      const r = await losDos(p, o);
      const a = r.ngspice('l');
      const c = r.solver('l');
      expect(a, nombre).toBeGreaterThan(0.001);
      expect(Math.abs(a - c) / a, `${nombre}: ngspice ${(a * 1000).toFixed(2)} mA vs solver ${(c * 1000).toFixed(2)} mA`).toBeLessThan(0.1);
    }
  });

  it('LED al revés y pulsador abierto: los dos dicen que no pasa nada', async () => {
    const reves = await losDos(sinPlaca([fuente('f', 3), LED('l'), R('r', 220)], [w('f.V', 'l.GND'), w('l.IN', 'r.1'), w('r.2', 'f.GND')]));
    expect(Math.abs(reves.ngspice('l'))).toBeLessThan(1e-6);
    expect(Math.abs(reves.solver('l'))).toBeLessThan(1e-6);
    const p = sinPlaca([fuente('f', 5), { id: 'btn1', type: 'button', props: {} }, LED('l'), R('r', 220)],
      [w('f.V', 'btn1.OUT'), w('btn1.GND', 'l.IN'), w('l.GND', 'r.1'), w('r.2', 'f.GND')]);
    const abierto = await losDos(p);
    expect(Math.abs(abierto.ngspice('l'))).toBeLessThan(1e-6);
    expect(Math.abs(abierto.solver('l'))).toBeLessThan(1e-6);
    const cerrado = await losDos(p, { cerrados: new Set(['btn1']) });
    expect(Math.abs(cerrado.ngspice('l') - cerrado.solver('l')) / cerrado.ngspice('l')).toBeLessThan(0.1);
  });

  it('lo que lee el programa en un pulsador con pull-up: los dos leen lo mismo', async () => {
    const p = conPlaca([{ id: 'btn1', type: 'button', props: {} }], [w('board.GPIO6', 'btn1.OUT'), w('btn1.GND', 'board.GND')]);
    const dir = new Map<number, DireccionPin>([[6, { salida: false, pull: 'up' }]]);
    for (const cerrados of [new Set<string>(), new Set(['btn1'])]) {
      const ng = await analizarCircuito(p, b, { cerrados, direcciones: dir });
      const solver = nivelesDeEntrada(p, b, new Map(), cerrados, new Map([[6, 'up']]));
      expect(ng.entradas.find((e) => e.gpio === 6)?.nivel).toBe(solver.get(6));
      expect(solver.get(6)).toBe(cerrados.size ? 0 : 1);
    }
  });
});
