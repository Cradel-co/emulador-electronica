import { beforeAll, describe, expect, it } from 'vitest';
import { Netlist } from './netlist.js';
import { correrTransitorio, validarParametrosTransitorio, type ParametrosTransitorio, type SerieElementoTransitorio } from './transitorio.js';
import { correrSpice, precalentar } from './spice.js';

beforeAll(precalentar, 60_000);
const parametros: ParametrosTransitorio = { pasoS: 1e-5, duracionS: 0.005, inicializacion: 'explicita' };
const muestra = (valores: number[], k: number): number => {
  const valor = valores[k];
  if (valor === undefined) throw new Error(`Falta muestra ${k}`);
  return valor;
};
const elemento = (r: { elementos: Record<string, SerieElementoTransitorio> }, id: string): SerieElementoTransitorio => {
  const e = r.elementos[id];
  if (!e) throw new Error(`Falta elemento ${id}`);
  return e;
};
const integrar = (t: number[], p: number[]): number => {
  let total = 0;
  for (let k = 1; k < t.length; k++) total += (muestra(p, k) + muestra(p, k - 1)) / 2 * (muestra(t, k) - muestra(t, k - 1));
  return total;
};
const rc = (v0?: number): Netlist => {
  const n = new Netlist('RC');
  n.agregar('m', { tipo: 'R', nombre: 'r', a: 'a', b: '0', ohms: 1000 });
  n.agregar('m', { tipo: 'C', nombre: 'c', a: 'a', b: '0', faradios: 1e-6, v0 });
  return n;
};

it('RC: descarga exponencial con IC explícita y energía disipada coherente', async () => {
  const r = await correrTransitorio(rc(1), parametros);
  const c = elemento(r, 'm.c');
  for (const [k, t] of r.t.entries()) expect(Math.abs(muestra(c.v, k) - Math.exp(-t / 0.001))).toBeLessThan(0.002);
  const calor = integrar(r.t, elemento(r, 'm.r').p);
  const almacenada = 0.5e-6 * muestra(c.v, r.t.length - 1) ** 2;
  expect(Math.abs(calor + almacenada - 0.5e-6) / 0.5e-6).toBeLessThan(0.005);
  expect(integrar(r.t, c.p)).toBeLessThan(0); // el capacitor entrega su energía al resistor
});
it('RL: respeta corriente inicial y decaimiento L/R con energía conservada', async () => {
  const n = new Netlist('RL');
  n.agregar('m', { tipo: 'R', nombre: 'r', a: 'a', b: '0', ohms: 10 });
  n.agregar('m', { tipo: 'L', nombre: 'l', a: 'a', b: '0', henrios: 0.01, i0: 1 });
  const r = await correrTransitorio(n, parametros);
  const l = elemento(r, 'm.l');
  for (const [k, t] of r.t.entries()) expect(Math.abs(muestra(l.i, k) - Math.exp(-t / 0.001))).toBeLessThan(0.002);
  const calor = integrar(r.t, elemento(r, 'm.r').p);
  const almacenada = 0.005 * muestra(l.i, r.t.length - 1) ** 2;
  expect(Math.abs(calor + almacenada - 0.005) / 0.005).toBeLessThan(0.005);
});
it('RLC: oscilación amortiguada y balance de energía independiente', async () => {
  const n = new Netlist('RLC');
  n.agregar('m', { tipo: 'R', nombre: 'r', a: 'a', b: 'b', ohms: 10 });
  n.agregar('m', { tipo: 'L', nombre: 'l', a: 'b', b: '0', henrios: 0.01, i0: 0 });
  n.agregar('m', { tipo: 'C', nombre: 'c', a: 'a', b: '0', faradios: 1e-4, v0: 1 });
  const r = await correrTransitorio(n, parametros);
  const c = elemento(r, 'm.c'), l = elemento(r, 'm.l');
  const wd = Math.sqrt(1e6 - 250000);
  for (const [k, t] of r.t.entries()) {
    const esperada = Math.exp(-500 * t) * (Math.cos(wd * t) + 500 / wd * Math.sin(wd * t));
    expect(Math.abs(muestra(c.v, k) - esperada)).toBeLessThan(0.002);
  }
  const calor = integrar(r.t, elemento(r, 'm.r').p);
  const energia = 0.5e-4 * muestra(c.v, r.t.length - 1) ** 2 + 0.005 * muestra(l.i, r.t.length - 1) ** 2;
  expect(Math.abs(calor + energia - 0.5e-4) / 0.5e-4).toBeLessThan(0.005);
});
it('la IC ausente no se inventa y el override explícito no altera .op', async () => {
  const n = rc();
  await expect(correrTransitorio(n, parametros)).rejects.toThrow(/inicial/i);
  const op = n.texto();
  const r = await correrTransitorio(n, { ...parametros, condicionesIniciales: { 'm.c': 2 } });
  expect(muestra(elemento(r, 'm.c').v, 0)).toBeGreaterThan(1.99);
  expect(n.texto()).toBe(op);
  expect(op).toContain('\n.op\n');
  expect(n.resolver(await correrSpice(op)).every(e => Math.abs(e.va - e.vb) < 1e-10)).toBe(true);
});
it('equilibrio obtiene DC y omite IC del modelo en vez de fingir descarga', async () => {
  const r = await correrTransitorio(rc(1), { ...parametros, inicializacion: 'equilibrio' });
  expect(r.t[0]).toBe(0);
  expect(elemento(r, 'm.c').v.every(v => Math.abs(v) < 1e-10)).toBe(true);
});
it('fuente PWL: rampa RC coincide con solución analítica y conserva orientación de potencia', async () => {
  const n = new Netlist('RC rampa');
  n.agregar('m', { tipo: 'V', nombre: 'fuente', a: 'vin', b: '0', voltios: 9 });
  n.agregar('m', { tipo: 'R', nombre: 'r', a: 'vin', b: 'a', ohms: 1000 });
  n.agregar('m', { tipo: 'C', nombre: 'c', a: 'a', b: '0', faradios: 1e-6 });
  const r = await correrTransitorio(n, { ...parametros, inicializacion: 'equilibrio', estimulos: { 'm.fuente': [{ t: 0, valor: 0 }, { t: 0.005, valor: 5 }] } });
  const c = elemento(r, 'm.c');
  for (const [k, t] of r.t.entries()) {
    const tau = 1000.001e-6;
    expect(Math.abs(muestra(c.v, k) - 1000 * (t - tau * (1 - Math.exp(-t / tau))))).toBeLessThan(0.001);
  }
  expect(integrar(r.t, elemento(r, 'm.fuente').p)).toBeLessThan(0);
  expect(r.t.at(-1)).toBeCloseTo(parametros.duracionS, 12);
});

