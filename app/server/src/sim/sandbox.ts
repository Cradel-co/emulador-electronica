import vm from 'node:vm';
import type { ModeloDiodo, Observacion, Primitiva } from '@emu/shared';

/**
 * Sandbox de los modelos de módulo (el código del `model` del module.json).
 *
 * El código de un módulo importado (de una URL, de GitHub) no es de confianza. Reglas:
 *  - Contexto sin prototipo (`Object.create(null)`) y SIN ningún objeto del server adentro:
 *    lo que el modelo usa (`ctx`, `lectura`) lo define el preludio de abajo, en el propio
 *    sandbox. Entre el server y el modelo solo viajan strings (JSON), así que no hay
 *    referencias del server por las que "escaparse" (el clásico `this.constructor.constructor`).
 *  - Sin `eval`/`new Function`/WebAssembly adentro (`codeGeneration`), sin `require`, sin
 *    `process`, sin red ni disco.
 *  - Tiempo límite por llamada (y las promesas cuentan: `microtaskMode`).
 *  - El código del módulo comparte el contexto con el preludio, así que PUEDE pisarlo: las
 *    validaciones del preludio son solo para dar buenos mensajes. La barrera real es la del
 *    server: solo acepta un string (los errores también se convierten a texto ADENTRO del
 *    sandbox, con el tiempo límite corriendo: un \`get message()\` colgado no traba el server),
 *    con tamaño máximo, y revisa cada elemento entero (tipos, números finitos y con signo
 *    válido, nodos que existen, nombres únicos, cantidad).
 * Es un aislamiento de lenguaje, no de sistema operativo: alcanza para módulos de la comunidad,
 * no para código hostil con exploits de V8.
 */

const TIEMPO_CARGA_MS = 1000;
// Holgado a propósito: con el server cargado, un modelo sano no puede quedar afuera del circuito
// por tardar unos ms de más. Igual corta un bucle infinito enseguida.
const TIEMPO_LLAMADA_MS = 300;
const MAX_ELEMENTOS = 200;
const MAX_SALIDA = 200_000; // caracteres de JSON que puede devolver una llamada

/**
 * Envuelve una expresión para que, pase lo que pase adentro, salga un string "ok:..." o
 * "err:...". Corre en el sandbox (dentro del tiempo límite).
 */
const envolver = (expr: string): string => `(function () {
  try { var __r = (${expr}); return 'ok:' + (typeof __r === 'string' ? __r : ''); }
  catch (e) { try { return 'err:' + String(e && e.message !== undefined ? e.message : e); } catch (_) { return 'err:error desconocido'; } }
})()`;

