import { beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito } from './analisis.js';
import { modeloDe } from './modelos.js';
import { ErrorModelo, SandboxModelo, type EntradaCircuito } from './sandbox.js';
import { precalentar } from './spice.js';

/**
 * El código de un módulo importado no es de confianza: no tiene que poder tocar el server,
 * colgarlo, ni meterle al motor algo que no sea un elemento físico válido.
 */

const ENTRADA: EntradaCircuito = { pines: ['1', '2'], props: {}, control: false, estado: {}, vars: {} };
const OBS = { props: {}, control: false, estado: {}, vars: {}, v: { '1': 5, '2': 0 }, i: { r: 0.005 }, p: { r: 0.025 } };

/** Un modelo que codifica en el valor de una resistencia lo que ve adentro del sandbox. */
const espia = (expr: string) => `module.exports = { circuito(ctx) { var x; try { x = (${expr}); } catch (e) { x = 'tiro'; }
  ctx.resistencia(ctx.pin('1'), ctx.pin('2'), x === 'tiro' ? 1 : x === undefined ? 2 : 3, 'r'); } };`;
const ohmsDe = (codigo: string) => (new SandboxModelo('espia', codigo).circuito(ENTRADA)[0] as { ohms: number }).ohms;
const TIRO = 1;
const UNDEF = 2;

const sb = (codigo: string) => new SandboxModelo('prueba', codigo);
/** Modelo que pisa el preludio y le devuelve al server lo que quiera. */
const crudo = (elementos: unknown) =>
  sb(`__correrCircuito = function () { return ${JSON.stringify(JSON.stringify(elementos))}; }; module.exports = { circuito() {} };`);
const R_OK = { tipo: 'R', nombre: 'r', a: 'pin:1', b: 'pin:2', ohms: 100 };

describe('sandbox: aislamiento', () => {
  it('no ve nada del server: process, require, globalThis de Node, Buffer, módulos', () => {
    for (const e of ['process', 'require', 'Buffer', 'setTimeout', 'setImmediate', 'fetch', 'global', '__dirname', 'module.require']) {
      expect(ohmsDe(espia(`typeof ${e} === 'undefined' ? undefined : 'visible'`)), e).toBe(UNDEF);
    }
  });

  it('el truco del constructor no escapa (this.constructor.constructor, Function de los objetos)', () => {
    expect(ohmsDe(espia(`this.constructor.constructor('return process')()`))).toBe(TIRO);
    expect(ohmsDe(espia(`({}).constructor.constructor('return process')()`))).toBe(TIRO);
    expect(ohmsDe(espia(`ctx.pin.constructor('return process')()`))).toBe(TIRO);
    expect(ohmsDe(espia(`(async function(){}).constructor('return process')()`))).toBe(TIRO);
  });

  it('sin generar código: eval, new Function, setTimeout con string, WebAssembly', () => {
    expect(ohmsDe(espia(`eval('1 + 1')`))).toBe(TIRO);
    expect(ohmsDe(espia(`new Function('return 1')()`))).toBe(TIRO);
    // Un módulo wasm mínimo (cabecera válida): compilarlo tiene que estar prohibido.
    expect(ohmsDe(espia(`new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))`))).toBe(TIRO);
  });

  it('import() dinámico no carga nada (ni aunque espere la promesa)', () => {
    const codigo = `var cargado; try { import('node:fs').then(function (m) { cargado = m; }, function () {}); } catch (e) {}
      module.exports = { circuito(ctx) { ctx.resistencia(ctx.pin('1'), ctx.pin('2'), cargado === undefined ? 2 : 3, 'r'); } };`;
    const s = new SandboxModelo('import', codigo);
    s.circuito(ENTRADA);
    expect((s.circuito(ENTRADA)[0] as { ohms: number }).ohms).toBe(UNDEF);
  });

  it('ensuciar prototipos adentro no afecta al server ni a otros módulos', () => {
    // (Romper JSON o Array adentro solo rompe al propio modelo: es su problema, no del server.)
    sb(`Object.prototype.contaminado = 1; Array.prototype.contaminado = 1; Function.prototype.call = null; globalThis.compartido = 1;
      module.exports = { circuito() {} };`).circuito(ENTRADA);
    expect(({} as Record<string, unknown>).contaminado).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).contaminado).toBeUndefined();
    expect(typeof Function.prototype.call).toBe('function');
    expect(ohmsDe(espia(`globalThis.compartido`))).toBe(UNDEF);
  });

  it('cada instancia arranca limpia: el estado global de un modelo no se mezcla con otro tipo', () => {
    const a = sb(`var n = 0; module.exports = { circuito(ctx) { n++; ctx.resistencia(ctx.pin('1'), ctx.pin('2'), n, 'r'); } };`);
    const b = sb(`var n = 0; module.exports = { circuito(ctx) { n++; ctx.resistencia(ctx.pin('1'), ctx.pin('2'), n, 'r'); } };`);
    a.circuito(ENTRADA);
    a.circuito(ENTRADA);
    expect((b.circuito(ENTRADA)[0] as { ohms: number }).ohms).toBe(1);
  });
});

