import { ColaWorker } from './colaWorker.js';
import { ErrorSpice } from './validacionSpice.js';
export { ErrorSpice } from './validacionSpice.js';

export interface ResultadoSpice {
  /** Vectores de punto de operación real, normalizados a minúsculas. */
  valores: Map<string, number>;
  errores: string[];
}

export interface ResultadoTransitorioSpice {
  t: number[];
  valores: Map<string, number[]>;
  errores: string[];
}

type PedidoSpice = { netlist?: string; duracionS?: number };
type RespuestaSpice = { analisis: 'dc'; resultado: ResultadoSpice } | { analisis: 'transitorio'; resultado: ResultadoTransitorioSpice };

/**
 * ngspice corre fuera del hilo del servidor. Una sola tarea activa y hasta 32 pendientes.
 * Arranque/importación: hasta 20 s; cálculo: hasta 5 s desde listo. Ambos son terminables.
 * Los límites V8 no acotan toda la memoria externa de WebAssembly ni imponen cuota CPU del SO.
 */
const motor = new ColaWorker<PedidoSpice, RespuestaSpice>({
  entry: new URL('./spiceWorker.ts', import.meta.url), timeoutMs: 5000,
});

export function precalentar(): Promise<void> {
  return motor.ejecutar({}).then(() => undefined);
}

export async function correrSpice(netlist: string): Promise<ResultadoSpice> {
  try {
    const respuesta = await motor.ejecutar({ netlist });
    if (respuesta.analisis !== 'dc') throw new Error('Tipo de análisis inesperado');
    return respuesta.resultado;
  }
  catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    throw new ErrorSpice(`ngspice no resolvió el circuito (${mensaje})`, [mensaje], netlist);
  }
}

/** Comparte la cola y el worker terminable con DC; nunca recibe código SPICE del cliente. */
export async function correrSpiceTransitorio(netlist: string, duracionS: number): Promise<ResultadoTransitorioSpice> {
  try {
    const respuesta = await motor.ejecutar({ netlist, duracionS });
    if (respuesta.analisis !== 'transitorio') throw new Error('Tipo de análisis inesperado');
    return respuesta.resultado;
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    throw new ErrorSpice(`ngspice no resolvió el transitorio (${mensaje})`, [mensaje], netlist);
  }
}
