import { Worker, type ResourceLimits } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export interface OpcionesColaWorker {
  entry: URL;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  maxPendientes?: number;
  resourceLimits?: ResourceLimits;
}

/** Una tarea activa, cola acotada y corte desde el hilo padre: incluye arranque/importación. */
export class ColaWorker<Entrada, Salida> {
  private worker: Worker | null = null;
  private listo: Worker | null = null;
  private cola: Promise<unknown> = Promise.resolve();
  private pendientes = 0;
  private secuencia = 0;
  private cerrado = false;
  private terminarActivo: (() => void) | null = null;
  private terminacionesRealizadas = 0;

  constructor(private readonly opciones: OpcionesColaWorker) {}

  get terminaciones(): number { return this.terminacionesRealizadas; }

  ejecutar(payload: Entrada): Promise<Salida> {
    if (this.cerrado) return Promise.reject(new Error('El worker está cerrado'));
    if (this.pendientes >= (this.opciones.maxPendientes ?? 32)) return Promise.reject(new Error('La cola del worker está llena'));
    this.pendientes++;
    const tarea = this.cola.then(() => {
      if (this.cerrado) throw new Error('El worker está cerrado');
      return this.correr(payload);
    });
    const resultado = tarea.finally(() => { this.pendientes--; });
    this.cola = resultado.catch(() => undefined);
    return resultado;
  }

  private crear(): Worker {
    // Igual que el adaptador AVR, cada hilo registra su loader propio. Data URL evita un
    // archivo JS adicional y permite TS tanto con tsx/dev como con Node sin hooks heredados.
    const require = createRequire(import.meta.url);
    const paquete = require('tsx/package.json') as { exports: { './esm/api': { import: { default: string } } } };
    const loader = new URL(paquete.exports['./esm/api'].import.default, pathToFileURL(require.resolve('tsx/package.json'))).href;
    const bootstrap = `import { workerData, parentPort } from 'node:worker_threads'; import { tsImport } from ${JSON.stringify(loader)}; await tsImport(workerData.entry, workerData.entry); parentPort.postMessage({ listo: true });`;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
      workerData: { entry: this.opciones.entry.href },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4, ...this.opciones.resourceLimits },
    });
    // Un worker ocioso no mantiene el proceso vivo; durante un trabajo se vuelve a referenciar.
    worker.unref();
    worker.on('error', () => {
      if (!this.terminarActivo && this.worker === worker) {
        this.worker = null;
        this.listo = null;
        void worker.terminate();
      }
    });
    worker.on('exit', () => { if (!this.terminarActivo && this.worker === worker) { this.worker = null; this.listo = null; } });
    return worker;
  }

  private correr(payload: Entrada): Promise<Salida> {
    const worker = this.worker ?? (this.worker = this.crear());
    worker.ref();
    const id = ++this.secuencia;
    return new Promise<Salida>((resolve, reject) => {
      let terminado = false;
      const limpiar = (): void => {
        clearTimeout(timer);
        worker.off('message', mensaje); worker.off('error', error); worker.off('exit', salida);
        this.terminarActivo = null;
      };
      const fallar = (motivo: Error): void => {
        if (terminado) return;
        terminado = true;
        limpiar();
        if (this.worker === worker) this.worker = null;
        if (this.listo === worker) this.listo = null;
        // La cola sólo avanza tras confirmar terminate: no queda trabajo viejo de CPU ejecutando.
        void worker.terminate().then(() => {
          this.terminacionesRealizadas++;
          reject(motivo);
        }, err => {
          this.cerrado = true;
          reject(new Error(`No se pudo terminar el worker: ${String(err)}`));
        });
      };
      const mensaje = (raw: unknown): void => {
        const m = raw as { listo?: boolean; id?: number; resultado?: Salida; error?: string } | null;
        if (!m || terminado) return;
        if (m.listo === true && this.listo !== worker) {
          this.listo = worker;
          clearTimeout(timer);
          timer = setTimeout(() => { fallar(new Error('El worker excedió el tiempo límite')); }, this.opciones.timeoutMs ?? 5000);
          enviar();
          return;
        }
        if (m.id !== id) return;
        if (typeof m.error === 'string') { fallar(new Error(m.error)); return; }
        terminado = true;
        limpiar();
        worker.unref();
        resolve(m.resultado as Salida);
      };
      const error = (err: Error): void => { fallar(err); };
      const salida = (code: number): void => { fallar(new Error(`El worker terminó inesperadamente (${code})`)); };
      const caliente = this.listo === worker;
      let timer = setTimeout(() => { fallar(new Error(`El worker excedió el tiempo límite${caliente ? '' : ' de arranque'}`)); }, caliente ? (this.opciones.timeoutMs ?? 5000) : (this.opciones.startupTimeoutMs ?? 20000));
      const enviar = (): void => {
        try { worker.postMessage({ id, payload }); } catch (err) { fallar(err instanceof Error ? err : new Error(String(err))); }
      };
      this.terminarActivo = () => { fallar(new Error('El worker está cerrado')); };
      worker.on('message', mensaje); worker.once('error', error); worker.once('exit', salida);
      if (caliente) enviar();
    });
  }

  async cerrar(): Promise<void> {
    this.cerrado = true;
    if (this.terminarActivo) this.terminarActivo();
    else if (this.worker) {
      const worker = this.worker; this.worker = null;
      this.listo = null;
      await worker.terminate(); this.terminacionesRealizadas++;
    }
    await this.cola;
  }
}