/** Corre ADENTRO del sandbox. No puede referenciar nada de afuera. */
const PRELUDIO = String.raw`
var module = { exports: {} };
var exports = module.exports;
var console = { log: function () {}, warn: function () {}, error: function () {} };
function __fallo(m) { throw new Error(m); }
function __num(x, que) { if (typeof x !== 'number' || !isFinite(x)) __fallo(que + ' tiene que ser un número finito (vino ' + x + ')'); return x; }
function __pos(x, que) { __num(x, que); if (x <= 0) __fallo(que + ' tiene que ser mayor que cero'); return x; }
function __nodo(x) { if (typeof x !== 'string' || !/^(pin|int):[\w.-]{1,40}$/.test(x)) __fallo('nodo inválido: ' + x + ' (usá ctx.pin("X") o ctx.nodo("x"))'); return x; }
function __congelar(o) { return Object.freeze(o); }
function __ctxCircuito(e) {
  var ops = [], cuenta = 0, nombres = {};
  function nombre(n, pref) {
    var s = n == null ? pref + (++cuenta) : String(n);
    if (!/^[\w.-]{1,40}$/.test(s)) __fallo('nombre de elemento inválido: ' + s);
    if (nombres[s]) __fallo('ya hay un elemento llamado "' + s + '"');
    nombres[s] = true;
    return s;
  }
  function op(o) { if (ops.length >= ${MAX_ELEMENTOS}) __fallo('demasiados elementos (máximo ${MAX_ELEMENTOS})'); ops.push(o); }
  return __congelar({
    props: __congelar(e.props), control: e.control, estado: __congelar(e.estado), vars: __congelar(e.vars),
    pin: function (n) { if (e.pines.indexOf(n) < 0) __fallo('el módulo no tiene el pin "' + n + '". Pines: ' + e.pines.join(', ')); return 'pin:' + n; },
    nodo: function (n) { if (typeof n !== 'string' || !/^[\w.-]{1,40}$/.test(n)) __fallo('nombre de nodo interno inválido: ' + n); return 'int:' + n; },
    resistencia: function (a, b, ohms, n) { op({ tipo: 'R', nombre: nombre(n, 'r'), a: __nodo(a), b: __nodo(b), ohms: __pos(ohms, 'ohms') }); },
    capacitor: function (a, b, f, o, n) { o = o || {}; op({ tipo: 'C', nombre: nombre(n, 'c'), a: __nodo(a), b: __nodo(b), faradios: __pos(f, 'faradios'), v0: o.v0 == null ? undefined : __num(o.v0, 'v0') }); },
    inductor: function (a, b, h, o, n) { o = o || {}; op({ tipo: 'L', nombre: nombre(n, 'l'), a: __nodo(a), b: __nodo(b), henrios: __pos(h, 'henrios'), i0: o.i0 == null ? undefined : __num(o.i0, 'i0') }); },
    diodo: function (a, k, m, n) {
      m = m || {};
      op({ tipo: 'D', nombre: nombre(n, 'd'), a: __nodo(a), b: __nodo(k), modelo: {
        is: __pos(m.is, 'is'), n: __pos(m.n, 'n'),
        rs: m.rs == null ? undefined : __num(m.rs, 'rs'), bv: m.bv == null ? undefined : __pos(m.bv, 'bv'),
        ibv: m.ibv == null ? undefined : __pos(m.ibv, 'ibv') } });
    },
    fuenteTension: function (p, q, v, o, n) {
      o = o || {};
      op({ tipo: 'V', nombre: nombre(n, 'v'), a: __nodo(p), b: __nodo(q), voltios: __num(v, 'voltios'),
        rSerie: o.rSerie == null ? undefined : __pos(o.rSerie, 'rSerie'),
        limiteA: o.limiteA == null ? undefined : __pos(o.limiteA, 'limiteA'), soloEntrega: !!o.soloEntrega });
    },
    fuenteCorriente: function (d, h, i, n) { op({ tipo: 'I', nombre: nombre(n, 'i'), a: __nodo(d), b: __nodo(h), amperios: __num(i, 'amperios') }); },
    interruptor: function (a, b, c, o, n) {
      o = o || {};
      op({ tipo: 'S', nombre: nombre(n, 's'), a: __nodo(a), b: __nodo(b), cerrado: !!c,
        ron: o.ron == null ? undefined : __pos(o.ron, 'ron'), roff: o.roff == null ? undefined : __pos(o.roff, 'roff') });
    },
    interruptorControlado: function (a, b, cp, cn, o, n) {
      o = o || {};
      op({ tipo: 'SV', nombre: nombre(n, 'sv'), a: __nodo(a), b: __nodo(b), cp: __nodo(cp), cn: __nodo(cn),
        umbral: __num(o.umbral, 'umbral'), histeresis: o.histeresis == null ? undefined : __num(o.histeresis, 'histeresis'),
        ron: o.ron == null ? undefined : __pos(o.ron, 'ron'), roff: o.roff == null ? undefined : __pos(o.roff, 'roff') });
    },
    bateria: function (p, q, v, o, n) {
      o = o || {};
      op({ tipo: 'V', nombre: nombre(n, 'bat'), a: __nodo(p), b: __nodo(q), voltios: __pos(v, 'voltios'),
        rSerie: o.rInterna == null ? undefined : __pos(o.rInterna, 'rInterna'), bateria: true });
    },
    regulador: function (e, s, t, o, n) {
      o = o || {};
      var caida = __num(o.caida, 'caida'); if (caida < 0) __fallo('caida no puede ser negativa');
      var iq = o.iq == null ? undefined : __num(o.iq, 'iq'); if (iq !== undefined && iq < 0) __fallo('iq no puede ser negativa');
      op({ tipo: 'REG', nombre: nombre(n, 'reg'), a: __nodo(e), b: __nodo(s), tierra: __nodo(t),
        voltios: __pos(o.voltios, 'voltios'), caida: caida, limiteA: __pos(o.limiteA, 'limiteA'), iq: iq });
    },
    __ops: ops,
  });
}
function __correrCircuito(json) {
  var e = JSON.parse(json);
  if (typeof module.exports.circuito !== 'function') __fallo('el modelo no exporta circuito(ctx)');
  var ctx = __ctxCircuito(e);
  module.exports.circuito(ctx);
  return JSON.stringify(ctx.__ops);
}
function __correrObservar(json) {
  var e = JSON.parse(json);
  if (typeof module.exports.observar !== 'function') return '{}';
  function leer(tabla, k, que) { if (!Object.prototype.hasOwnProperty.call(tabla, k)) __fallo(que + ' "' + k + '" no existe'); return tabla[k]; }
  var l = __congelar({
    props: __congelar(e.props), control: e.control, estado: __congelar(e.estado), vars: __congelar(e.vars),
    v: function (p) { return leer(e.v, p, 'el pin'); },
    vEntre: function (a, b) { return leer(e.v, a, 'el pin') - leer(e.v, b, 'el pin'); },
    i: function (n) { return leer(e.i, n, 'el elemento'); },
    p: function (n) { return leer(e.p, n, 'el elemento'); },
  });
  var o = module.exports.observar(l);
  return JSON.stringify(o == null ? {} : o);
}
`;

