import { ColaWorker } from './colaWorker.js';
import { ErrorSpice } from './validacionSpice.js';
export { ErrorSpice } from './validacionSpice.js';

export interface ResultadoSpice {
  /** Vectores de punto de operación real, normalizados a minúsculas. */
  valores: Map<string, number>;
  errores: string[];
}

/**
 * ngspice corre fuera del hilo del servidor. Una sola tarea activa y hasta 32 pendientes.
 * Arranque/importación: hasta 20 s; cálculo: hasta 5 s desde listo. Ambos son terminables.
 * Los límites V8 no acotan toda la memoria externa de WebAssembly ni imponen cuota CPU del SO.
 */
const motor = new ColaWorker<{ netlist?: string }, ResultadoSpice>({
  entry: new URL('./spiceWorker.ts', import.meta.url), timeoutMs: 5000,
});

export function precalentar(): Promise<void> {
  return motor.ejecutar({}).then(() => undefined);
}

export async function correrSpice(netlist: string): Promise<ResultadoSpice> {
  try { return await motor.ejecutar({ netlist }); }
  catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    throw new ErrorSpice(`ngspice no resolvió el circuito (${mensaje})`, [mensaje], netlist);
  }
}
