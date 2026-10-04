import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Project } from '@emu/shared';
import { analizarTransitorioCircuito, type BuscarDef, type OpcionesAnalisis } from './sim/analisis.js';
import { calcularTermicaRc } from './sim/termica.js';

const numero = z.number().finite();
const identificador = z.string().min(1).max(200);
const registro = <T extends z.ZodTypeAny>(valor: T) => z.record(identificador, valor)
  .refine(v => Object.keys(v).length <= 256, 'Hasta 256 elementos por solicitud.');

export const SolicitudAnalisisTemporal = z.object({
  parametros: z.object({
    pasoS: numero.positive(), duracionS: numero.positive(),
    inicializacion: z.enum(['equilibrio', 'explicita']),
    condicionesIniciales: registro(numero).optional(),
    estimulos: registro(z.array(z.object({ t: numero.nonnegative(), valor: numero }).strict()).min(2).max(2000)).optional(),
  }).strict(),
  /** Modelo explícito por elemento disipativo; nunca se deduce del nombre comercial. */
  termica: registro(z.object({
    id: z.string().trim().min(1).max(2000),
    fuente: z.string().trim().min(1).max(2000),
    condiciones: z.string().trim().min(1).max(2000),
    resistenciaKPorW: numero.positive(), capacidadJPorK: numero.positive(),
    ambienteC: numero.min(-273.15), inicialC: numero.min(-273.15),
    rangoDeclaradoC: z.tuple([numero.min(-273.15), numero.min(-273.15)]),
  }).strict()).optional(),
}).strict();

interface ContextoAnalisisTemporal {
  proyecto: Project;
  buscar: BuscarDef;
  opciones: OpcionesAnalisis;
}

export interface DependenciasAnalisisFisico {
  cargar(nombre: string): Promise<ContextoAnalisisTemporal>;
  resolver?: typeof analizarTransitorioCircuito;
}

/** Análisis de diseño acotado e independiente de la corrida del firmware. */
export function registrarRutasAnalisisFisico(app: FastifyInstance, deps: DependenciasAnalisisFisico): void {
  app.post('/api/projects/:name/analysis/transient', { bodyLimit: 524288 }, async (req, reply) => {
    const pedido = SolicitudAnalisisTemporal.safeParse(req.body);
    reply.header('cache-control', 'no-store');
    if (!pedido.success) return reply.code(400).send({
      resuelto: false, error: 'Solicitud de análisis inválida.',
      detalles: pedido.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
    });
    // Errores del proyecto conservan su status (p.ej. 404); no son fallos numéricos.
    const { proyecto, buscar, opciones } = await deps.cargar((req.params as { name: string }).name);
    try {
      const transitorio = await (deps.resolver ?? analizarTransitorioCircuito)(proyecto, buscar, opciones, pedido.data.parametros);
      const termica = Object.fromEntries(Object.entries(pedido.data.termica ?? {}).map(([id, modelo]) => {
        const e = transitorio.elementos[id];
        if (!e || (e.tipo !== 'R' && e.tipo !== 'S')) {
          throw new Error(`Térmica: ${id} debe ser una resistencia o un contacto resistivo representado en el análisis.`);
        }
        return [id, calcularTermicaRc(modelo, transitorio.t, e.p)];
      }));
      return { resuelto: true, parametros: pedido.data.parametros, unidades: { t: 's', v: 'V', i: 'A', p: 'W' }, ...transitorio, termica };
    } catch (error) {
      return reply.code(422).send({ resuelto: false, error: error instanceof Error ? error.message : 'Análisis físico no disponible.' });
    }
  });
}