describe('sandbox: no se puede colgar el server', () => {
  const rapido = (f: () => void) => {
    const t0 = performance.now();
    expect(f).toThrow(/tardó demasiado/);
    expect(performance.now() - t0).toBeLessThan(1500);
  };

  it('bucle infinito al cargar', () => rapido(() => sb(`while (true) {}`)));
  it('bucle infinito en circuito()', () => rapido(() => sb(`module.exports = { circuito() { for (;;) {} } };`).circuito(ENTRADA)));
  it('bucle infinito en observar()', () => {
    const s = sb(`module.exports = { circuito() {}, observar() { while (1) {} } };`);
    rapido(() => s.observar(OBS));
  });
  it('bucle de microtareas (promesas que se encadenan sin fin)', () => {
    rapido(() => sb(`module.exports = { circuito() { (function f() { Promise.resolve().then(f); })(); } };`).circuito(ENTRADA));
  });
  it('un error con un "get message()" que no termina (trampa contra el server)', () => {
    rapido(() => sb(`module.exports = { circuito() { throw { get message() { for (;;) {} } }; } };`).circuito(ENTRADA));
  });
  it('un error con toString colgado, o un valor de retorno con trampas', () => {
    rapido(() => sb(`module.exports = { circuito() { throw { toString() { for (;;) {} } }; } };`).circuito(ENTRADA));
    // Un retorno que no es string ni se convierte: la trampa nunca corre.
    const t0 = performance.now();
    expect(() => sb(`__correrCircuito = function () { return { toString() { for (;;) {} } }; }; module.exports = { circuito() {} };`).circuito(ENTRADA)).toThrow(/inválido/);
    expect(performance.now() - t0).toBeLessThan(500);
  });
  it('recursión infinita: error normal, sin tumbar el proceso', () => {
    expect(() => sb(`module.exports = { circuito() { (function f() { f(); })(); } };`).circuito(ENTRADA)).toThrow(ErrorModelo);
  });
  it('después de un tiempo límite, el modelo se puede volver a llamar', () => {
    const s = sb(`var colgar = true; module.exports = { circuito(ctx) { if (colgar) { colgar = false; for (;;) {} } ctx.resistencia(ctx.pin('1'), ctx.pin('2'), 5, 'r'); } };`);
    expect(() => s.circuito(ENTRADA)).toThrow(/tardó/);
    // El bucle se cortó a la mitad: la variable quedó en false, la segunda llamada anda.
    expect(s.circuito(ENTRADA)).toHaveLength(1);
  });
});

