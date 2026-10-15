import { parentPort } from 'node:worker_threads';
parentPort?.on('message', (m: { id: number; payload: string }) => {
  if (m.payload === 'bucle') {
    // Sólo se ejecuta dentro del worker terminable; nunca en el hilo del test/server.
    while (true) { /* Trabajo de CPU deliberadamente bloqueado. */ }
  }
  if (m.payload === 'salir') process.exit(2);
  parentPort?.postMessage({ id: m.id, resultado: m.payload });
});
