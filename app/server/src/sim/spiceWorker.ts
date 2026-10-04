import { parentPort } from 'node:worker_threads';
import { Simulation } from 'eecircuit-engine';
import { extraerValoresSpice } from './validacionSpice.js';

interface PedidoSpice { id: number; payload: { netlist?: string } }
const motor = new Simulation();
// El bootstrap sólo confirma listo cuando también terminó el arranque WASM.
await motor.start();

parentPort?.on('message', async ({ id, payload }: PedidoSpice) => {
  try {
    if (payload.netlist === undefined) {
      parentPort?.postMessage({ id, resultado: { valores: new Map<string, number>(), errores: [] } });
      return;
    }
    motor.setNetList(payload.netlist);
    const raw = await motor.runSim();
    const errores = [...motor.getError()];
    const valores = extraerValoresSpice(raw, errores, payload.netlist);
    parentPort?.postMessage({ id, resultado: { valores, errores } });
  } catch (err) {
    parentPort?.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
