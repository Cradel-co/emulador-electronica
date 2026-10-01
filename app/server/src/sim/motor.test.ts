import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleInstance, Project, Wire } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito, type AnalisisCircuito, type OpcionesAnalisis } from './analisis.js';
import { precalentar } from './spice.js';

/**
 * Verificación del motor eléctrico (ngspice + modelos de módulo) contra la física: cada caso
 * compara con la fórmula analítica y además exige que se cumplan Kirchhoff (corrientes en cada
 * nodo) y la conservación de la energía en TODO el circuito resuelto.
 */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);

beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

const SIM = { wifiSsid: 'x', wifiPassword: 'y', autoReload: false };
type Mod = Omit<ModuleInstance, 'x' | 'y'> & { x?: number; y?: number };
const mods = (ms: Mod[]): ModuleInstance[] => ms.map((m) => ({ x: 0, y: 0, ...m }));
const w = (from: string, to: string): Wire => ({ from, to });

function sinPlaca(modulos: Mod[], cables: Wire[]): Project {
  return { schemaVersion: 1, name: 't', board: null, language: null, modules: mods(modulos), wires: cables, sim: SIM };
}
function conPlaca(placa: string, modulos: Mod[], cables: Wire[], propsPlaca: Record<string, boolean> = { usb: true }): Project {
  return {
    schemaVersion: 1, name: 't', board: placa, language: 'micropython',
    modules: mods([{ id: 'board', type: placa, props: propsPlaca }, ...modulos]), wires: cables, sim: SIM,
  };
}
const fuente = (id: string, voltage: number, currentLimitMa = 1000): Mod => ({ id, type: 'fuente-regulable', props: { voltage, currentLimitMa } });
const R = (id: string, ohms: number): Mod => ({ id, type: 'resistor', props: { ohms } });
const led = (id: string, color = 'red'): Mod => ({ id, type: 'led', props: { color } });

/** Kirchhoff de corrientes en cada nodo y conservación de la energía, sobre todo lo resuelto. */
function invariantes(r: AnalisisCircuito): void {
  expect(r.elementos.length).toBeGreaterThan(0);
  const entra = new Map<string, number>();
  const escala = new Map<string, number>();
  for (const e of r.elementos) {
    entra.set(e.a, (entra.get(e.a) ?? 0) - e.i);
    entra.set(e.b, (entra.get(e.b) ?? 0) + e.i);
    escala.set(e.a, (escala.get(e.a) ?? 0) + Math.abs(e.i));
    escala.set(e.b, (escala.get(e.b) ?? 0) + Math.abs(e.i));
  }
  for (const [nodo, suma] of entra) {
    expect(Math.abs(suma), `Kirchhoff en el nodo ${nodo}`).toBeLessThan(1e-3 * (escala.get(nodo) ?? 0) + 1e-6);
  }
  const neta = r.elementos.reduce((s, e) => s + e.p, 0);
  const bruta = r.elementos.reduce((s, e) => s + Math.abs(e.p), 0);
  expect(Math.abs(neta), 'conservación de la energía').toBeLessThan(1e-3 * bruta + 1e-9);
}

const corriente = (r: AnalisisCircuito, id: string) => r.elementos.find((e) => e.id === id)!.i;
const V = (r: AnalisisCircuito, ref: string) => r.tensiones[ref]!;
async function analizar(p: Project, o: OpcionesAnalisis = {}): Promise<AnalisisCircuito> {
  const r = await analizarCircuito(p, b, o);
  invariantes(r);
  return r;
}

/** Resolución lineal (Gauss) para verificar redes con la fórmula, sin depender del motor. */
function resolverLineal(A: number[][], y: number[]): number[] {
  const n = y.length;
  const M = A.map((fila, i) => [...fila, y[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let f = c + 1; f < n; f++) if (Math.abs(M[f]![c]!) > Math.abs(M[p]![c]!)) p = f;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let f = 0; f < n; f++) {
      if (f === c) continue;
      const k = M[f]![c]! / M[c]![c]!;
      for (let j = c; j <= n; j++) M[f]![j]! -= k * M[c]![j]!;
    }
  }
  return M.map((fila, i) => fila[n]! / fila[i]!);
}

// La fuente de laboratorio regula con ~3 mV de error (como una real).
const TOL_V = 0.006;

