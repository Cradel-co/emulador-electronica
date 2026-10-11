import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registrarRutasEntradaSonido } from './rutas.js';
import { ServicioEntradaSonido } from './servicio.js';
it('valida destino, propiedad, secuencia y contrato sin admitir audio crudo', async () => {
  const app = Fastify(), servicio = new ServicioEntradaSonido(() => {});
  registrarRutasEntradaSonido(app, servicio, async (p, m) => p === 'p' && m === 'mic', async () => {});
  try {
    const base = '/api/projects/p/sound/mic';
    expect((await app.inject({ method: 'POST', url: '/api/projects/p/sound/otro/session' })).statusCode).toBe(404);
    const sesion = (await app.inject({ method: 'POST', url: base + '/session' })).json() as { id: string };
    expect((await app.inject({ method: 'POST', url: base + '/session' })).statusCode).toBe(409);
    const muestra = { secuencia: 1, dbfs: -20, referencia: { dbfs: -20, nivel: 80 } };
    const url = base + '/session/' + sesion.id;
    expect((await app.inject({ method: 'PUT', url: base + '/session/ajeno', payload: muestra })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url, payload: { ...muestra, audio: [0, 1] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url, payload: muestra })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url, payload: muestra })).statusCode).toBe(409);
    const estado = await app.inject({ method: 'GET', url: base + '/status' });
    expect(estado.headers['cache-control']).toBe('no-store'); expect(estado.body).not.toContain(sesion.id);
    expect(estado.json()).toMatchObject({ activo: true, entrada: { nivelEstimado: 80 } });
    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(200);
    expect(servicio.leer('p')).toEqual({});
  } finally { await app.close(); }
});
