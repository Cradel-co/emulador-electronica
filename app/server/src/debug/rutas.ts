import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Depurador } from './depurador.js';
import type { TipoEvento } from './grabadora.js';

/**
 * API REST del modo debug (/api/debug/...). Las formas siguen al Debug Adapter Protocol
 * (threads, stackTrace, scopes, variables, evaluate, setBreakpoints, pause/continue/
 * next/stepIn/stepOut) para que la UI (ventana "Debug", estilo VS Code/Android Studio)
 * las use tal cual. Ver docs/depuracion.md.
 */

export const TIPOS_EVENTO = ['pin', 'serial', 'puente', 'estado', 'compilacion', 'electrico', 'led', 'error', 'debug', 'app'] as const;

const numero = z.coerce.number().int();
const booleano = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');
const direccion = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .regex(/^(0x[0-9a-fA-F]+|\d+)$/, 'dirección: número o 0x…')
    .transform((s) => Number(s)),
]);

export const EsquemaSnapshot = z.object({
  variables: booleano.optional(),
  serial: numero.min(0).max(300).optional(),
});

export const EsquemaTraza = z.object({
  since: numero.min(0).optional(),
  types: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(TIPOS_EVENTO)).optional()),
  limit: numero.min(1).max(5000).optional(),
});

export const EsquemaEvaluate = z.object({
  expression: z.string().min(1).max(300),
  frameId: numero.optional(),
});

export const EsquemaBreakpoints = z
  .object({
    project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
    source: z.string().min(1).max(200).optional(),
    lines: z.array(z.number().int().positive()).max(200).optional(),
    functions: z.array(z.string().min(1).max(200)).max(100).optional(),
  })
  .refine((b) => b.source !== undefined || b.functions !== undefined, { message: 'indicá source (+ lines) o functions' });

export const EsquemaControl = z.object({
  action: z.enum(['pause', 'continue', 'next', 'stepIn', 'stepOut']),
  /** Después de continue/next/step: esperar hasta que frene (ms). 0 = no esperar. */
  waitMs: numero.min(0).max(120_000).optional(),
});

export const EsquemaMemoria = z.object({
  address: direccion,
  length: numero.min(1).max(4096),
});

function fallar(reply: FastifyReply, err: unknown): void {
  if (err instanceof z.ZodError) {
    reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'pedido'}: ${i.message}`).join('; ') });
    return;
  }
  const codigo = (err as { statusCode?: unknown })?.statusCode;
  reply.code(typeof codigo === 'number' ? codigo : 500).send({ error: (err as Error)?.message ?? String(err) });
}

export function registrarRutasDepuracion(app: FastifyInstance, dep: Depurador): void {
  const ruta = (
    metodo: 'get' | 'post' | 'put',
    url: string,
    fn: (req: { query: unknown; body: unknown }) => Promise<unknown> | unknown,
  ): void => {
    app[metodo](url, async (req, reply) => {
      try {
        reply.send(await fn({ query: req.query, body: req.body }));
      } catch (err) {
        fallar(reply, err);
      }
    });
  };

  ruta('get', '/api/debug/state', () => dep.estado());

  ruta('get', '/api/debug/snapshot', async ({ query }) => {
    const q = EsquemaSnapshot.parse(query ?? {});
    return dep.instantanea({ variables: q.variables, lineasSerial: q.serial });
  });

  ruta('get', '/api/debug/trace', ({ query }) => {
    const q = EsquemaTraza.parse(query ?? {});
    return dep.traza(q.since ?? 0, q.types as TipoEvento[] | undefined, q.limit ?? 500);
  });

  ruta('get', '/api/debug/threads', async () => ({ threads: await dep.threads() }));

  ruta('get', '/api/debug/stack', async ({ query }) => {
    const q = z.object({ threadId: numero.optional() }).parse(query ?? {});
    const stackFrames = await dep.stackTrace(q.threadId);
    return { stackFrames, totalFrames: stackFrames.length };
  });

  ruta('get', '/api/debug/scopes', async ({ query }) => {
    const q = z.object({ frameId: numero.optional() }).parse(query ?? {});
    return { scopes: await dep.scopes(q.frameId) };
  });

  ruta('get', '/api/debug/variables', async ({ query }) => {
    const q = z.object({ ref: numero.min(1), start: numero.min(0).optional(), count: numero.min(1).max(1000).optional() }).parse(query ?? {});
    return { variables: await dep.variables(q.ref, q.start, q.count) };
  });

  ruta('post', '/api/debug/evaluate', async ({ body }) => {
    const b = EsquemaEvaluate.parse(body ?? {});
    return dep.evaluate(b.expression, b.frameId);
  });

  ruta('get', '/api/debug/breakpoints', ({ query }) => {
    const q = z.object({ project: z.string().min(1).max(40).optional() }).parse(query ?? {});
    return { breakpoints: q.project ? dep.breakpointsDe(q.project) : dep.estado().breakpoints };
  });

  ruta('put', '/api/debug/breakpoints', async ({ body }) => {
    const b = EsquemaBreakpoints.parse(body ?? {});
    return { breakpoints: await dep.setBreakpoints({ source: b.source, lines: b.lines, functions: b.functions }, b.project) };
  });

  ruta('post', '/api/debug/control', async ({ body }) => {
    const b = EsquemaControl.parse(body ?? {});
    let state = await dep.control(b.action);
    if (b.waitMs && b.action !== 'pause' && state.status === 'running') state = await dep.esperarParada(b.waitMs);
    return { state };
  });

  ruta('get', '/api/debug/memory', async ({ query }) => {
    const q = EsquemaMemoria.parse(query ?? {});
    const datos = await dep.memoria(q.address, q.length);
    return {
      address: `0x${q.address.toString(16)}`,
      length: datos.length,
      hex: Buffer.from(datos).toString('hex'),
      ascii: [...datos].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''),
    };
  });
}