describe('leyes fundamentales (Ohm, Kirchhoff, mallas, superposición)', () => {
  it('divisor resistivo: V(medio) = V·R2/(R1+R2), I = V/(R1+R2)', async () => {
    const r = await analizar(sinPlaca([fuente('f', 9), R('r1', 1000), R('r2', 2000)],
      [w('f.V', 'r1.1'), w('r1.2', 'r2.1'), w('r2.2', 'f.GND')]));
    expect(V(r, 'r1.2')).toBeCloseTo(9 * 2000 / 3000, 2);
    expect(corriente(r, 'r1.r') * 1000).toBeCloseTo(3, 2);
    expect(r.fuentes[0]).toMatchObject({ modo: 'CV' });
  });

  it('serie de tres resistencias: la suma de las caídas es la tensión de la fuente (Kirchhoff de tensiones)', async () => {
    const r = await analizar(sinPlaca([fuente('f', 12), R('a', 100), R('b', 220), R('c', 680)],
      [w('f.V', 'a.1'), w('a.2', 'b.1'), w('b.2', 'c.1'), w('c.2', 'f.GND')]));
    const I = corriente(r, 'a.r');
    expect(I).toBeCloseTo(12 / 1000, 4);
    const caidas = (V(r, 'f.V') - V(r, 'a.2')) + (V(r, 'a.2') - V(r, 'b.2')) + (V(r, 'b.2') - V(r, 'f.GND'));
    expect(caidas).toBeCloseTo(V(r, 'f.V') - V(r, 'f.GND'), 9);
  });

  it('paralelo: la corriente total se reparte en proporción inversa a cada resistencia', async () => {
    const r = await analizar(sinPlaca([fuente('f', 6), R('a', 1000), R('b', 1000), R('c', 2000)],
      [w('f.V', 'a.1'), w('f.V', 'b.1'), w('f.V', 'c.1'), w('a.2', 'f.GND'), w('b.2', 'f.GND'), w('c.2', 'f.GND')]));
    expect(corriente(r, 'a.r') * 1000).toBeCloseTo(6, 1);
    expect(corriente(r, 'c.r') * 1000).toBeCloseTo(3, 1);
    expect(r.fuentes[0]!.mA!).toBeCloseTo(15, 1); // 6/(1k‖1k‖2k = 400 Ω)
  });

  it('puente de Wheatstone desbalanceado: la corriente del puente coincide con la resolución por nodos', async () => {
    // 10 V; R1 arriba-izq 1k, R2 arriba-der 2k, R3 abajo-izq 2k, R4 abajo-der 1k; puente Rg = 500 Ω.
    const r = await analizar(sinPlaca(
      [fuente('f', 10), R('r1', 1000), R('r2', 2000), R('r3', 2000), R('r4', 1000), R('rg', 500)],
      [w('f.V', 'r1.1'), w('f.V', 'r2.1'), w('r1.2', 'r3.1'), w('r2.2', 'r4.1'), w('r3.2', 'f.GND'), w('r4.2', 'f.GND'),
        w('r1.2', 'rg.1'), w('r2.2', 'rg.2')]));
    const Vf = V(r, 'f.V');
    // Nodos a (entre r1 y r3) y b (entre r2 y r4): ecuaciones de corriente.
    const [va, vb] = resolverLineal(
      [[1 / 1000 + 1 / 2000 + 1 / 500, -1 / 500], [-1 / 500, 1 / 2000 + 1 / 1000 + 1 / 500]],
      [Vf / 1000, Vf / 2000],
    );
    expect(V(r, 'r1.2')).toBeCloseTo(va!, 3);
    expect(V(r, 'r2.2')).toBeCloseTo(vb!, 3);
    expect(corriente(r, 'rg.r')).toBeCloseTo((va! - vb!) / 500, 6);
  });

  it('puente de Wheatstone balanceado: por el puente no circula corriente', async () => {
    const r = await analizar(sinPlaca(
      [fuente('f', 10), R('r1', 1000), R('r2', 2000), R('r3', 1000), R('r4', 2000), R('rg', 500)],
      [w('f.V', 'r1.1'), w('f.V', 'r2.1'), w('r1.2', 'r3.1'), w('r2.2', 'r4.1'), w('r3.2', 'f.GND'), w('r4.2', 'f.GND'),
        w('r1.2', 'rg.1'), w('r2.2', 'rg.2')]));
    expect(Math.abs(corriente(r, 'rg.r'))).toBeLessThan(1e-7);
  });

  it('40 redes de resistencias al azar (mallas, puentes, ramas en paralelo) coinciden nodo a nodo con el análisis nodal', async () => {
    // Generador con semilla: si algo falla, el caso se repite igual.
    let semilla = 12345;
    const azar = () => {
      semilla = (semilla * 1103515245 + 12345) % 2 ** 31;
      return semilla / 2 ** 31;
    };
    for (let caso = 0; caso < 40; caso++) {
      const nNodos = 3 + Math.floor(azar() * 6); // nodo 0 = GND de la fuente, nodo 1 = su V
      const pinesDe: string[][] = Array.from({ length: nNodos }, (_, i) => (i === 0 ? ['f.GND'] : i === 1 ? ['f.V'] : []));
      const ramas: { id: string; a: number; b: number; ohms: number }[] = [];
      const rama = (a: number, b: number) => {
        const id = `r${ramas.length}`;
        const ohms = Math.round(10 ** (1 + azar() * 4)); // 10 Ω a 100 kΩ
        ramas.push({ id, a, b, ohms });
        pinesDe[a]!.push(`${id}.1`);
        pinesDe[b]!.push(`${id}.2`);
      };
      for (let i = 1; i < nNodos; i++) rama(i, Math.floor(azar() * i)); // árbol: todo conectado
      const extras = Math.floor(azar() * nNodos * 1.5);
      for (let k = 0; k < extras; k++) {
        const a = Math.floor(azar() * nNodos);
        const b = (a + 1 + Math.floor(azar() * (nNodos - 1))) % nNodos;
        rama(a, b);
      }
      const vFuente = Math.round((1 + azar() * 11) * 10) / 10;
      const cables = pinesDe.flatMap((ps) => ps.slice(1).map((p, i) => w(ps[i]!, p)));
      const r = await analizar(sinPlaca([fuente('f', vFuente, 10000), ...ramas.map((x) => R(x.id, x.ohms))], cables));

      // Análisis nodal propio: incógnitas = nodos 2..n-1; V0 = 0, V1 = la tensión que dio la fuente.
      const v1 = V(r, 'f.V') - V(r, 'f.GND');
      const fijo = (n: number) => (n === 0 ? 0 : n === 1 ? v1 : null);
      const incog = nNodos - 2;
      const A = Array.from({ length: incog }, () => Array<number>(incog).fill(0));
      const y = Array<number>(incog).fill(0);
      for (const x of ramas) {
        const g = 1 / x.ohms;
        for (const [p, q] of [[x.a, x.b], [x.b, x.a]] as const) {
          if (fijo(p) !== null) continue;
          A[p - 2]![p - 2]! += g;
          if (fijo(q) !== null) y[p - 2]! += g * fijo(q)!;
          else A[p - 2]![q - 2]! -= g;
        }
      }
      const sol = incog > 0 ? resolverLineal(A, y) : [];
      const vNodo = (n: number) => fijo(n) ?? sol[n - 2]!;
      for (const x of ramas) {
        const esperado = (vNodo(x.a) - vNodo(x.b)) / x.ohms;
        expect(Math.abs(corriente(r, `${x.id}.r`) - esperado), `caso ${caso}, ${x.id}`).toBeLessThan(1e-6 + 1e-4 * Math.abs(esperado));
      }
      // Lo que entrega la fuente = lo que sale del nodo 1 por las ramas.
      const sale = ramas.reduce((s, x) => s + (x.a === 1 ? 1 : x.b === 1 ? -1 : 0) * (vNodo(x.a) - vNodo(x.b)) / x.ohms, 0);
      expect(r.fuentes[0]!.mA! / 1000, `caso ${caso}: corriente de la fuente`).toBeCloseTo(sale, 5);
    }
  });

  it('dos fuentes en serie suman sus tensiones (8 V sobre la carga)', async () => {
    const r = await analizar(sinPlaca([fuente('a', 5), fuente('b', 3), R('carga', 1000)],
      [w('b.GND', 'a.V'), w('b.V', 'carga.1'), w('carga.2', 'a.GND')]));
    // Como una fuente de banco real: cada canal regula con unos pocos mV de error (±10 mV en total).
    expect(Math.abs(V(r, 'carga.1') - V(r, 'carga.2') - 8)).toBeLessThan(0.01);
    expect(corriente(r, 'carga.r') * 1000).toBeCloseTo(8, 1);
  });

  it('dos fuentes distintas en paralelo con resistencias (teorema de Millman)', async () => {
    const r = await analizar(sinPlaca([fuente('a', 5), fuente('b', 3), R('r1', 1000), R('r2', 2000), R('rl', 3000)],
      [w('a.V', 'r1.1'), w('b.V', 'r2.1'), w('r1.2', 'rl.1'), w('r2.2', 'rl.1'), w('rl.2', 'a.GND'), w('b.GND', 'a.GND')]));
    const va = V(r, 'a.V');
    const vb = V(r, 'b.V');
    const millman = (va / 1000 + vb / 2000) / (1 / 1000 + 1 / 2000 + 1 / 3000);
    expect(V(r, 'rl.1')).toBeCloseTo(millman, 3);
  });

  it('fuente negativa: la corriente circula al revés, con la misma magnitud', async () => {
    const r = await analizar(sinPlaca([fuente('f', -5), R('r1', 1000)], [w('f.V', 'r1.1'), w('r1.2', 'f.GND')]));
    expect(V(r, 'r1.1')).toBeCloseTo(-5, 1);
    expect(corriente(r, 'r1.r') * 1000).toBeCloseTo(-5, 1);
    expect(r.fuentes[0]).toMatchObject({ modo: 'CV' });
  });

  it('una resistencia que disipa de más avisa (1/4 W)', async () => {
    const r = await analizar(sinPlaca([fuente('f', 12), R('r1', 100)], [w('f.V', 'r1.1'), w('r1.2', 'f.GND')]));
    // 12²/100 = 1,44 W: más del doble de 1/4 W.
    expect(r.avisos.some((a) => a.severidad === 'peligro' && /Resistencia \(r1\).*W/.test(a.mensaje))).toBe(true);
  });
});