describe('sandbox: errores del modelo, con mensajes útiles', () => {
  it('sintaxis rota, no exporta circuito, o tira un error', () => {
    expect(() => sb(`module.exports = { circuito( {`)).toThrow(/modelo de "prueba"/);
    expect(() => sb(`module.exports = {};`)).toThrow(/no exporta circuito/);
    expect(() => sb(`throw new Error('me rompí al cargar')`)).toThrow(/me rompí al cargar/);
    expect(() => sb(`module.exports = { circuito() { throw new Error('ups'); } };`).circuito(ENTRADA)).toThrow(/ups/);
    expect(() => sb(`module.exports = { circuito() { throw 'texto'; } };`).circuito(ENTRADA)).toThrow(/texto/);
  });

  it('las validaciones del preludio explican qué está mal', () => {
    const con = (cuerpo: string) => () => sb(`module.exports = { circuito(ctx) { ${cuerpo} } };`).circuito(ENTRADA);
    expect(con(`ctx.pin('X')`)).toThrow(/no tiene el pin "X"/);
    expect(con(`ctx.resistencia(ctx.pin('1'), ctx.pin('2'), 0)`)).toThrow(/mayor que cero/);
    expect(con(`ctx.resistencia(ctx.pin('1'), ctx.pin('2'), NaN)`)).toThrow(/número finito/);
    expect(con(`ctx.resistencia(ctx.pin('1'), ctx.pin('2'), Infinity)`)).toThrow(/número finito/);
    expect(con(`ctx.resistencia(ctx.pin('1'), ctx.pin('2'), '100')`)).toThrow(/número finito/);
    expect(con(`ctx.resistencia('1', ctx.pin('2'), 100)`)).toThrow(/nodo inválido/);
    expect(con(`ctx.resistencia(ctx.pin('1'), ctx.pin('2'), 1, 'x'); ctx.resistencia(ctx.pin('1'), ctx.pin('2'), 1, 'x')`)).toThrow(/ya hay un elemento/);
    expect(con(`for (var i = 0; i < 201; i++) ctx.resistencia(ctx.pin('1'), ctx.pin('2'), 1)`)).toThrow(/demasiados elementos/);
    expect(con(`ctx.diodo(ctx.pin('1'), ctx.pin('2'), { is: -1, n: 1 })`)).toThrow(/is/);
    expect(con(`ctx.props.x = 1; if (ctx.props.x) throw new Error('mutable')`)).not.toThrow();
  });

  it('ctx es de solo lectura (props, estado y vars congelados)', () => {
    const s = sb(`'use strict'; module.exports = { circuito(ctx) { ctx.props.ohms = 1; } };`);
    expect(() => s.circuito({ ...ENTRADA, props: { ohms: 100 } })).toThrow(/read only|read-only|not extensible|Cannot assign/i);
  });
});

