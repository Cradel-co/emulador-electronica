import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerPreviews, previewResource } from './preview.js';

describe('sesiones compartidas de circuito', () => {
  it('limita capacidades y conserva la ejecución elegida', async () => {
    const app = Fastify();
    let revision: string | null = 'run-1';
    const changes: unknown[] = [];
    registerPreviews(app, {
      port: 5180, revision: () => revision,
      snapshot: async name => ({ name, diagram: { modules: [{ id: 'btn', type: 'button' }, { id: 'led', type: 'led' }], wires: [] }, catalog: [{ type: 'button', switch: {} }, { type: 'led' }] }),
      state: async () => ({ cerrados: [] }), control: async (...args) => { changes.push(args); },
    });
    try {
      expect((await app.inject({ method: 'POST', url: '/api/previews', payload: { name: 'demo' }, remoteAddress: '192.168.1.2' })).statusCode).toBe(403);
      const created = await app.inject({ method: 'POST', url: '/api/previews', payload: { name: 'demo' } });
      expect(created.statusCode).toBe(200);
      const token = created.json().path.split('#')[1];
      const url = `/api/previews/${token}`;
      expect((await app.inject(url)).json()).toMatchObject({ name: 'demo', active: true });
      expect((await app.inject(`${url}bad`)).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: url + '/controls', payload: { id: 'led', cerrado: true } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: url + '/controls', payload: { id: 'btn', cerrado: true } })).statusCode).toBe(200);
      expect(changes).toEqual([['demo', 'btn', true]]);
      revision = 'run-2';
      expect((await app.inject(url)).json()).toMatchObject({ active: false, live: null });
      expect((await app.inject({ method: 'POST', url: url + '/controls', payload: { id: 'btn', cerrado: false } })).statusCode).toBe(409);
      revision = null;
      expect((await app.inject({ method: 'POST', url: '/api/previews', payload: { name: 'demo' } })).statusCode).toBe(409);
    } finally { await app.close(); }
  });
  it('no permite abrir el editor, fuentes ni mapas desde la red', () => {
    for (const path of ['/', '/index.html', '/api/projects/demo', '/api/previews', '/dist/app.js.map', '/server.ts']) expect(previewResource(path)).toBe(false);
    for (const path of ['/preview.html', '/style.css', '/dist/modulos-abc.js', '/dist/app.css', '/api/previews/a123-456/controls']) expect(previewResource(path)).toBe(true);
  });
});
