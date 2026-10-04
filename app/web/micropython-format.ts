/** Ruff corre en un worker creado al pedir formato; no bloquea el editor ni usa el backend. */
export interface FormatRequest {
  id: number;
  source: string;
  filename: string;
  indentWidth: number;
}
export interface FormatResponse {
  id: number;
  formatted?: string;
  error?: string;
}

interface PendingFormat {
  resolve: (formatted: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingFormat>();
let formatter: Worker | null = null;
let workerLoading: Promise<Worker> | null = null;
let nextId = 0;
let workerGeneration = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const FORMAT_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 30000;

function resetWorker(error?: Error): void {
  workerGeneration++;
  formatter?.terminate();
  formatter = null;
  workerLoading = null;
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  for (const entry of pending.values()) {
    clearTimeout(entry.timeout);
    entry.reject(error ?? new Error('El formateador fue cerrado.'));
  }
  pending.clear();
}

function scheduleIdleCleanup(): void {
  if (pending.size > 0) return;
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => resetWorker(), IDLE_TIMEOUT_MS);
}

async function getWorker(): Promise<Worker> {
  if (formatter) return formatter;
  if (!workerLoading) {
    const generation = ++workerGeneration;
    workerLoading = new Promise<Worker>((resolve, reject) => {
      const loadTimeout = setTimeout(() => {
        if (generation !== workerGeneration) return;
        workerGeneration++;
        workerLoading = null;
        reject(new Error('La carga del formateador Python superó el tiempo de espera.'));
      }, FORMAT_TIMEOUT_MS);
      import('./micropython-format.worker?worker&inline').then(({ default: FormatterWorker }) => {
        clearTimeout(loadTimeout);
        // Un módulo que llega después del timeout no crea un worker huérfano.
        if (generation !== workerGeneration) return;
        const worker = new FormatterWorker();
        formatter = worker;
        worker.onmessage = (event: MessageEvent<FormatResponse>) => {
          const entry = pending.get(event.data.id);
          if (!entry) return;
          pending.delete(event.data.id);
          clearTimeout(entry.timeout);
          if (event.data.error) entry.reject(new Error(event.data.error));
          else if (typeof event.data.formatted === 'string') entry.resolve(event.data.formatted);
          else entry.reject(new Error('El formateador devolvió una respuesta inválida.'));
          scheduleIdleCleanup();
        };
        worker.onerror = () => resetWorker(new Error('No se pudo iniciar el formateador Python.'));
        worker.onmessageerror = () => resetWorker(new Error('No se pudo leer la respuesta del formateador.'));
        resolve(worker);
      }).catch((error: unknown) => {
        clearTimeout(loadTimeout);
        if (generation === workerGeneration) workerLoading = null;
        reject(error);
      });
    });
  }
  return workerLoading;
}

/** El llamador compara archivo y contenido antes de aplicar el resultado para evitar cambios obsoletos. */
export async function formatMicroPython(source: string, filename = 'main.py', indentWidth = 4): Promise<string> {
  if (source.length > 1024 * 1024) throw new Error('El archivo supera el límite de 1 MiB del formateador.');
  if (!/\.py$/i.test(filename)) throw new Error('El formato está disponible para archivos MicroPython (.py).');
  if (![2, 4, 8].includes(indentWidth)) throw new Error('La indentación debe ser de 2, 4 u 8 espacios.');
  const worker = await getWorker();
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  const id = ++nextId;
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => resetWorker(new Error('El formateador Python superó el tiempo de espera.')), FORMAT_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timeout });
    try {
      worker.postMessage({ id, source, filename, indentWidth } satisfies FormatRequest);
    } catch {
      resetWorker(new Error('No se pudo enviar el código al formateador Python.'));
    }
  });
}