describe('validación y presupuestos antes de ejecutar ngspice', () => {
  it.each([0, -1, NaN, Infinity])('rechaza paso inválido %s', pasoS => {
    expect(() => validarParametrosTransitorio({ ...parametros, pasoS })).toThrow();
  });
  it.each([0, -1, NaN, Infinity])('rechaza duración inválida %s', duracionS => {
    expect(() => validarParametrosTransitorio({ ...parametros, duracionS })).toThrow();
  });
  it('rechaza exceso de muestras e IC incompatibles con equilibrio', () => {
    expect(() => validarParametrosTransitorio({ ...parametros, pasoS: 1e-12 })).toThrow(/muestras/);
    expect(() => validarParametrosTransitorio({ ...parametros, inicializacion: 'equilibrio', condicionesIniciales: { 'm.c': 0 } })).toThrow(/inicial/i);
    expect(() => validarParametrosTransitorio({ ...parametros, condicionesIniciales: { 'm.c': NaN } })).toThrow(/finita/);
  });
  it.each([
    [{ t: 1e-3, valor: 0 }, { t: 0.005, valor: 1 }],
    [{ t: 0, valor: 0 }, { t: 0, valor: 1 }],
    [{ t: 0, valor: 0 }, { t: 0.01, valor: 1 }],
    [{ t: 0, valor: 0 }, { t: 0.005, valor: NaN }],
    [],
  ].map(puntos => ({ puntos })))('rechaza PWL inválida', ({ puntos }) => {
    expect(() => validarParametrosTransitorio({ ...parametros, estimulos: { 'm.fuente': puntos } })).toThrow();
  });
  it('rechaza referencias inventadas y cambios de polaridad de CV/CC', async () => {
    await expect(correrTransitorio(rc(1), { ...parametros, condicionesIniciales: { 'inexistente.c': 1 } })).rejects.toThrow(/desconocido/);
    const puntos = [{ t: 0, valor: 1 }, { t: 0.005, valor: -1 }];
    await expect(correrTransitorio(rc(1), { ...parametros, estimulos: { 'm.r': puntos } })).rejects.toThrow(/desconocida/);
    const n = rc(1);
    n.agregar('m', { tipo: 'V', nombre: 'fuente', a: 'a', b: '0', voltios: 1, limiteA: 1 });
    await expect(correrTransitorio(n, { ...parametros, estimulos: { 'm.fuente': puntos } })).rejects.toThrow(/polaridad/);
  });
  it('rechaza exceso de elementos y presupuesto agregado aunque los límites individuales permitan el pedido', () => {
    const n = new Netlist('grande');
    for (let k = 0; k < 256; k++) n.agregar('m', { tipo: 'R', nombre: `r${k}`, a: `a${k}`, b: '0', ohms: 1000 });
    expect(() => n.textoTransitorio({ ...parametros, pasoS: 1e-6, inicializacion: 'equilibrio' })).toThrow(/presupuesto|valores/i);
    n.agregar('m', { tipo: 'R', nombre: 'extra', a: 'a', b: '0', ohms: 1000 });
    expect(() => n.textoTransitorio(parametros)).toThrow(/256/);
  });
  it('cuenta v/i/p derivadas aunque los vectores crudos compartan pocos nodos', () => {
    const n = new Netlist('resistencias en paralelo');
    for (let k = 0; k < 100; k++) n.agregar('m', { tipo: 'R', nombre: `r${k}`, a: 'a', b: '0', ohms: 1000 });
    expect(() => n.textoTransitorio({ ...parametros, pasoS: 1e-6, inicializacion: 'equilibrio' })).toThrow(/presupuesto|valores/i);
  });
  it('cuenta nodos de control y medidores en el límite de vectores antes de ejecutar', () => {
    const n = new Netlist('interruptores controlados');
    for (let k = 0; k < 205; k++) n.agregar('m', { tipo: 'SV', nombre: `s${k}`, a: `a${k}`, b: `b${k}`, cp: `c${k}`, cn: `d${k}`, umbral: 1 });
    expect(() => n.textoTransitorio({ ...parametros, pasoS: 0.005, inicializacion: 'equilibrio' })).toThrow(/vectores/);
  });
});
