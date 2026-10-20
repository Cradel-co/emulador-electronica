import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ModuloCatalogo } from '../catalog.js';
import type { OpcionesImportacion, ResultadoImportacion, SolicitudImportacion } from '../moduleImporter.js';
import type { esquematicoEfectivo, nivelModulo, probarModulo } from '../sim/pruebasModulo.js';

export interface DepsRutasModulos {
  loadCatalog(): Promise<ModuloCatalogo[]>;
  nivelModulo: typeof nivelModulo;
  probarModulo: typeof probarModulo;
  esquematicoEfectivo: typeof esquematicoEfectivo;
  solicitudDe(body: Record<string, unknown>): SolicitudImportacion;
  importarModulos(solicitud: SolicitudImportacion, opciones: OpcionesImportacion): Promise<ResultadoImportacion>;
  quitarDelCatalogo(tipo: string): Promise<void>;
  fallar(reply: FastifyReply, error: unknown): void;
}

export function registrarRutasModulos(app: FastifyInstance, deps: DepsRutasModulos): void {
  app.get('/api/modules', async () => ({
    modules: (await deps.loadCatalog()).map(m => ({ ...m, nivel: deps.nivelModulo(m) })),
  }));

  app.post('/api/modules/:type/probar', async (req, reply) => {
    const { type } = req.params as { type: string };
    try {
      const catalogo = await deps.loadCatalog();
      const def = catalogo.find(m => m.type === type);
      if (!def) return reply.code(404).send({ error: `No hay un módulo "${type}" en el catálogo.` });
      const informe = await deps.probarModulo(def, tipo => catalogo.find(m => m.type === tipo));
      reply.send({ ...informe, esquematico: deps.esquematicoEfectivo(def) });
    } catch (error) {
      deps.fallar(reply, error);
    }
  });

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