describe('fuente de laboratorio CV/CC', () => {
  const carga = (ohms: number, lim: number, v = 5) =>
    sinPlaca([fuente('f', v, lim), R('rl', ohms)], [w('f.V', 'rl.1'), w('rl.2', 'f.GND')]);

  it('CV: con carga liviana entrega el voltaje ajustado', async () => {
    const r = await analizar(carga(1000, 100));
    expect(r.fuentes[0]!.vSalida).toBeCloseTo(5, 2);
    expect(Math.abs(r.fuentes[0]!.vSalida - 5)).toBeLessThan(TOL_V);
    expect(r.fuentes[0]).toMatchObject({ modo: 'CV' });
    expect(r.fuentes[0]!.mA!).toBeCloseTo(5, 1);
  });

  it('CC: si la carga pide más que el límite, entrega el límite y baja la tensión (V = I·R)', async () => {
    const r = await analizar(carga(10, 100));
    const f = r.fuentes[0]!;
    expect(f.modo).toBe('CC');
    expect(f.mA!).toBeCloseTo(100, 0);
    expect(f.vSalida).toBeCloseTo(1, 2); // 100 mA · 10 Ω
    expect(f.demandaMa!).toBeCloseTo(500, -1); // 5 V / 10 Ω, sin límite
    expect(r.avisos.some((a) => /modo CC/.test(a.mensaje))).toBe(true);
  });

  it('cortocircuito directo: modo corto, entrega el límite con ~0 V, y avisa con las puntas del cable', async () => {
    const r = await analizar(sinPlaca([fuente('f', 5, 200)], [w('f.V', 'f.GND')]));
    expect(r.fuentes[0]).toMatchObject({ modo: 'corto' });
    expect(r.fuentes[0]!.mA!).toBeCloseTo(200, 0);
    const aviso = r.avisos.find((a) => a.severidad === 'peligro' && /cortocircuito/.test(a.mensaje));
    expect(aviso?.refs?.sort()).toEqual(['f.GND', 'f.V']);
  });

  it('apagada (proyecto sin placa sin energizar): no entrega nada', async () => {
    const r = await analizarCircuito(carga(100, 500), b, { fuentesApagadas: true });
    expect(r.fuentes[0]).toMatchObject({ modo: 'apagada', mA: 0 });
    expect(Math.abs(V(r, 'rl.1'))).toBeLessThan(1e-6);
  });

  it('el voltaje ajustado se respeta en todo el rango (−12 a 12 V) con carga moderada', async () => {
    for (const v of [-12, -3.3, 0.5, 1.8, 3.3, 5, 9, 12]) {
      const r = await analizar(carga(1000, 1000, v));
      expect(Math.abs(r.fuentes[0]!.vSalida - v), `ajuste ${v} V`).toBeLessThan(TOL_V);
    }
  });
});

