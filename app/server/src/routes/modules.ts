import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ModuloCatalogo } from '../catalog.js';
import type { OpcionesImportacion, ResultadoImportacion, SolicitudImportacion } from '../moduleImporter.js';

export interface DepsRutasModulos {
  loadCatalog(): Promise<ModuloCatalogo[]>;
  solicitudDe(body: Record<string, unknown>): SolicitudImportacion;
  importarModulos(solicitud: SolicitudImportacion, opciones: OpcionesImportacion): Promise<ResultadoImportacion>;
  quitarDelCatalogo(tipo: string): Promise<void>;
  fallar(reply: FastifyReply, error: unknown): void;
}

export function registrarRutasModulos(app: FastifyInstance, deps: DepsRutasModulos): void {
  app.get('/api/modules', async () => ({ modules: await deps.loadCatalog() }));

  app.post('/api/modules/import', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown> & OpcionesImportacion;
    try {
      const resultado = await deps.importarModulos(deps.solicitudDe(body), body);
      reply.code(resultado.importados.length === 0 && resultado.errores.length > 0 ? 400 : 200).send(resultado);
    } catch (error) {
      deps.fallar(reply, error);
    }
  });

  app.delete('/api/modules/:type', async (req, reply) => {
    const { type } = req.params as { type: string };
    try {
      await deps.quitarDelCatalogo(type);
      reply.send({ ok: true });
    } catch (error) {
      deps.fallar(reply, error);
    }
  });
}
