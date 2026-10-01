import vm from 'node:vm';
import type { SalidaChip } from '@emu/shared';

/**
 * Sandbox del comportamiento de un chip (`chips/<id>/<comportamiento>.js`).
 *
 * Mismas reglas que el de los modelos eléctricos (sim/sandbox.ts): contexto sin prototipo y
 * sin objetos del server adentro, sin eval/WebAssembly, tiempo límite por llamada, y entre el
 * server y el chip solo viajan strings (JSON) que se revisan enteros al volver.
 *
 * Dos diferencias, por rendimiento (medido en SDD-MODULOS.md, sección 6, prueba C):
 *  - El estado del chip vive ADENTRO del sandbox (sus variables), no viaja en cada llamada.
 *    Cada instancia del chip tiene su propio contexto.
 *  - Una llamada por TRANSACCIÓN de bus, no por byte: el bus junta los eventos (lo escrito,
 *    lo que hay que leer) y los manda en lote. Lo caro de cada llamada es el vigilante de
 *    tiempo límite de `vm` (~100 µs); el código del chip en sí cuesta unos µs.
 *  - El script que despacha se compila una vez; la entrada entra como string primitivo.
 */

const TIEMPO_CARGA_MS = 1000;
const TIEMPO_LLAMADA_MS = 50;
const MAX_SALIDA = 256_000;
const MAX_LOGS = 20;
const MAX_GUARDADO = 64 * 1024;

/** Un evento para el chip, en orden. `t` = µs de emulación desde que arrancó. */
export type EventoChip =
  | { tipo: 'encender'; t: number; guardado?: unknown }
  | { tipo: 'apagar'; t: number }
  | { tipo: 'escribir'; t: number; bytes: number[] }
  | { tipo: 'leer'; t: number; n: number }
  | { tipo: 'leidos'; t: number; n: number }
  | { tipo: 'tick'; t: number };

export interface ResultadoLote {
  /** Un arreglo de bytes por cada evento `leer`, en orden. */
  lecturas: number[][];
  /** Direcciones I2C en las que responde (7 bits). */
  direcciones: number[];
  /** Hasta qué µs no responde a su dirección (una EEPROM grabando). */
  ocupadoHasta: number;
  /** Lo último que publicó (si publicó algo en este lote). */
  salida?: SalidaChip;
  /** Pines propios que cambió (INT, SQW...): 0, 1, o null = alta impedancia (colector abierto suelto). */
  pines: Record<string, 0 | 1 | null>;
  /** El chip pide que lo llamen (`tick`) en este instante (µs), aunque nadie le hable por el bus. */
  despertarEn: number | null;
  /** Lo que el chip pidió guardar (memoria no volátil: EEPROM, la hora con pila), si guardó algo. */
  guardar?: unknown;
  logs: string[];
}

export class ErrorChip extends Error {}

const envolver = (expr: string): string => `(function () {
  try { var __r = (${expr}); return 'ok:' + (typeof __r === 'string' ? __r : ''); }
  catch (e) { try { return 'err:' + String(e && e.message !== undefined ? e.message : e); } catch (_) { return 'err:error desconocido'; } }
})()`;

/**
 * Corre ADENTRO del sandbox. Arma el `ctx` que ve el chip y `sdk` (ayudas comunes), y
 * despacha los lotes. Nada de acá puede referenciar objetos del server.
 */