describe('LED: diodo real (Shockley), no una caída fija', () => {
  const circuito = (v: number, ohms: number, color = 'red', lim = 1000) =>
    sinPlaca([fuente('f', v, lim), R('r', ohms), led('l', color)], [w('f.V', 'r.1'), w('r.2', 'l.IN'), w('l.GND', 'f.GND')]);

  it('rojo con 220 Ω a 5 V: ~14 mA, Vf ≈ 1,9–2,0 V, y KVL: V_R + Vf = V', async () => {
    const r = await analizar(circuito(5, 220));
    const vf = V(r, 'l.IN') - V(r, 'l.GND');
    expect(vf).toBeGreaterThan(1.85);
    expect(vf).toBeLessThan(2.05);
    expect(r.leds[0]!.mA).toBeCloseTo(((V(r, 'r.1') - V(r, 'l.IN')) / 220) * 1000, 1);
    expect(r.leds[0]!.mA).toBeGreaterThan(12);
    expect(r.leds[0]!.mA).toBeLessThan(15);
    expect(r.leds[0]!.estado).toBe('ok');
    expect(r.modulos.l!.ui).toMatchObject({ on: true });
  });

  it('a la misma corriente nominal, el Vf depende del color (azul ~3 V, rojo ~2 V)', async () => {
    const rojo = await analizar(circuito(5, 150, 'red'));
    const azul = await analizar(circuito(5, 100, 'blue'));
    const vfRojo = V(rojo, 'l.IN') - V(rojo, 'l.GND');
    const vfAzul = V(azul, 'l.IN') - V(azul, 'l.GND');
    expect(vfAzul - vfRojo).toBeGreaterThan(0.8);
  });

  it('la corriente crece exponencialmente con la tensión: por debajo de ~1,5 V un LED rojo casi no conduce', async () => {
    const r = await analizar(sinPlaca([fuente('f', 1.4, 1000), led('l')], [w('f.V', 'l.IN'), w('l.GND', 'f.GND')]));
    expect(r.leds[0]!.mA).toBeLessThan(0.05);
    expect(r.modulos.l!.ui?.on).toBe(false);
  });

  it('polarizado al revés: no conduce; con más de 5 V en inversa, avisa (se daña)', async () => {
    const al_reves = (v: number) => sinPlaca([fuente('f', v, 1000), R('r', 1000), led('l')],
      [w('f.V', 'r.1'), w('r.2', 'l.GND'), w('l.IN', 'f.GND')]);
    const bajo = await analizar(al_reves(3));
    expect(Math.abs(bajo.leds[0]!.mA)).toBeLessThan(0.001);
    expect(bajo.avisos.some((a) => /al revés/.test(a.mensaje))).toBe(false);
    // Una fuente de 5 V al revés: justo en el máximo de hoja de datos, al límite pero no se daña.
    const limite = await analizar(al_reves(5));
    expect(limite.avisos.find((a) => /al revés/.test(a.mensaje))?.severidad).toBe('advertencia');
    const alto = await analizar(al_reves(9));
    expect(alto.avisos.some((a) => a.severidad === 'peligro' && /al revés con [\d,]+ V/.test(a.mensaje))).toBe(true);
  });

  it('sin resistencia a 5 V se quema; detrás de una fuente limitada a 10 mA no (CC)', async () => {
    const directo = sinPlaca([fuente('f', 5, 1000), led('l')], [w('f.V', 'l.IN'), w('l.GND', 'f.GND')]);
    const r = await analizar(directo);
    expect(r.leds[0]!.estado).toBe('se-quema');
    const limitado = sinPlaca([fuente('f', 5, 10), led('l')], [w('f.V', 'l.IN'), w('l.GND', 'f.GND')]);
    const r2 = await analizar(limitado);
    expect(r2.leds[0]!.mA).toBeCloseTo(10, 0);
    expect(r2.leds[0]!.estado).toBe('ok');
    expect(r2.fuentes[0]!.modo).toBe('CC');
  });

  it('rojo y azul en paralelo sin resistencias propias: el rojo (menor Vf) se lleva casi toda la corriente', async () => {
    const r = await analizar(sinPlaca([fuente('f', 5, 1000), R('r', 100), led('rojo', 'red'), led('azul', 'blue')],
      [w('f.V', 'r.1'), w('r.2', 'rojo.IN'), w('r.2', 'azul.IN'), w('rojo.GND', 'f.GND'), w('azul.GND', 'f.GND')]));
    const rojo = r.leds.find((l) => l.id === 'rojo')!.mA;
    const azul = r.leds.find((l) => l.id === 'azul')!.mA;
    expect(rojo).toBeGreaterThan(20);
    expect(azul).toBeLessThan(0.01 * rojo);
  });

  it('dos LEDs en serie: I = (V − 2·Vf) / R', async () => {
    const r = await analizar(sinPlaca([fuente('f', 9, 1000), R('r', 220), led('a'), led('b')],
      [w('f.V', 'r.1'), w('r.2', 'a.IN'), w('a.GND', 'b.IN'), w('b.GND', 'f.GND')]));
    const vfA = V(r, 'a.IN') - V(r, 'a.GND');
    const vfB = V(r, 'b.IN') - V(r, 'b.GND');
    expect(r.leds[0]!.mA).toBeCloseTo(((V(r, 'f.V') - vfA - vfB) / 220) * 1000, 1);
    expect(r.leds[0]!.mA).toBeCloseTo(r.leds[1]!.mA, 3);
  });
});

describe('interruptores (pulsador, llave)', () => {
  const p = () => sinPlaca([fuente('f', 5, 1000), { id: 'btn', type: 'button', props: {} }, R('r', 220), led('l')],
    [w('f.V', 'btn.OUT'), w('btn.GND', 'r.1'), w('r.2', 'l.IN'), w('l.GND', 'f.GND')]);

  it('suelto es un circuito abierto (nada de corriente); apretado, un cable', async () => {
    const suelto = await analizar(p());
    expect(suelto.leds[0]!.mA).toBeLessThan(0.001);
    const apretado = await analizar(p(), { cerrados: new Set(['btn']) });
    expect(apretado.leds[0]!.mA).toBeGreaterThan(12);
    expect(V(apretado, 'btn.OUT') - V(apretado, 'btn.GND')).toBeLessThan(0.002); // ~50 mΩ de contacto
  });

  it('un pulsador entre la salida de la fuente y su GND, apretado, es un cortocircuito', async () => {
    const q = sinPlaca([fuente('f', 5, 300), { id: 'btn', type: 'button', props: {} }], [w('f.V', 'btn.OUT'), w('btn.GND', 'f.GND')]);
    expect((await analizar(q)).fuentes[0]!.modo).toBe('CV');
    expect((await analizar(q, { cerrados: new Set(['btn']) })).fuentes[0]!.modo).toBe('corto');
  });
});