describe('sandbox: la barrera del server (el modelo pisó el preludio)', () => {
  it('acepta lo válido y descarta campos de más', () => {
    const [r] = crudo([{ ...R_OK, extra: 'cosa', modelo: '\n.include /etc/passwd' }]).circuito(ENTRADA);
    expect(r).toEqual({ tipo: 'R', nombre: 'r', a: 'pin:1', b: 'pin:2', ohms: 100 });
  });

  it.each([
    ['ohms negativa', { ...R_OK, ohms: -5 }],
    ['ohms cero', { ...R_OK, ohms: 0 }],
    ['ohms NaN (llega como null)', { ...R_OK, ohms: null }],
    ['ohms como string', { ...R_OK, ohms: '100' }],
    ['nodo que no es del módulo', { ...R_OK, b: 'pin:GND_DE_OTRO' }],
    ['nodo con inyección SPICE', { ...R_OK, a: 'pin:1 0 1e-9\nV9 1 0 1000' }],
    ['nodo sin prefijo', { ...R_OK, a: '0' }],
    ['nombre con espacios', { ...R_OK, nombre: 'r 0 1' }],
    ['nombre vacío', { ...R_OK, nombre: '' }],
    ['tipo desconocido', { ...R_OK, tipo: 'X' }],
    ['tipo SPICE crudo', { ...R_OK, tipo: '.include' }],
    ['capacitor negativo', { tipo: 'C', nombre: 'c', a: 'pin:1', b: 'pin:2', faradios: -1e-6 }],
    ['inductor cero', { tipo: 'L', nombre: 'l', a: 'pin:1', b: 'pin:2', henrios: 0 }],
    ['diodo sin modelo', { tipo: 'D', nombre: 'd', a: 'pin:1', b: 'pin:2' }],
    ['diodo con rs negativa', { tipo: 'D', nombre: 'd', a: 'pin:1', b: 'pin:2', modelo: { is: 1e-12, n: 1, rs: -1 } }],
    ['diodo con bv cero', { tipo: 'D', nombre: 'd', a: 'pin:1', b: 'pin:2', modelo: { is: 1e-12, n: 1, bv: 0 } }],
    ['fuente con límite negativo', { tipo: 'V', nombre: 'v', a: 'pin:1', b: 'pin:2', voltios: 5, limiteA: -1 }],
    ['fuente con rSerie cero', { tipo: 'V', nombre: 'v', a: 'pin:1', b: 'pin:2', voltios: 5, rSerie: 0 }],
    ['interruptor sin estado', { tipo: 'S', nombre: 's', a: 'pin:1', b: 'pin:2', cerrado: 'si' }],
    ['interruptor con ron negativa', { tipo: 'S', nombre: 's', a: 'pin:1', b: 'pin:2', cerrado: true, ron: -1 }],
    ['controlado sin nodo de control', { tipo: 'SV', nombre: 's', a: 'pin:1', b: 'pin:2', cn: 'pin:2', umbral: 1 }],
    ['controlado con histéresis negativa', { tipo: 'SV', nombre: 's', a: 'pin:1', b: 'pin:2', cp: 'pin:1', cn: 'pin:2', umbral: 1, histeresis: -1 }],
    ['elemento que no es objeto', 42],
    ['elemento nulo', null],
  ])('rechaza: %s', (_, el) => {
    expect(() => crudo([el]).circuito(ENTRADA)).toThrow(ErrorModelo);
  });

  it('rechaza nombres repetidos, demasiados elementos, algo que no es una lista o JSON roto', () => {
    expect(() => crudo([R_OK, R_OK]).circuito(ENTRADA)).toThrow(/nombre/);
    expect(() => crudo(Array.from({ length: 201 }, (_, i) => ({ ...R_OK, nombre: `r${i}` }))).circuito(ENTRADA)).toThrow(/demasiados/);
    expect(() => crudo({ tipo: 'R' }).circuito(ENTRADA)).toThrow(/no devolvió elementos/);
    expect(() => sb(`__correrCircuito = function () { return '[{'; }; module.exports = { circuito() {} };`).circuito(ENTRADA)).toThrow(/inválido/);
    expect(() => sb(`__correrCircuito = function () { return 5; }; module.exports = { circuito() {} };`).circuito(ENTRADA)).toThrow(ErrorModelo);
  });

  it('rechaza una salida gigante (sin parsear megas de JSON)', () => {
    expect(() => sb(`__correrCircuito = function () { return '[' + ' '.repeat(300000) + ']'; }; module.exports = { circuito() {} };`).circuito(ENTRADA)).toThrow(/demasiados datos/);
  });

  it('observar(): solo pasa lo conocido, recorta avisos y textos, acota el brillo y el estado', () => {
    const s = sb(`module.exports = { circuito() {}, observar(l) { return {
      ui: { on: 'si', brillo: 7, color: 'red' },
      avisos: Array.from({ length: 30 }, function () { return { severidad: 'peligro', mensaje: 'x'.repeat(1000) }; })
        .concat([{ severidad: 'otra', mensaje: 'no' }]),
      estado: { n: l.v('1') }, extra: 1 }; } };`);
    const o = s.observar(OBS);
    expect(o.ui).toEqual({ brillo: 1 });
    expect(o.avisos).toHaveLength(10);
    expect(o.avisos![0]!.mensaje).toHaveLength(300);
    expect(o.estado).toEqual({ n: 5 });
    expect(o).not.toHaveProperty('extra');
    const grande = sb(`module.exports = { circuito() {}, observar() { return { estado: { x: 'y'.repeat(5000) } }; } };`);
    expect(() => grande.observar(OBS)).toThrow(/estado demasiado grande/);
  });

  it('observar(): leer un pin o elemento que no existe es un error claro', () => {
    expect(() => sb(`module.exports = { circuito() {}, observar(l) { l.v('NO'); } };`).observar(OBS)).toThrow(/el pin "NO" no existe/);
    expect(() => sb(`module.exports = { circuito() {}, observar(l) { l.i('NO'); } };`).observar(OBS)).toThrow(/el elemento "NO" no existe/);
    expect(sb(`module.exports = { circuito() {} };`).observar(OBS)).toEqual({});
  });
});