const PRELUDIO = String.raw`
var module = { exports: {} };
var exports = module.exports;
var __logs = [];
var console = { log: function () { if (__logs.length < ${MAX_LOGS}) __logs.push(Array.prototype.join.call(arguments, ' ').slice(0, 300)); } };
console.warn = console.log; console.error = console.log;
function __fallo(m) { throw new Error(m); }
var __estado = { t: 0, entorno: {}, props: {}, ocupadoHasta: 0, salida: undefined, publico: false, pines: {}, despertar: null,
  guardado: null, guardar: undefined, guardo: false };
var ctx = Object.freeze({
  get t() { return __estado.t; },
  /** Milisegundos de emulación (con decimales). */
  get ms() { return __estado.t / 1000; },
  get entorno() { return __estado.entorno; },
  get props() { return __estado.props; },
  /** Publicar algo para mostrar (pantalla, valores). Se manda al terminar el lote. */
  publicar: function (o) { __estado.salida = o; __estado.publico = true; },
  /** No responder a la dirección hasta este instante (µs): una EEPROM grabando su página. */
  ocupadoHasta: function (t) { if (typeof t !== 'number' || !isFinite(t)) __fallo('ocupadoHasta: t inválido'); __estado.ocupadoHasta = t; },
  log: function (m) { console.log(m); },
  /** Maneja un pin propio: 0, 1, o null (alta impedancia: un colector abierto que suelta la línea). */
  pin: function (nombre, nivel) {
    if (typeof nombre !== 'string') __fallo('pin: nombre inválido');
    if (nivel !== 0 && nivel !== 1 && nivel !== null) __fallo('pin: el nivel es 0, 1 o null');
    __estado.pines[nombre] = nivel;
  },
  /** Lo que se guardó en la ejecución anterior (null si nada): memoria no volátil. */
  get guardado() { return __estado.guardado; },
  /** Guarda algo que sobrevive a apagar la placa (una EEPROM, la hora de un reloj con pila). JSON, hasta 64 KB. */
  guardar: function (o) { __estado.guardar = o; __estado.guardo = true; },
  /** Pedir que lo llamen (tick) en el instante t (µs). Vale el más temprano pedido en el lote. */
  despertarEn: function (t) {
    if (typeof t !== 'number' || !isFinite(t)) __fallo('despertarEn: t inválido');
    if (__estado.despertar === null || t < __estado.despertar) __estado.despertar = t;
  },
});
var sdk = Object.freeze({
  /** Entero de 0 a 255. */
  u8: function (x) { return x & 0xff; },
  /** Entero con signo de 'bits' bits a partir de su valor sin signo. */
  conSigno: function (x, bits) { var m = Math.pow(2, bits - 1); x = x % (2 * m); return x >= m ? x - 2 * m : x; },
  /** Valor con signo a su representación de 'bits' bits sin signo (complemento a dos). */
  sinSigno: function (x, bits) { var m = Math.pow(2, bits); x = Math.round(x) % m; return x < 0 ? x + m : x; },
  aBcd: function (n) { return ((Math.floor(n / 10) % 10) << 4) | (n % 10); },
  deBcd: function (b) { return ((b >> 4) & 0x0f) * 10 + (b & 0x0f); },
  limitar: function (x, a, b) { return x < a ? a : x > b ? b : x; },
  /**
   * El entero de [min, max] cuya salida por f (monótona) queda más cerca de 'objetivo', por
   * búsqueda binaria. Para calcular "al revés": qué valor crudo del ADC da 22 °C con la
   * fórmula de compensación de la hoja de datos.
   */
  invertirMonotona: function (f, objetivo, min, max) {
    var creciente = f(max) >= f(min), lo = min, hi = max;
    while (lo < hi) { var m = Math.floor((lo + hi) / 2), y = f(m); if (creciente ? y < objetivo : y > objetivo) lo = m + 1; else hi = m; }
    if (lo > min && Math.abs(f(lo - 1) - objetivo) < Math.abs(f(lo) - objetivo)) return lo - 1;
    return lo;
  },
  /** Generador pseudoaleatorio con semilla (mulberry32): ruido repetible en los tests. */
  azar: function (semilla) {
    var a = semilla >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  },
});
function __direcciones() {
  var f = module.exports.direcciones;
  var d = typeof f === 'function' ? f(ctx) : f;
  return Array.isArray(d) ? d : [];
}
function __lote(json) {
  var e = JSON.parse(json), m = module.exports, lecturas = [];
  __logs = []; __estado.publico = false; __estado.pines = {}; __estado.despertar = null; __estado.guardo = false;
  __estado.entorno = Object.freeze(e.entorno); __estado.props = Object.freeze(e.props);
  for (var i = 0; i < e.eventos.length; i++) {
    var ev = e.eventos[i];
    __estado.t = ev.t;
    if (ev.tipo === 'encender') { __estado.guardado = ev.guardado === undefined ? null : ev.guardado; if (typeof m.encender === 'function') m.encender(ctx); }
    else if (ev.tipo === 'apagar') { if (typeof m.apagar === 'function') m.apagar(ctx); }
    else if (ev.tipo === 'escribir') { if (typeof m.escribir === 'function') m.escribir(ctx, ev.bytes); }
    else if (ev.tipo === 'leer') { lecturas.push(typeof m.leer === 'function' ? m.leer(ctx, ev.n) : []); }
    else if (ev.tipo === 'leidos') { if (typeof m.leidos === 'function') m.leidos(ctx, ev.n); }
    else if (ev.tipo === 'tick') { if (typeof m.tick === 'function') m.tick(ctx); }
  }
  var r = { lecturas: lecturas, direcciones: __direcciones(), ocupadoHasta: __estado.ocupadoHasta, logs: __logs, pines: __estado.pines, despertarEn: __estado.despertar };
  if (__estado.publico) r.salida = __estado.salida;
  if (__estado.guardo) r.guardar = __estado.guardar;
  return JSON.stringify(r);
}
`;

const esByte = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 255;

export class SandboxChip {
  private readonly ctx: vm.Context;
  private readonly lote = new vm.Script(envolver('__lote(__entrada)'));