describe('placa: alimentación, rieles, brownout', () => {
  const s3 = 'esp32-s3-devkitc-1';
  const consumoS3 = () => b(s3)!.board!.power!.currentMa;

  it('por USB: el chip anda, 5V ≈ 5 V y 3V3 ≈ 3,3 V', async () => {
    const r = await analizar(conPlaca(s3, [], []));
    expect(r.chipEncendido).toBe(true);
    expect(r.alimentacion).toMatchObject({ estado: 'ok', via: 'usb' });
    const v33 = r.elementos.find((e) => e.id === 'board.ldo')!;
    expect(v33.a).toBeTruthy();
  });

  it('sin USB ni fuente: no anda, y lo dice', async () => {
    const r = await analizar(conPlaca(s3, [], [], { usb: false }));
    expect(r.chipEncendido).toBe(false);
    expect(r.alimentacion.estado).toBe('sin-energia');
    expect(r.avisos[0]!.mensaje).toMatch(/no tiene alimentación/);
  });

  it('fuente de 5 V al pin 5V: anda, y la fuente entrega lo que consume la placa (chip + regulador)', async () => {
    const r = await analizar(conPlaca(s3, [fuente('f', 5, 500)], [w('f.V', 'board.5V'), w('f.GND', 'board.GND')], { usb: false }));
    expect(r.chipEncendido).toBe(true);
    expect(r.alimentacion).toMatchObject({ estado: 'ok', via: 'fuente', fuenteId: 'f', pin: '5V' });
    // El chip toma su consumo del riel de 3,3 V; el regulador lo saca del de 5 V (+ ~5 mA propios).
    expect(r.fuentes[0]!.mA!).toBeGreaterThan(consumoS3());
    expect(r.fuentes[0]!.mA!).toBeLessThan(consumoS3() + 10);
    // El regulador disipa (5 − 3,3)·I: la energía cierra (ver invariantes).
  });

  it('fuente sin su GND unido al de la placa: el circuito no cierra', async () => {
    const r = await analizar(conPlaca(s3, [fuente('f', 5, 500)], [w('f.V', 'board.5V')], { usb: false }));
    expect(r.chipEncendido).toBe(false);
    expect(r.alimentacion.mensaje).toMatch(/GND no está unido/);
  });

  it('fuente de 3,3 V directo al pin 3V3: anda, y el regulador no la "retroalimenta" hacia 5V', async () => {
    const r = await analizar(conPlaca(s3, [fuente('f', 3.3, 500)], [w('f.V', 'board.3V3'), w('f.GND', 'board.GND')], { usb: false }));
    expect(r.chipEncendido).toBe(true);
    expect(r.alimentacion).toMatchObject({ estado: 'ok', entrada: '3v3' });
    const ldo = r.elementos.find((e) => e.id === 'board.ldo')!;
    expect(Math.abs(ldo.i)).toBeLessThan(1e-4);
  });

  it('fuente limitada a 50 mA (la placa pide ~120): entra en CC, cae la tensión y la placa se resetea', async () => {
    const r = await analizar(conPlaca(s3, [fuente('f', 5, 50)], [w('f.V', 'board.5V'), w('f.GND', 'board.GND')], { usb: false }));
    expect(r.chipEncendido).toBe(false);
    expect(r.alimentacion.estado).toBe('baja');
    expect(r.alimentacion.mensaje).toMatch(/limita a 50 mA/);
  });

  it('dropout del regulador: con 3,5 V en el pin 5V el 3V3 cae a ~3,2 V y el chip igual anda (fuera de especificación)', async () => {
    const r = await analizar(conPlaca(s3, [fuente('f', 3.5, 500)], [w('f.V', 'board.5V'), w('f.GND', 'board.GND')], { usb: false }));
    expect(r.chipEncendido).toBe(true);
    expect(r.avisos.some((a) => /fuera de especificación/.test(a.mensaje))).toBe(true);
    // Con 2,5 V ya no alcanza: el 3V3 queda por debajo del brownout.
    const r2 = await analizar(conPlaca(s3, [fuente('f', 2.5, 500)], [w('f.V', 'board.5V'), w('f.GND', 'board.GND')], { usb: false }));
    expect(r2.chipEncendido).toBe(false);
  });

  it('sobretensión (12 V en 5V) o polaridad invertida (−5 V): se quema', async () => {
    for (const v of [12, -5]) {
      const r = await analizar(conPlaca(s3, [fuente('f', v, 500)], [w('f.V', 'board.5V'), w('f.GND', 'board.GND')], { usb: false }));
      expect(r.alimentacion.estado, `${v} V`).toBe('quema');
    }
  });

  it('el 3V3 de la placa cableado a GND: el regulador entrega su límite con ~0 V (corto) y el chip no anda', async () => {
    const r = await analizar(conPlaca(s3, [], [w('board.3V3', 'board.GND')]));
    expect(r.chipEncendido).toBe(false);
    expect(r.avisos.some((a) => a.severidad === 'peligro' && /3V3.*cortocircuito/.test(a.mensaje))).toBe(true);
  });

  it('Arduino Uno por VIN: el regulador de 5 V anda con 7–12 V, y con 6 V entra en dropout', async () => {
    const uno = (v: number) => conPlaca('arduino-uno', [fuente('f', v, 1000)], [w('f.V', 'board.VIN'), w('f.GND', 'board.GND')], { usb: false });
    const r9 = await analizar(uno(9));
    expect(r9.chipEncendido).toBe(true);
    expect(r9.tensiones['f.V']).toBeCloseTo(9, 1);
    const r55 = await analizar(uno(5.5));
    // 5,5 V − 1 V de caída: el riel de 5 V queda en ~4,5 V (anda: brownout a 4 V).
    expect(r55.chipEncendido).toBe(true);
  });
});