describe('un modelo roto dentro del motor', () => {
  let cat: ModuloCatalogo[] = [];
  beforeAll(async () => {
    cat = await loadCatalog();
    await precalentar();
  }, 60_000);

  const proyecto = (): Project => ({
    schemaVersion: 1, name: 't', board: null, language: null, sim: { wifiSsid: 'x', wifiPassword: 'y' },
    modules: [
      { id: 'f', type: 'fuente-regulable', props: { voltage: 5, currentLimitMa: 1000 }, x: 0, y: 0 },
      { id: 'r', type: 'resistor', props: { ohms: 1000 }, x: 0, y: 0 },
    ],
    wires: [{ from: 'f.V', to: 'r.1' }, { from: 'r.2', to: 'f.GND' }],
  });
  const conModelo = (codigo: string) => (t: string) => {
    const d = cat.find((m) => m.type === t);
    return d && t === 'resistor' ? { ...d, modeloCodigo: codigo } : d;
  };

  it('si el model.js no carga, se usa el comportamiento de los flags y se avisa', async () => {
    const def = { ...cat.find((m) => m.type === 'resistor')!, modeloCodigo: 'esto no es JS (' };
    expect(modeloDe(def).error).toMatch(/modelo de "resistor"/);
    const r = await analizarCircuito(proyecto(), conModelo('esto no es JS ('));
    expect(r.avisos.some((a) => a.severidad === 'advertencia' && /su modelo tiene un error/.test(a.mensaje))).toBe(true);
    // Los flags (passthrough + ohms) dan la misma física: 5 mA.
    expect(r.elementos.find((e) => e.id === 'r.r')!.i).toBeCloseTo(0.005, 4);
  });

  it('si el modelo falla al armar el circuito, el módulo queda afuera (abierto) y el resto sigue', async () => {
    const r = await analizarCircuito(proyecto(), conModelo(`module.exports = { circuito() { for (;;) {} } };`));
    expect(r.avisos.some((a) => /su modelo falló/.test(a.mensaje) && /tardó/.test(a.mensaje))).toBe(true);
    expect(r.elementos.filter((e) => e.dueno === 'r')).toEqual([]);
    expect(r.fuentes[0]!.mA).toBeLessThan(0.01);
  });

  it('si observar() falla, la física queda igual y se avisa', async () => {
    const r = await analizarCircuito(proyecto(), conModelo(
      `module.exports = { circuito(ctx) { ctx.resistencia(ctx.pin('1'), ctx.pin('2'), 1000, 'r'); }, observar() { throw new Error('mal'); } };`));
    expect(r.avisos.some((a) => /falló al leer el circuito \(.*mal/.test(a.mensaje))).toBe(true);
    expect(r.elementos.find((e) => e.id === 'r.r')!.i).toBeCloseTo(0.005, 4);
  });

  it('el estado que devuelve observar() vuelve en el próximo cálculo (memoria del módulo)', async () => {
    const buscar = conModelo(`module.exports = {
      circuito(ctx) { ctx.resistencia(ctx.pin('1'), ctx.pin('2'), 1000 * (1 + (ctx.estado.n || 0)), 'r'); },
      observar(l) { return { estado: { n: (l.estado.n || 0) + 1 }, ui: { on: l.estado.n >= 1 } }; } };`);
    const estados = new Map<string, Record<string, unknown>>();
    const ma: number[] = [];
    for (let k = 0; k < 3; k++) {
      const r = await analizarCircuito(proyecto(), buscar, { estados });
      ma.push(r.fuentes[0]!.mA!);
      for (const [id, m] of Object.entries(r.modulos)) if (m.estado) estados.set(id, m.estado);
      expect(r.modulos.r!.ui).toEqual({ on: k >= 1 });
    }
    // 5 V sobre 1 kΩ, 2 kΩ, 3 kΩ: el modelo cambió su resistencia según lo que recordaba.
    expect(ma[0]).toBeCloseTo(5, 1);
    expect(ma[1]).toBeCloseTo(2.5, 1);
    expect(ma[2]).toBeCloseTo(5 / 3, 1);
  });

  it('un modelo no puede romper la física: una "resistencia" que genera energía no existe', async () => {
    // Lo más que puede hacer es declarar una fuente: y entonces la energía igual cierra.
    const r = await analizarCircuito(proyecto(), conModelo(
      `module.exports = { circuito(ctx) { ctx.fuenteTension(ctx.pin('2'), ctx.pin('1'), 3, {}, 'trampa'); } };`));
    const neta = r.elementos.reduce((s, e) => s + e.p, 0);
    expect(Math.abs(neta)).toBeLessThan(1e-6);
  });
});
