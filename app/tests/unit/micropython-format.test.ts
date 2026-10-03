import { afterEach, describe, expect, it, vi } from 'vitest';
import { format } from '@wasm-fmt/ruff_fmt/node';

const workerState = vi.hoisted(() => ({ instances: [] as Array<{
  onmessage: ((event: { data: { id: number; formatted?: string; error?: string } }) => void) | null;
  onerror: (() => void) | null;
  onmessageerror: (() => void) | null;
  requests: Array<{ id: number; source: string; filename: string; indentWidth: number }>;
  terminated: boolean;
}> }));

vi.mock('../../web/micropython-format.worker?worker&inline', () => ({
  default: class {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    requests: Array<{ id: number; source: string; filename: string; indentWidth: number }> = [];
    terminated = false;
    constructor() { workerState.instances.push(this); }
    postMessage(request: { id: number; source: string; filename: string; indentWidth: number }) { this.requests.push(request); }
    terminate() { this.terminated = true; }
  },
}));

async function start(source = 'x=1', filename = 'main.py', indentWidth = 4) {
  const { formatMicroPython } = await import('../../web/micropython-format.js');
  const promise = formatMicroPython(source, filename, indentWidth);
  // Espera la importación dinámica del worker, sin demoras de reloj reales.
  await vi.waitFor(() => expect(workerState.instances.at(-1)?.requests.length).toBeGreaterThan(0));
  const worker = workerState.instances.at(-1);
  if (!worker) throw new Error('Falta el worker');
  return { promise, worker };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  workerState.instances.length = 0;
});

describe('formateador Python Ruff WASM real', () => {
  it('normaliza expresiones y llamadas, conservando semántica', () => {
    expect(format('x=1+2\nprint( x )', 'main.py')).toBe('x = 1 + 2\nprint(x)\n');
  });

  it.each([2, 4, 8])('respeta indentación configurada: %i', (indentWidth) => {
    expect(format('if True:\n print( 1 )\n', 'main.py', { indent_style: 'space', indent_width: indentWidth }))
      .toBe(`if True:\n${' '.repeat(indentWidth)}print(1)\n`);
  });

  it('conserva strings con comentarios, escapes y triple comillas', () => {
    const source = 'message="hash # inside"\ntext="""text\n  literal\n"""\n';
    const formatted = format(source, 'main.py', { quote_style: 'preserve' });
    expect(formatted).toContain('message = "hash # inside"');
    expect(formatted).toContain('"""text\n  literal\n"""');
    expect(format(formatted, 'main.py', { quote_style: 'preserve' })).toBe(formatted);
  });

  it('rechaza sintaxis inválida', () => {
    expect(() => format('if True\n pass', 'main.py')).toThrow();
  });
});

describe('cliente del worker de formato', () => {
  it('crea el worker a demanda y resuelve el resultado correspondiente', async () => {
    const module = await import('../../web/micropython-format.js');
    expect(workerState.instances).toHaveLength(0);
    const { promise, worker } = await start('x=1', 'boot.py', 2);
    const request = worker.requests[0];
    expect(request).toMatchObject({ source: 'x=1', filename: 'boot.py', indentWidth: 2 });
    worker.onmessage?.({ data: { id: request.id, formatted: 'x = 1\n' } });
    await expect(promise).resolves.toBe('x = 1\n');
    // El módulo sigue exportando una función estable mientras conserva el worker.
    expect(module.formatMicroPython).toBeTypeOf('function');
  });

  it('propaga errores de sintaxis sin producir código de reemplazo', async () => {
    const { promise, worker } = await start('if True\npass');
    const rejection = expect(promise).rejects.toThrow('Sintaxis inválida');
    worker.onmessage?.({ data: { id: worker.requests[0].id, error: 'Sintaxis inválida' } });
    await rejection;
  });

  it('rechaza extensiones e indentación inválidas antes de crear el worker', async () => {
    const { formatMicroPython } = await import('../../web/micropython-format.js');
    await expect(formatMicroPython('x=1', 'main.cpp')).rejects.toThrow('MicroPython');
    await expect(formatMicroPython('x=1', 'main.py', 3)).rejects.toThrow('2, 4 u 8');
    await expect(formatMicroPython('x'.repeat(1024 * 1024 + 1), 'main.py')).rejects.toThrow('1 MiB');
    expect(workerState.instances).toHaveLength(0);
  });

  it('cierra el worker que supera el tiempo de espera', async () => {
    vi.useFakeTimers();
    const { promise, worker } = await start();
    const rejection = expect(promise).rejects.toThrow('tiempo de espera');
    await vi.advanceTimersByTimeAsync(15000);
    await rejection;
    expect(worker.terminated).toBe(true);
  });
});