describe('pines del microcontrolador', () => {
  const s3 = 'esp32-s3-devkitc-1';

  it('pull-up interno: el pulsador suelto lee ~3,3 V y apretado ~0 V (corriente del pull-up ≈ 3,3 V / 45 kΩ)', async () => {
    const p = conPlaca(s3, [{ id: 'btn', type: 'button', props: {} }], [w('btn.OUT', 'board.GPIO6'), w('btn.GND', 'board.GND')]);
    const suelto = await analizar(p);
    expect(V(suelto, 'board.GPIO6')).toBeGreaterThan(3.2);
    const apretado = await analizar(p, { cerrados: new Set(['btn']) });
    expect(V(apretado, 'board.GPIO6')).toBeLessThan(0.01);
    const pull = apretado.elementos.find((e) => e.id === 'board.pullup6')!;
    expect(pull.i * 1000).toBeCloseTo(3.3 / 45, 2);
  });

  it('GPIO en alto cableado a GND: corto del pin, con las puntas del cable', async () => {
    const p = conPlaca(s3, [led('l')], [w('l.IN', 'board.GPIO7'), w('board.GPIO7', 'board.GND')]);
    const r = await analizar(p, { niveles: new Map([[7, 1]]) });
    const aviso = r.avisos.find((a) => a.pin === 7 && /cortocircuito/.test(a.mensaje));
    expect(aviso?.severidad).toBe('peligro');
    expect(aviso?.refs).toContain('board.GPIO7');
  });

  it('LED directo a un GPIO: sobrecorriente del pin; con 220 Ω, sin avisos', async () => {
    const directo = await analizar(conPlaca(s3, [led('l')], [w('l.IN', 'board.GPIO7'), w('l.GND', 'board.GND')]), { niveles: new Map([[7, 1]]) });
    expect(directo.avisos.some((a) => a.pin === 7)).toBe(true);
    const bien = await analizar(conPlaca(s3, [led('l'), R('r', 220)],
      [w('r.1', 'board.GPIO7'), w('r.2', 'l.IN'), w('l.GND', 'board.GND')]), { niveles: new Map([[7, 1]]) });
    expect(bien.avisos).toEqual([]);
    expect(bien.leds[0]!.mA).toBeGreaterThan(4);
  });

  it('5 V metidos en un GPIO de 3,3 V: conducen los diodos de protección y avisa', async () => {
    const r = await analizar(conPlaca(s3, [fuente('f', 5, 100), R('r', 100)],
      [w('f.V', 'r.1'), w('r.2', 'board.GPIO5'), w('f.GND', 'board.GND')]));
    expect(r.avisos.some((a) => a.pin === 5 && /diodos de protección/.test(a.mensaje))).toBe(true);
  });

  it('un pin en alta impedancia (entrada sin pull) no cierra el circuito: LED de 3V3 al pin, apagado', async () => {
    // El GND del LED va a GPIO7, que no es "su" salida (su IN no va al pin): el chip lo deja como
    // entrada. Una entrada solo tiene los diodos de protección, que acá quedan sin polarizar.
    const p = conPlaca(s3, [led('l'), R('r', 220)], [w('board.3V3', 'r.1'), w('r.2', 'l.IN'), w('l.GND', 'board.GPIO7')]);
    const r = await analizar(p);
    expect(r.chipEncendido).toBe(true);
    expect(r.leds[0]!.mA).toBeLessThan(0.01);
    expect(r.modulos.l!.ui).toMatchObject({ on: false });
    // El pin "flota" cerca del riel (no hay a dónde ir), sin pasar por arriba de 3V3 + 0,6 V.
    expect(V(r, 'board.GPIO7')).toBeLessThan(3.3 + 0.6);
  });
});

describe('módulos activos (consumo y comportamiento de hoja de datos)', () => {
  const s3 = 'esp32-s3-devkitc-1';

  it('relé de 5 V: con la entrada activa la bobina toma ~71 mA y cierra el contacto', async () => {
    const p = conPlaca(s3, [{ id: 'rele', type: 'relay', props: {} }],
      [w('rele.IN', 'board.GPIO4'), w('rele.VCC', 'board.5V'), w('rele.GND', 'board.GND')]);
    const on = await analizar(p, { niveles: new Map([[4, 1]]) });
    const bobina = corriente(on, 'rele.bobina') * 1000;
    expect(bobina).toBeGreaterThan(65);
    expect(bobina).toBeLessThan(75);
    expect(on.modulos.rele!.ui).toMatchObject({ on: true });
    const off = await analizar(p, { niveles: new Map([[4, 0]]) });
    expect(Math.abs(corriente(off, 'rele.bobina'))).toBeLessThan(1e-4);
    expect(off.modulos.rele!.ui).toMatchObject({ on: false });
  });

  it('relé de 5 V alimentado con 3,3 V: la bobina no junta corriente para cerrar, y avisa', async () => {
    const p = conPlaca(s3, [{ id: 'rele', type: 'relay', props: {} }],
      [w('rele.IN', 'board.GPIO4'), w('rele.VCC', 'board.3V3'), w('rele.GND', 'board.GND')]);
    const r = await analizar(p, { niveles: new Map([[4, 1]]) });
    expect(r.modulos.rele!.ui).toMatchObject({ on: false });
    expect(r.avisos.some((a) => /no alcanza para cerrar/.test(a.mensaje))).toBe(true);
  });

  it('RXB6 a 5 V consume ~4,5 mA; con 2,5 V avisa que no alcanza', async () => {
    const p = (v: number) => sinPlaca([fuente('f', v, 500), { id: 'rx', type: 'rxb6', props: {} }], [w('f.V', 'rx.VCC'), w('rx.GND', 'f.GND')]);
    expect((await analizar(p(5))).fuentes[0]!.mA!).toBeCloseTo(4.5, 1);
    expect((await analizar(p(2.5))).avisos.some((a) => /RXB6/.test(a.mensaje))).toBe(true);
  });

  it('STX882: en reposo casi no consume; con DATA en alto transmite (~34 mA a 5 V)', async () => {
    const p = (data: number) => sinPlaca([fuente('f', 5, 500), fuente('d', data, 100), { id: 'tx', type: 'stx882', props: {} }],
      [w('f.V', 'tx.VCC'), w('tx.GND', 'f.GND'), w('d.V', 'tx.DATA'), w('d.GND', 'f.GND')]);
    expect((await analizar(p(0))).fuentes.find((x) => x.id === 'f')!.mA!).toBeLessThan(0.1);
    expect((await analizar(p(3.3))).fuentes.find((x) => x.id === 'f')!.mA!).toBeCloseTo(34, -1);
  });
});

