import type { ElementoArmado, Netlist } from './netlist.js';
import { correrSpiceTransitorio } from './spice.js';
import { ErrorSpice } from './validacionSpice.js';
import { verificarConservacionInstantanea } from './conservacion.js';

export interface ParametrosTransitorio {
  /** Paso máximo de integración; las muestras devueltas conservan el tiempo adaptativo. */
  pasoS: number;
  duracionS: number;
  inicializacion: 'equilibrio' | 'explicita';
  /** Voltios para C y amperios para L, con el sentido a→b de la primitiva. */
  condicionesIniciales?: Record<string, number>;
  /** Fuente V identificada por dueño.nombre; interpolación lineal entre puntos. */
  estimulos?: Record<string, { t: number; valor: number }[]>;
}

export interface SerieElementoTransitorio {
  tipo: ElementoArmado['tipo'];
  v: number[];
  i: number[];
  /** Potencia eléctrica absorbida, incluida la energía intercambiada por C/L. */
  p: number[];
}

const MAX_MUESTRAS_ESTIMADAS = 20_000;
const esRegistro = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const finito = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Se ejecuta antes de armar modelos y antes de ocupar el worker. */
export function validarParametrosTransitorio(p: ParametrosTransitorio): void {
  if (!esRegistro(p) || !finito(p.pasoS) || !finito(p.duracionS) || p.pasoS <= 0 || p.duracionS <= 0 || p.pasoS > p.duracionS) {
    throw new Error('pasoS y duracionS deben ser finitos, positivos y pasoS no mayor que duracionS');
  }
  if (Math.ceil(p.duracionS / p.pasoS) + 1 > MAX_MUESTRAS_ESTIMADAS) throw new Error('El transitorio excede las 20000 muestras estimadas');
  if (p.inicializacion !== 'equilibrio' && p.inicializacion !== 'explicita') throw new Error('La inicialización debe ser equilibrio o explicita');
  if (p.condicionesIniciales !== undefined) {
    if (!esRegistro(p.condicionesIniciales) || Object.keys(p.condicionesIniciales).length > 256) throw new Error('Condiciones iniciales inválidas');
    if (p.inicializacion !== 'explicita' && Object.keys(p.condicionesIniciales).length) throw new Error('Las condiciones iniciales requieren inicialización explícita');
    for (const [id, valor] of Object.entries(p.condicionesIniciales)) {
      if (!finito(valor)) throw new Error(`Condición inicial no finita para ${id}`);
    }
  }
  if (p.estimulos !== undefined) {
    if (!esRegistro(p.estimulos) || Object.keys(p.estimulos).length > 256) throw new Error('Estímulos inválidos');
    let cantidad = 0;
    for (const [id, puntos] of Object.entries(p.estimulos)) {
      if (!Array.isArray(puntos) || puntos.length < 2 || (cantidad += puntos.length) > MAX_MUESTRAS_ESTIMADAS) throw new Error(`Cantidad de puntos de estímulo inválida para ${id}`);
      let anterior = -1;
      for (const punto of puntos) {
        if (!esRegistro(punto) || !finito(punto.t) || !finito(punto.valor) || punto.t < 0 || punto.t > p.duracionS || punto.t <= anterior) {
          throw new Error(`Estímulo inválido para ${id}: tiempos crecientes y valores finitos dentro de la duración`);
        }
        if (anterior === -1 && punto.t !== 0) throw new Error(`El estímulo de ${id} debe comenzar en t=0`);
        anterior = punto.t;
      }
    }
  }
}

/** Análisis físico de diseño con topología constante, sin ejecutar ni avanzar firmware. */
export async function correrTransitorio(n: Netlist, parametros: ParametrosTransitorio): Promise<{
  t: number[];
  tensiones: Map<string, number[]>;
  elementos: Record<string, SerieElementoTransitorio>;
  advertencias: string[];
}> {
  validarParametrosTransitorio(parametros);
  const netlist = n.textoTransitorio(parametros);
  const r = await correrSpiceTransitorio(netlist, parametros.duracionS);
  // Los pasos adaptativos pueden superar la estimación: comprobar antes de crear v/i/p.
  n.validarPresupuestoTransitorio(r.t.length);
  const tierra = r.t.map(() => 0);
  const requerido = (nombre: string): number[] => {
    const valores = r.valores.get(nombre.toLowerCase());
    if (!valores) throw new ErrorSpice(`ngspice no devolvió el vector requerido ${nombre}`, r.errores, netlist);
    return valores;
  };
  const tensiones = new Map<string, number[]>([['0', tierra]]);
  const tension = (nodo: string): number[] => {
    let serie = tensiones.get(nodo);
    if (!serie) { serie = requerido(`v(${nodo})`); tensiones.set(nodo, serie); }
    return serie;
  };
  const elementos: Record<string, SerieElementoTransitorio> = {};
  for (const el of n.elementos) {
    for (const nodo of el.control ?? []) tension(nodo);
    const va = tension(el.a);
    const vb = tension(el.b);
    const v = va.map((a, k) => {
      const b = vb[k];
      if (b === undefined) throw new ErrorSpice(`Vector incompleto en ${el.id}`, r.errores, netlist);
      return a - b;
    });
    let i: number[];
    if (el.ohms !== undefined) { const ohms = el.ohms; i = v.map(dv => dv / ohms); }
    else if (el.medidor) i = requerido(`i(${el.medidor})`).map(valor => valor * (el.signo ?? 1));
    else throw new ErrorSpice(`El elemento ${el.id} no tiene medición de corriente`, r.errores, netlist);
    const p = v.map((voltios, k) => {
      const amperios = i[k];
      if (amperios === undefined || !Number.isFinite(voltios) || !Number.isFinite(amperios) || !Number.isFinite(voltios * amperios)) {
        throw new ErrorSpice(`Medición no finita o incompleta en ${el.id}`, r.errores, netlist);
      }
      return voltios * amperios;
    });
    elementos[el.id] = { tipo: el.tipo, v, i, p };
  }
  // Reutiliza las vistas por muestra; el presupuesto agregado también limita este trabajo.
  const instantanea = n.elementos.map(el => ({ id: el.id, a: el.a, b: el.b, va: 0, vb: 0, i: 0, p: 0 }));
  for (const [k, tiempo] of r.t.entries()) {
    for (const el of instantanea) {
      const serie = elementos[el.id];
      // NaN hace que el gate rechace una ausencia; nunca se convierte en una medida cero.
      el.va = tensiones.get(el.a)?.[k] ?? NaN;
      el.vb = tensiones.get(el.b)?.[k] ?? NaN;
      el.i = serie?.i[k] ?? NaN;
      el.p = serie?.p[k] ?? NaN;
    }
    try { verificarConservacionInstantanea(instantanea); }
    catch (error) {
      throw new ErrorSpice(`${error instanceof Error ? error.message : String(error)} (t=${tiempo} s)`, r.errores, netlist);
    }
  }
  return { t: r.t, tensiones, elementos, advertencias: r.errores.filter(e => /warning/i.test(e)) };
}
