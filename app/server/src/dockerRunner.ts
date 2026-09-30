import { spawn, type ChildProcess } from 'node:child_process';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killed: boolean;
}

export interface RunHandle {
  child: ChildProcess;
  kill: (signal?: NodeJS.Signals) => void;
}

/**
 * Corre un comando con argumentos en array (nunca un string para la shell,
 * sección 13) y transmite cada línea de stdout/stderr.
 */
export function run(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; onChild?: (kill: (s?: NodeJS.Signals) => void) => void } = {},
): Promise<RunResult> {
  const child = spawn(cmd, args, { env: { ...process.env, ...opts.env } });
  let buffer = '';
  let timedOut = false;
  let killed = false;

  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs)
    : null;

  const feed = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let i: number;
    while ((i = buffer.indexOf('\n')) !== -1) {
      onLine(buffer.slice(0, i).replace(/\r$/, ''));
      buffer = buffer.slice(i + 1);
    }
  };

  child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);

  return new Promise<RunResult>((resolve) => {
    child.on('error', (err) => {
      onLine(`ERROR: no se pudo ejecutar ${cmd}: ${err.message}`);
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, killed });
    });
    child.on('close', (code, signal) => {
      if (buffer.length > 0) onLine(buffer.replace(/\r$/, ''));
      if (timer) clearTimeout(timer);
      resolve({ code, signal, timedOut, killed });
    });
    // Por si el llamador quiere cancelar.
    const kill = (signal: NodeJS.Signals = 'SIGTERM'): void => {
      killed = true;
      child.kill(signal);
    };
    (child as ChildProcess & { _kill?: (s?: NodeJS.Signals) => void })._kill = kill;
    opts.onChild?.(kill);
  });
}

/** Lanza un proceso en segundo plano y devuelve el handle. */
export function spawnDetached(cmd: string, args: string[], name: string): RunHandle {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => {
    /* el llamador lo ve por el log */
  });
  return {
    child,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      if (!child.killed) child.kill(signal);
    },
  };
}

/** Convierte un Readable en líneas completas (stdout del emulador). */
export function lineIterator(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => string[] {
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let i: number;
    while ((i = buffer.indexOf('\n')) !== -1) {
      onLine(buffer.slice(0, i).replace(/\r$/, ''));
      buffer = buffer.slice(i + 1);
    }
  });
  return () => {
    const rest = buffer;
    buffer = '';
    return rest ? [rest.replace(/\r$/, '')] : [];
  };
}

export function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', `command -v ${JSON.stringify(bin)}`], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}