export class ErrorModelo extends Error {}

export interface EntradaCircuito {
  pines: string[];
  props: Record<string, string | number | boolean>;
  control: boolean;
  estado: Record<string, unknown>;
  vars: Record<string, string>;
}

export interface EntradaObservar extends Omit<EntradaCircuito, 'pines'> {
  /** Tensión de cada pin. */
  v: Record<string, number>;
  /** Corriente y potencia de cada elemento propio. */
  i: Record<string, number>;
  p: Record<string, number>;
}

/** El código de un módulo, cargado en su propio contexto aislado. */
export class SandboxModelo {
  private readonly ctx: vm.Context;

  constructor(readonly tipo: string, codigo: string) {
    this.ctx = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    });
    // Se compila afuera (vm.Script): un error de sintaxis es un objeto del server, sin trampas.
    let salida: unknown;
    try {
      vm.runInContext(PRELUDIO, this.ctx, { timeout: TIEMPO_CARGA_MS });
      const script = new vm.Script(
        envolver(`(function () {\n${codigo}\n})(), typeof module.exports.circuito === 'function' ? '' : 'el modelo no exporta circuito(ctx)'`),
        { filename: `modules/${tipo}/model.js` },
      );
      salida = script.runInContext(this.ctx, { timeout: TIEMPO_CARGA_MS });
    } catch (err) {
      throw new ErrorModelo(`modelo de "${tipo}": ${mensajeDe(err)}`);
    }
    const r = leerSalida(salida);
    if (r.error !== undefined) throw new ErrorModelo(`modelo de "${tipo}": ${r.error}`);
    if (r.valor !== '') throw new ErrorModelo(`modelo de "${tipo}": ${r.valor}`);
  }

  private llamar(funcion: '__correrCircuito' | '__correrObservar', entrada: unknown): string {
    // El JSON entra como literal de string: ningún objeto del server cruza al sandbox.
    const codigo = envolver(`${funcion}(${JSON.stringify(JSON.stringify(entrada))})`);
    let salida: unknown;
    try {
      salida = vm.runInContext(codigo, this.ctx, { timeout: TIEMPO_LLAMADA_MS });
    } catch (err) {
      throw new ErrorModelo(`modelo de "${this.tipo}": ${mensajeDe(err)}`);
    }
    const r = leerSalida(salida);
    if (r.error !== undefined) throw new ErrorModelo(`modelo de "${this.tipo}": ${r.error}`);
    return r.valor;
  }

  circuito(entrada: EntradaCircuito): Primitiva[] {
    return validarPrimitivas(this.json(this.llamar('__correrCircuito', entrada)), this.tipo, entrada.pines);
  }

  observar(entrada: EntradaObservar): Observacion {
    return validarObservacion(this.json(this.llamar('__correrObservar', entrada)), this.tipo);
  }

  private json(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      throw new ErrorModelo(`modelo de "${this.tipo}": devolvió algo inválido`);
    }
  }
}