describe('circuito libre (aportes del PR #5 de Marcos): quién maneja un pin lo decide el programa', () => {
  // Estos cuatro circuitos son los de circuitNetwork.test.ts (PR #5), resueltos acá con el motor
  // ngspice. Sus valores difieren un poco de los de ese PR: allá el LED es una caída fija de 2 V
  // más 15 Ω; acá es la curva real del diodo (a ~9 mA un LED rojo cae ~1,93 V, no 2,13 V).
  const s3 = 'esp32-s3-devkitc-1';
  const B = (id = 'btn1'): Mod => ({ id, type: 'button', props: {} });
  const mA = (r: AnalisisCircuito) => r.leds[0]!.mA;
  const sale = (...g: number[]) => new Map(g.map((x) => [x, { salida: true }] as const));

  it('GPIO7 en alto → pulsador → 110 Ω → LED → GND: el pin entrega aunque lo que tenga enchufado sea un pulsador', async () => {
    const p = conPlaca(s3, [led('led1'), B(), R('r1', 110)],
      [w('board.GPIO7', 'btn1.OUT'), w('btn1.GND', 'r1.1'), w('r1.2', 'led1.IN'), w('led1.GND', 'board.GND')]);
    // I = (3,3 − Vf) / (33 del pin + 110 + 2 del LED) con Vf ≈ 1,93 V → ~9,4 mA.
    const apretado = await analizar(p, { niveles: new Map([[7, 1]]), cerrados: new Set(['btn1']) });
    expect(mA(apretado)).toBeGreaterThan(9);
    expect(mA(apretado)).toBeLessThan(10);
    expect(mA(await analizar(p, { niveles: new Map([[7, 1]]), cerrados: new Set() }))).toBeLessThan(0.001);
    expect(mA(await analizar(p, { niveles: new Map([[7, 0]]), cerrados: new Set(['btn1']) }))).toBeLessThan(0.001);
    // Lo mismo si la dirección sale del código (pinMode(7, OUTPUT)) y no del nivel informado.
    expect(mA(await analizar(p, { niveles: new Map([[7, 1]]), direcciones: sale(7), cerrados: new Set(['btn1']) }))).toBeGreaterThan(9);
  });

  it('el cátodo del LED en un GPIO en bajo: el pin hunde la corriente y el LED prende ("active low")', async () => {
    const p = conPlaca(s3, [led('led1'), R('r1', 110)],
      [w('board.GPIO7', 'r1.1'), w('r1.2', 'led1.IN'), w('led1.GND', 'board.GPIO6')]);
    // I = (3,3 − Vf) / (33 + 110 + 2 + 33 del pin que hunde) → ~7,7 mA.
    const r = await analizar(p, { niveles: new Map([[7, 1], [6, 0]]) });
    expect(mA(r)).toBeGreaterThan(7.2);
    expect(mA(r)).toBeLessThan(8.3);
    expect(mA(await analizar(p, { niveles: new Map([[7, 1], [6, 1]]) }))).toBeLessThan(0.001);
  });

  it('circuito continuo sin firmware: fuente 5 V → pulsador → LED → 150 Ω → GND', async () => {
    const p = conPlaca(s3, [fuente('fuente1', 5, 300), B(), led('led1'), R('r1', 150)],
      [w('fuente1.GND', 'board.GND'), w('fuente1.V', 'btn1.OUT'), w('btn1.GND', 'led1.IN'), w('led1.GND', 'r1.1'), w('r1.2', 'board.GND_2')], { usb: false });
    // 150 Ω es justo la resistencia para 20 mA con un LED rojo (Vf = 2 V a 20 mA) a 5 V.
    expect(mA(await analizar(p, { cerrados: new Set(['btn1']) }))).toBeCloseTo(20, 0);
    expect(mA(await analizar(p, { cerrados: new Set() }))).toBeLessThan(0.001);
  });

  it('el clásico: GPIO7 → LED → 110 Ω → GND', async () => {
    const p = conPlaca(s3, [led('led1'), R('r1', 110)],
      [w('board.GPIO7', 'led1.IN'), w('led1.GND', 'r1.1'), w('r1.2', 'board.GND')]);
    expect(mA(await analizar(p, { niveles: new Map([[7, 1]]) }))).toBeCloseTo(9.4, 0);
  });

  it('si el código dice que el pin es una entrada, no maneja nada aunque el puente informe un nivel', async () => {
    // El puente lee el registro de salida de cada pin vigilado: en una entrada informa 0. Si eso se
    // tomara como "salida en bajo", el pin hundiría corriente que en la placa real no hunde.
    const p = conPlaca(s3, [led('led1'), R('r1', 220)], [w('board.3V3', 'r1.1'), w('r1.2', 'led1.IN'), w('led1.GND', 'board.GPIO7')]);
    const r = await analizar(p, { niveles: new Map([[7, 0]]), direcciones: new Map([[7, { salida: false }]]) });
    expect(mA(r)).toBeLessThan(0.01);
  });
});

