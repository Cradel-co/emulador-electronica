import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';

/** Contrato de una sesión de prueba: nunca incluye fuentes ni archivos del proyecto. */
export interface PreviewSnapshot {
  name: string;
  diagram: { modules: Array<{ id: string; type: string; [key: string]: unknown }>; wires: unknown[] };
  catalog: Array<{ type: string; switch?: unknown; [key: string]: unknown }>;
}
export interface PreviewDependencies {
  snapshot(name: string): Promise<PreviewSnapshot>;
  revision(name: string): string | null;
  state(name: string): Promise<unknown>;
  control(name: string, id: string, closed: boolean): Promise<void>;
  port: number;
}
export function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap(entries => (entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address));
}
export function loopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
/** Los clientes de red solo acceden al visor y a sus capacidades acotadas. */
export function previewResource(path: string): boolean {
  return path === '/preview.html' || path === '/style.css' || /^\/dist\/[\w.-]+\.(?:js|css)$/.test(path)
    || /^\/api\/previews\/[a-f0-9-]+(?:\/controls)?$/.test(path);
}

export function registerPreviews(app: FastifyInstance, deps: PreviewDependencies): void {
  const sessions = new Map<string, { snapshot: PreviewSnapshot; revision: string; created: number }>();
  const cached = new Map<string, { at: number; pending: Promise<unknown> }>();
  const liveState = (name: string) => {
    const previous = cached.get(name);
    if (previous && Date.now() - previous.at < 600) return previous.pending;
    const pending = deps.state(name);
    cached.set(name, { at: Date.now(), pending });
    return pending;
  };
  const lifetime = 24 * 60 * 60 * 1000;
  app.post('/api/previews', async (req, reply) => {
    if (!loopback(req.ip)) return reply.code(403).send({ error: 'Compartir se habilita desde la computadora del proyecto.' });
    const { name } = (req.body ?? {}) as { name?: unknown };
    if (typeof name !== 'string') return reply.code(400).send({ error: 'Falta el proyecto.' });
    const revision = deps.revision(name);
    if (!revision) return reply.code(409).send({ error: 'Primero ejecutá el proyecto que querés compartir.' });
    const snapshot = await deps.snapshot(name);
    if (deps.revision(name) !== revision) return reply.code(409).send({ error: 'La ejecución cambió. Volvé a abrir la vista de prueba.' });
    for (const [id, session] of sessions) if (Date.now() - session.created > lifetime) sessions.delete(id);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value as string);
    const token = randomUUID();
    sessions.set(token, { snapshot, revision, created: Date.now() });
    const path = `/preview.html#${token}`;
    return { path, links: localAddresses().map(address => `http://${address}:${deps.port}${path}`) };
  });
  const resolve = (token: string) => {
    const session = sessions.get(token);
    if (!session || Date.now() - session.created > lifetime) return null;
    return session;
  };
  app.get('/api/previews/:token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const session = resolve((req.params as { token: string }).token);
    if (!session) return reply.code(404).send({ error: 'El enlace venció o el servidor se reinició.' });
    const active = deps.revision(session.snapshot.name) === session.revision;
    return { ...session.snapshot, links: localAddresses().map(address => `http://${address}:${deps.port}/preview.html#${(req.params as { token: string }).token}`), active, live: active ? await liveState(session.snapshot.name) : null };
  });
  app.post('/api/previews/:token/controls', async (req, reply) => {
    const session = resolve((req.params as { token: string }).token);
    if (!session) return reply.code(404).send({ error: 'El enlace no existe o venció.' });
    if (deps.revision(session.snapshot.name) !== session.revision) return reply.code(409).send({ error: 'La ejecución compartida terminó o cambió.' });
    const { id, cerrado } = (req.body ?? {}) as { id?: unknown; cerrado?: unknown };
    const inst = session.snapshot.diagram.modules.find(module => module.id === id);
    const def = inst && session.snapshot.catalog.find(module => module.type === inst.type);
    if (typeof id !== 'string' || typeof cerrado !== 'boolean' || !def?.switch)
      return reply.code(400).send({ error: 'Solo se aceptan controles del circuito compartido.' });
    await deps.control(session.snapshot.name, id, cerrado);
    cached.delete(session.snapshot.name);
    return { ok: true };
  });
}
