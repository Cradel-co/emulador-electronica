// Punto de entrada del hilo del emulador AVR (worker_thread).
//
// Es JavaScript a propósito: Node no sabe cargar .ts en un Worker (ni con tsx en el
// proceso principal: los hooks de módulos no pasan a los hilos). tsImport de tsx
// carga avrWorker.ts con su propio loader, así anda igual con `tsx`, con Node
// pelado y dentro de vitest.
import { parentPort } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

const { atenderWorker } = await tsImport('./avrWorker.ts', import.meta.url);
atenderWorker(parentPort);