  constructor(readonly nombre: string, codigo: string) {
    this.ctx = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    });
    let salida: unknown;
    try {
      vm.runInContext(PRELUDIO, this.ctx, { timeout: TIEMPO_CARGA_MS });
      const script = new vm.Script(envolver(`(function () {\n${codigo}\n})(), ''`), { filename: `chips/${nombre}` });
      salida = script.runInContext(this.ctx, { timeout: TIEMPO_CARGA_MS });
    } catch (err) {
      throw new ErrorChip(`chip "${nombre}": ${mensajeDe(err)}`);
    }
    const r = leerSalida(salida);
    if (r.error !== undefined) throw new ErrorChip(`chip "${nombre}": ${r.error}`);
  }

  /** Corre una tanda de eventos en orden y devuelve lo que el bus necesita. */
  correr(eventos: EventoChip[], entorno: Record<string, number>, props: Record<string, unknown>): ResultadoLote {
    // La entrada entra como string primitivo: ningún objeto del server cruza al sandbox.
    (this.ctx as Record<string, unknown>).__entrada = JSON.stringify({ eventos, entorno, props });
    let salida: unknown;
    try {
      salida = this.lote.runInContext(this.ctx, { timeout: TIEMPO_LLAMADA_MS });
    } catch (err) {
      throw new ErrorChip(`chip "${this.nombre}": ${mensajeDe(err)}`);
    }
    const r = leerSalida(salida);
    if (r.error !== undefined) throw new ErrorChip(`chip "${this.nombre}": ${r.error}`);
    return this.validar(r.valor, eventos);
  }

  /** La barrera real: lo que vuelve se revisa entero. */
  private validar(json: string, eventos: EventoChip[]): ResultadoLote {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(json) as Record<string, unknown>;
    } catch {
      throw new ErrorChip(`chip "${this.nombre}": devolvió algo inválido`);
    }
    const pedidas = eventos.filter((e): e is Extract<EventoChip, { tipo: 'leer' }> => e.tipo === 'leer');
    const crudas = Array.isArray(o.lecturas) ? o.lecturas : [];
    const lecturas = pedidas.map((p, i) => {
      const l: unknown = crudas[i];
      if (!Array.isArray(l) || !l.every(esByte)) {
        throw new ErrorChip(`chip "${this.nombre}": leer() tiene que devolver un arreglo de bytes (0-255)`);
      }
      // Si devuelve menos de lo pedido, el bus suelta SDA: el maestro lee 0xFF (pull-up).
      return Array.from({ length: p.n }, (_, k) => (l[k] as number | undefined) ?? 0xff);
    });
    const direcciones = Array.isArray(o.direcciones)
      ? o.direcciones.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 0x7f).slice(0, 8)
      : [];
    const ocupadoHasta = typeof o.ocupadoHasta === 'number' && Number.isFinite(o.ocupadoHasta) ? o.ocupadoHasta : 0;
    const logs = Array.isArray(o.logs) ? o.logs.filter((l): l is string => typeof l === 'string').slice(0, MAX_LOGS) : [];
    const pines: Record<string, 0 | 1 | null> = {};
    if (o.pines && typeof o.pines === 'object') {
      for (const [k, v] of Object.entries(o.pines as Record<string, unknown>).slice(0, 16)) {
        if (/^[A-Za-z0-9_+\/-]{1,20}$/.test(k) && (v === 0 || v === 1 || v === null)) pines[k] = v;
      }
    }
    const despertarEn = typeof o.despertarEn === 'number' && Number.isFinite(o.despertarEn) ? o.despertarEn : null;
    const res: ResultadoLote = { lecturas, direcciones, ocupadoHasta, logs, pines, despertarEn };
    if ('guardar' in o) {
      if (JSON.stringify(o.guardar ?? null).length > MAX_GUARDADO) throw new ErrorChip(`chip "${this.nombre}": guardar() pasa de 64 KB`);
      res.guardar = o.guardar ?? null;
    }
    if ('salida' in o && o.salida !== null && typeof o.salida === 'object') res.salida = o.salida as SalidaChip;
    return res;
  }
}

function leerSalida(salida: unknown): { valor: string; error?: undefined } | { valor?: undefined; error: string } {
  if (typeof salida !== 'string') return { error: 'devolvió algo inválido' };
  if (salida.startsWith('err:')) return { error: salida.slice(4, 304) };
  if (!salida.startsWith('ok:')) return { error: 'devolvió algo inválido' };
  if (salida.length > MAX_SALIDA) return { error: 'devolvió demasiados datos' };
  return { valor: salida.slice(3) };
}

function mensajeDe(err: unknown): string {
  if (err === null || typeof err !== 'object') return 'error desconocido';
  if ((Object.getOwnPropertyDescriptor(err, 'code')?.value as unknown) === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
    return 'tardó demasiado (¿un bucle infinito?)';
  }
  const m: unknown = Object.getOwnPropertyDescriptor(err, 'message')?.value;
  return typeof m === 'string' ? m.slice(0, 300) : 'error desconocido';
}
