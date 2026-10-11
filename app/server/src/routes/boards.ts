import type { FastifyInstance, FastifyReply } from 'fastify';
import { DEFAULT_BOARD, LanguageSchema, type Language } from '@emu/shared';
import type { Placa, ResultadoValidacion } from '../boardRegistry.js';
import type { ReporteCertificacion } from '../certificacion.js';

export interface DepsRutasPlacas {
  motores: { nombre: string; descripcion: string; disponible: boolean }[];
  toolchains: { nombre: string; descripcion: string; disponible: boolean; lenguajes: readonly Language[] }[];
  listarPlacas(): Promise<Placa[]>;
  buscarPlaca(id: string): Promise<Placa | undefined>;
  esquemaJsonPlaca(): unknown;
  validarPlaca(entrada: unknown): ResultadoValidacion;
  leerCertificacion(id: string): Promise<ReporteCertificacion | null>;
  placaParaUi(placa: Placa): Promise<unknown>;
  certificarEnFondo(placa: Placa, lenguaje?: Language): 'iniciada' | 'ya-en-curso';
  certificando: ReadonlyMap<string, Promise<ReporteCertificacion>>;
  fallar(reply: FastifyReply, error: unknown): void;
}

export function registrarRutasPlacas(app: FastifyInstance, deps: DepsRutasPlacas): void {
  app.get('/api/boards', async () => ({
    porDefecto: DEFAULT_BOARD,
    motores: deps.motores,
    toolchains: deps.toolchains,
    boards: await Promise.all((await deps.listarPlacas()).map(deps.placaParaUi)),
  }));

  app.get('/api/boards/schema', async () => deps.esquemaJsonPlaca());

  app.post('/api/boards/validate', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as { module?: unknown };
    const resultado = deps.validarPlaca(body.module ?? req.body);
    reply.code(resultado.ok ? 200 : 400).send(resultado);
  });

  app.post('/api/boards/:id/certify', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { language?: string };
    try {
      const placa = await deps.buscarPlaca(id);
      if (!placa) {
        reply.code(404).send({ error: `No hay una placa "${id}" en el catálogo` });
        return;
      }
      const lenguaje = body.language ? LanguageSchema.parse(body.language) as Language : undefined;
      const estado = deps.certificarEnFondo(placa, lenguaje);
      reply.code(202).send({ started: true, estado });
    } catch (error) {
      deps.fallar(reply, error);
    }
  });

  app.get('/api/boards/:id/certification', async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.send({ enCurso: Boolean(deps.certificando.get(id)), ultimo: await deps.leerCertificacion(id) });
  });
}