/** Lo que vuelve de `envolver`: solo se acepta un string primitivo (nunca un objeto del sandbox). */
function leerSalida(salida: unknown): { valor: string; error?: undefined } | { valor?: undefined; error: string } {
  if (typeof salida !== 'string') return { error: 'devolvió algo inválido' };
  if (salida.startsWith('err:')) return { error: salida.slice(4, 304) };
  if (!salida.startsWith('ok:')) return { error: 'devolvió algo inválido' };
  if (salida.length > MAX_SALIDA) return { error: 'devolvió demasiados datos' };
  return { valor: salida.slice(3) };
}

/** Mensaje de un error del propio vm (sintaxis, tiempo límite). Se lee sin disparar getters. */
function mensajeDe(err: unknown): string {
  if (err === null || typeof err !== 'object') return 'error desconocido';
  if ((Object.getOwnPropertyDescriptor(err, 'code')?.value as unknown) === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
    return 'tardó demasiado (¿un bucle infinito?)';
  }
  const m: unknown = Object.getOwnPropertyDescriptor(err, 'message')?.value;
  return typeof m === 'string' ? m.slice(0, 300) : 'error desconocido';
}

const NODO_RE = /^(pin|int):[\w.-]{1,40}$/;
const NOMBRE_RE = /^[\w.-]{1,40}$/;
const finito = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** La barrera real: lo que vuelve del sandbox se revisa entero antes de ir al motor. */
export function validarPrimitivas(crudo: unknown, tipo: string, pines: string[]): Primitiva[] {
  if (!Array.isArray(crudo)) throw new ErrorModelo(`modelo de "${tipo}": circuito() no devolvió elementos`);
  if (crudo.length > MAX_ELEMENTOS) throw new ErrorModelo(`modelo de "${tipo}": demasiados elementos (máximo ${MAX_ELEMENTOS})`);
  const nombres = new Set<string>();
  return crudo.map((x): Primitiva => {
    const p = (x !== null && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const malo = (que: string): never => {
      throw new ErrorModelo(`modelo de "${tipo}": elemento ${String(p.nombre).slice(0, 40)} inválido (${que})`);
    };
    if (typeof p.nombre !== 'string' || !NOMBRE_RE.test(p.nombre) || nombres.has(p.nombre)) malo('nombre');
    const nombre = p.nombre as string;
    nombres.add(nombre);
    const nodo = (k: string): string => {
      const v = p[k];
      if (typeof v !== 'string' || !NODO_RE.test(v)) return malo(`nodo ${k}`);
      if (v.startsWith('pin:') && !pines.includes(v.slice(4))) malo(`el módulo no tiene el pin ${v.slice(4)}`);
      return v;
    };
    const num = (k: string): number => (finito(p[k]) ? (p[k] as number) : malo(k));
    const pos = (k: string): number => { const v = num(k); return v > 0 ? v : malo(`${k} tiene que ser mayor que cero`); };
    const opc = <T>(k: string, f: (k: string) => T): T | undefined => (p[k] === undefined || p[k] === null ? undefined : f(k));
    const a = nodo('a');
    const b = nodo('b');
    // Se arma de nuevo (solo con los campos conocidos): nada extra llega al motor.
    switch (p.tipo) {
      case 'R': return { tipo: 'R', nombre, a, b, ohms: pos('ohms') };
      case 'C': return { tipo: 'C', nombre, a, b, faradios: pos('faradios'), v0: opc('v0', num) };
      case 'L': return { tipo: 'L', nombre, a, b, henrios: pos('henrios'), i0: opc('i0', num) };
      case 'D': {
        const m = (p.modelo !== null && typeof p.modelo === 'object' ? p.modelo : malo('modelo de diodo')) as Record<string, unknown>;
        const q = m;
        const mp = (k: string): number => (finito(q[k]) && (q[k] as number) > 0 ? (q[k] as number) : malo(`modelo de diodo: ${k}`));
        const mo = (k: string): number | undefined => (q[k] === undefined || q[k] === null ? undefined : mp(k));
        const rs = q.rs === undefined || q.rs === null ? undefined : finito(q.rs) && q.rs >= 0 ? q.rs : malo('modelo de diodo: rs');
        return { tipo: 'D', nombre, a, b, modelo: { is: mp('is'), n: mp('n'), rs, bv: mo('bv'), ibv: mo('ibv') } };
      }
      case 'V':
        return { tipo: 'V', nombre, a, b, voltios: num('voltios'), rSerie: opc('rSerie', pos), limiteA: opc('limiteA', pos), soloEntrega: p.soloEntrega === true, bateria: p.bateria === true };
      case 'I': return { tipo: 'I', nombre, a, b, amperios: num('amperios') };
      case 'S':
        if (typeof p.cerrado !== 'boolean') malo('cerrado');
        return { tipo: 'S', nombre, a, b, cerrado: p.cerrado as boolean, ron: opc('ron', pos), roff: opc('roff', pos) };
      case 'SV': {
        const h = opc('histeresis', num);
        if (h !== undefined && h < 0) malo('histeresis');
        return { tipo: 'SV', nombre, a, b, cp: nodo('cp'), cn: nodo('cn'), umbral: num('umbral'), histeresis: h, ron: opc('ron', pos), roff: opc('roff', pos) };
      }
      case 'REG': {
        const caida = num('caida');
        if (caida < 0) malo('caida');
        const iq = opc('iq', num);
        if (iq !== undefined && iq < 0) malo('iq');
        return { tipo: 'REG', nombre, a, b, tierra: nodo('tierra'), voltios: pos('voltios'), caida, limiteA: pos('limiteA'), iq };
      }
      default: return malo('tipo');
    }
  });
}

export function validarObservacion(crudo: unknown, tipo: string): Observacion {
  const o = (crudo ?? {}) as Record<string, unknown>;
  const out: Observacion = {};
  if (o.ui && typeof o.ui === 'object') {
    const ui = o.ui as Record<string, unknown>;
    out.ui = {};
    if (typeof ui.on === 'boolean') out.ui.on = ui.on;
    if (finito(ui.brillo)) out.ui.brillo = Math.max(0, Math.min(1, ui.brillo));
  }
  if (Array.isArray(o.avisos)) {
    out.avisos = o.avisos.slice(0, 10).flatMap((a) => {
      const x = a as Record<string, unknown>;
      if ((x?.severidad !== 'peligro' && x?.severidad !== 'advertencia') || typeof x.mensaje !== 'string') return [];
      return [{ severidad: x.severidad, mensaje: x.mensaje.slice(0, 300) }];
    });
  }
  if (o.estado && typeof o.estado === 'object') {
    const s = JSON.stringify(o.estado);
    if (s.length > 4000) throw new ErrorModelo(`modelo de "${tipo}": estado demasiado grande`);
    out.estado = JSON.parse(s) as Record<string, unknown>;
  }
  return out;
}
