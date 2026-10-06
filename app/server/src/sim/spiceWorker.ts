import { parentPort } from 'node:worker_threads';
import { Simulation } from 'eecircuit-engine';
import { extraerSeriesSpice, extraerValoresSpice } from './validacionSpice.js';

interface PedidoSpice { id: number; payload: { netlist?: string; duracionS?: number } }
const motor = new Simulation();
// El bootstrap sólo confirma listo cuando también terminó el arranque WASM.
await motor.start();

parentPort?.on('message', async ({ id, payload }: PedidoSpice) => {
  try {
    if (payload.netlist === undefined) {
      parentPort?.postMessage({ id, resultado: { analisis: 'dc', resultado: { valores: new Map<string, number>(), errores: [] } } });
      return;
    }
    motor.setNetList(payload.netlist);
    const raw = await motor.runSim();
    const errores = [...motor.getError()];
    const resultado = payload.duracionS === undefined
      ? { analisis: 'dc', resultado: { valores: extraerValoresSpice(raw, errores, payload.netlist), errores } }
      : { analisis: 'transitorio', resultado: { ...extraerSeriesSpice(raw, errores, payload.netlist, payload.duracionS), errores } };
    parentPort?.postMessage({ id, resultado });
  } catch (err) {
    parentPort?.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
