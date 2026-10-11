import type { FastifyInstance } from 'fastify';
import type { MuestraEntradaSonido } from '@emu/shared';
import { ErrorEntradaSonido, ServicioEntradaSonido } from './servicio.js';
export function registrarRutasEntradaSonido(app: FastifyInstance, servicio: ServicioEntradaSonido,
  existe: (proyecto: string, instancia: string) => Promise<boolean>, refrescar: (proyecto: string) => Promise<void>): void {
  const base = '/api/projects/:nombre/sound/:instancia';
  for (const [method, sufijo] of [['POST', '/session'], ['PUT', '/session/:id'], ['DELETE', '/session/:id'], ['GET', '/status']] as const) {
    app.route({ method, url: base + sufijo, bodyLimit: 2048, handler: async (req, reply) => {
      const { nombre, instancia, id = '' } = req.params as { nombre: string; instancia: string; id?: string };
      try {
        if (!await existe(nombre, instancia)) throw new ErrorEntradaSonido('El sonómetro no existe en este proyecto.', 404);
        reply.header('cache-control', 'no-store');
        if (method === 'POST') return servicio.abrir(nombre, instancia);
        if (method === 'GET') return servicio.estado(nombre, instancia);
        if (method === 'DELETE') servicio.cerrar(nombre, instancia, id);
        else servicio.actualizar(nombre, instancia, id, req.body as MuestraEntradaSonido);
        await refrescar(nombre);
        return { ok: true };
      } catch (e) {
        if (e instanceof ErrorEntradaSonido) return reply.code(e.status).send({ message: e.message });
        throw e;
      }
    } });
  }
  const timer = setInterval(() => servicio.vencer(), 1000); timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });
}
