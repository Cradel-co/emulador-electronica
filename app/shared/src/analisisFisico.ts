import type { RespuestaAc } from './ac.js';
import { ResultadoTermicoRcSchema, type ModeloTermicoRc } from './termica.js';
import { z } from 'zod';
import type { InformePrototipo } from './informe.js';

export const ParametrosVistaTransitorio = z.object({
  pasoS: z.number().finite().positive(), duracionS: z.number().finite().positive(),
  inicializacion: z.enum(['equilibrio', 'explicita']),
}).strict().refine(p => p.pasoS <= p.duracionS, 'El paso no puede superar la duración.')
  .refine(p => Math.ceil(p.duracionS / p.pasoS) + 1 <= 20000, 'Hasta 20000 muestras estimadas.');
export type ParametrosVistaTransitorio = z.infer<typeof ParametrosVistaTransitorio>;
// El presupuesto estimado de entrada es 20000; la integración adaptativa admite 50000 muestras reales.
const serie = z.array(z.number().finite()).max(50000);
export const RespuestaVistaTransitorio = z.object({
  revisionProyecto: z.string().min(1), fechaUtc: z.string().datetime(),
  resuelto: z.literal(true), perfil: z.literal('transitorio-diseno-gpio-fijos'),
  t: serie.min(1), pines: z.record(z.string(), serie),
  elementos: z.record(z.string(), z.object({ tipo: z.string(), v: serie, i: serie, p: serie })),
  advertencias: z.array(z.string()), parametros: ParametrosVistaTransitorio,
  unidades: z.object({ t: z.literal('s'), v: z.literal('V'), i: z.literal('A'), p: z.literal('W'), temperaturaC: z.literal('°C').optional(), energia: z.literal('J').optional() }),
  termica: z.record(z.string(), ResultadoTermicoRcSchema).optional(),
}).refine(r => r.t.every((t, i) => t >= 0 && (i === 0 || t > (r.t[i - 1] ?? -1))), 'Tiempos inválidos.')
  .refine(r => [...Object.values(r.pines), ...Object.values(r.elementos).flatMap(e => [e.v, e.i, e.p])].every(s => s.length === r.t.length), 'Series incompletas.')
  .refine(r => Object.entries(r.termica ?? {}).every(([id, v]) => (r.elementos[id]?.tipo === 'R' || r.elementos[id]?.tipo === 'S') && v.temperaturaC.length === r.t.length && v.inicioS === r.t[0]), 'Series térmicas incompletas o ajenas al circuito.');
export type RespuestaVistaTransitorio = z.infer<typeof RespuestaVistaTransitorio>;
export type ResultadoVistaAnalisis = {
  schemaVersion: 1; proyecto: string; revisionProyecto: string; fechaUtc: string; firmaVista: string;
} & ({ dominio: 'instantanea-dc'; resultado: InformePrototipo } | {
  dominio: 'transitorio-diseno' | 'termico-diseno'; resultado: RespuestaVistaTransitorio;
} | { dominio: 'ac-diseno'; resultado: RespuestaAc });

export type ConfiguracionTermicaVista = { elemento: string; modelo: ModeloTermicoRc };
