import type { FastifyInstance } from 'fastify';
import type { CameraDescriptor } from '@emu/shared';
import { ErrorCamara, ServicioCamara } from './servicio.js';

export function registrarRutasCamara(app: FastifyInstance, servicio: ServicioCamara, descriptor: (p: string, i: string) => Promise<CameraDescriptor | null>) {
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: 1048576 }, (_req, body, done) => done(null, body));
  const base = '/api/projects/:nombre/cameras/:instancia';
  for (const [method, suffix] of [['POST', '/session'], ['POST', '/session/:sesion/heartbeat'], ['DELETE', '/session/:sesion'], ['POST', '/session/:sesion/captures'], ['GET', '/capture'], ['GET', '/status']] as const) {
    app.route({ method, url: base + suffix, bodyLimit: 1048576, handler: async (req, reply) => {
      const { nombre: p, instancia: i, sesion = '' } = req.params as { nombre: string; instancia: string; sesion?: string };
      try {
        const limites = await descriptor(p, i);
        if (!limites) throw new ErrorCamara('CAMERA_NOT_FOUND', 'El proyecto o módulo de cámara no existe.', 404);
        if (suffix === '/session') return servicio.abrir(p, i);
        if (suffix.endsWith('/heartbeat')) return servicio.renovar(p, i, sesion);
        if (method === 'DELETE') { servicio.cerrar(p, i, sesion); return { ok: true }; }
        if (suffix.endsWith('/captures')) {
          if (req.headers['content-type']?.split(';')[0] !== 'image/jpeg') throw new ErrorCamara('UNSUPPORTED_IMAGE', 'Solo se admiten fotografías JPEG.', 415);
          if (!Buffer.isBuffer(req.body)) throw new ErrorCamara('INVALID_IMAGE', 'Falta la fotografía JPEG.', 400);
          return await servicio.capturar(p, i, sesion, req.body, limites);
        }
        if (suffix === '/status') return servicio.estado(p, i);
        const { id } = req.query as { id?: string };
        const imagen = servicio.imagen(p, i, id);
        return reply.header('cache-control', 'no-store').header('x-capture-id', imagen.meta.id).type('image/jpeg').send(imagen.bytes);
      } catch (err) {
        if (err instanceof ErrorCamara) return reply.code(err.status).send({ code: err.code, message: err.message });
        throw err;
      }
    }, errorHandler: (err, _req, reply) => {
      const status = err.statusCode ?? 500;
      reply.code(status).send({ code: status === 413 ? 'CAPTURE_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_IMAGE' : 'CAMERA_ERROR', message: status === 413 ? 'La fotografía supera el tamaño permitido.' : status === 415 ? 'Solo se admiten fotografías JPEG.' : 'No se pudo completar la operación de cámara.' });
    } });
  }
  const timer = setInterval(() => servicio.vencer(), 1000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });
}
