import { parentPort } from 'node:worker_threads';
// Demora de inicio, no de cálculo: verifica los presupuestos separados sin cargar CPU.
await new Promise<void>(resolve => setTimeout(resolve, 100));
parentPort?.on('message', (m: { id: number; payload: string }) => {
  parentPort?.postMessage({ id: m.id, resultado: m.payload });
});