describe('lo que lee el programa en sus entradas sale del circuito (umbrales reales del chip)', () => {
  const s3 = 'esp32-s3-devkitc-1';
  const entrada = (r: AnalisisCircuito, g: number) => r.entradas.find((e) => e.gpio === g)!;
  const lee = (g: number, pull?: 'up' | 'down') => new Map([[g, { salida: false, pull }]]);

  it('pulsador entre el pin y GND con el pull-up interno: suelto lee 1, apretado lee 0', async () => {
    // El caso más común de todos. Sin modelar el pull-up, el pin suelto quedaría en 0 V y el programa
    // vería el botón apretado todo el tiempo.
    const p = conPlaca(s3, [{ id: 'btn1', type: 'button', props: {} }], [w('board.GPIO6', 'btn1.OUT'), w('btn1.GND', 'board.GND')]);
    const suelto = await analizar(p, { direcciones: lee(6, 'up') });
    expect(entrada(suelto, 6)).toMatchObject({ nivel: 1, flotante: false });
    expect(entrada(suelto, 6).v).toBeCloseTo(3.3, 1);
    const apretado = await analizar(p, { direcciones: lee(6, 'up'), cerrados: new Set(['btn1']) });
    expect(entrada(apretado, 6)).toMatchObject({ nivel: 0, flotante: false });
    expect(entrada(apretado, 6).v).toBeLessThan(0.01);
  });

  it('un mismo interruptor corta la carga y otro pin lo sensa (idea del PR #5)', async () => {
    // GPIO7 (salida) → pulsador → 110 Ω → LED → GND, y GPIO5 leyendo el nodo entre el pulsador y la R.
    const p = conPlaca(s3, [{ id: 'btn1', type: 'button', props: {} }, led('led1'), R('r1', 110)],
      [w('board.GPIO7', 'btn1.OUT'), w('btn1.GND', 'r1.1'), w('r1.2', 'led1.IN'), w('led1.GND', 'board.GND'), w('board.GPIO5', 'btn1.GND')]);
    const dir = new Map([[7, { salida: true }], [5, { salida: false, pull: 'down' as const }]]);
    const cerrado = await analizar(p, { niveles: new Map([[7, 1]]), direcciones: dir, cerrados: new Set(['btn1']) });
    expect(entrada(cerrado, 5).nivel).toBe(1);
    expect(cerrado.leds[0]!.mA).toBeGreaterThan(8);
    const abierto = await analizar(p, { niveles: new Map([[7, 1]]), direcciones: dir });
    expect(entrada(abierto, 5).nivel).toBe(0);
  });

  it('sin pull, ese mismo nodo queda flotando con el pulsador abierto: la lectura es indefinida y se avisa', async () => {
    // Un LED apagado casi no conduce: el nodo queda a merced de fugas de nanoamperes. En la placa real
    // ese pin lee ruido; acá se avisa en vez de inventar un 0 o un 1.
    const p = conPlaca(s3, [{ id: 'btn1', type: 'button', props: {} }], [w('board.GPIO5', 'btn1.OUT'), w('btn1.GND', 'board.GND')]);
    const r = await analizar(p, { direcciones: lee(5) });
    expect(entrada(r, 5).flotante).toBe(true);
    expect(r.avisos.some((a) => a.severidad === 'advertencia' && /flotando/.test(a.mensaje))).toBe(true);
    // Con el pulsador apretado ya no flota: lo fija GND.
    const apretado = await analizar(p, { direcciones: lee(5), cerrados: new Set(['btn1']) });
    expect(entrada(apretado, 5)).toMatchObject({ nivel: 0, flotante: false });
  });

  it('umbrales del ESP32 (0,25·VDD / 0,75·VDD): 2 V no es ni 0 ni 1; 2,6 V es 1; 0,7 V es 0', async () => {
    const p = (v: number) => conPlaca(s3, [fuente('f', v, 100), R('r', 1000)],
      [w('f.V', 'r.1'), w('r.2', 'board.GPIO4'), w('f.GND', 'board.GND')]);
    expect(entrada(await analizar(p(2), { direcciones: lee(4) }), 4).nivel).toBeNull();
    expect(entrada(await analizar(p(2.6), { direcciones: lee(4) }), 4).nivel).toBe(1);
    expect(entrada(await analizar(p(0.7), { direcciones: lee(4) }), 4).nivel).toBe(0);
  });

  it('umbrales del ATmega328P (0,3·VCC / 0,6·VCC a 5 V): 2 V indefinido, 3,2 V es 1, 1,2 V es 0', async () => {
    const p = (v: number) => conPlaca('arduino-uno', [fuente('f', v, 100), R('r', 1000)],
      [w('f.V', 'r.1'), w('r.2', 'board.D2'), w('f.GND', 'board.GND')]);
    expect(entrada(await analizar(p(2), { direcciones: lee(2) }), 2).nivel).toBeNull();
    expect(entrada(await analizar(p(3.2), { direcciones: lee(2) }), 2).nivel).toBe(1);
    expect(entrada(await analizar(p(1.2), { direcciones: lee(2) }), 2).nivel).toBe(0);
  });
});

describe('robustez', () => {
  it('circuito vacío, módulos sin cablear o un LED solo: no rompe y no inventa corriente', async () => {
    for (const p of [
      sinPlaca([], []),
      sinPlaca([led('l'), R('r', 100)], []),
      sinPlaca([fuente('f', 5)], []),
      sinPlaca([led('l')], [w('l.IN', 'l.GND')]),
    ]) {
      const r = await analizarCircuito(p, b);
      expect(r.avisos.filter((a) => a.severidad === 'peligro')).toEqual([]);
      for (const l of r.leds) expect(l.mA).toBeLessThan(1e-6);
    }
  });

  it('una placa que no está en el catálogo no rompe el cálculo', async () => {
    const r = await analizarCircuito(conPlaca('placa-inexistente', [led('l')], [w('l.IN', 'board.GPIO7')]), b);
    expect(Array.isArray(r.avisos)).toBe(true);
  });

  it('rendimiento: un circuito de 30 módulos se resuelve en menos de 300 ms', async () => {
    const ms: Mod[] = [fuente('f', 5, 2000)];
    const ws: Wire[] = [];
    for (let i = 0; i < 15; i++) {
      ms.push(R(`r${i}`, 220 + i * 10), led(`l${i}`, i % 2 ? 'green' : 'red'));
      ws.push(w('f.V', `r${i}.1`), w(`r${i}.2`, `l${i}.IN`), w(`l${i}.GND`, 'f.GND'));
    }
    const p = sinPlaca(ms, ws);
    await analizarCircuito(p, b);
    const t = performance.now();
    const r = await analizarCircuito(p, b);
    expect(performance.now() - t).toBeLessThan(300);
    invariantes(r);
    expect(r.leds.every((l) => l.mA > 5 && l.mA < 15)).toBe(true);
  });
});
