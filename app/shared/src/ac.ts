import { z } from 'zod';
const id = z.string().min(1).max(200);
export const MAX_FRECUENCIAS_AC = 10000;
export const ParametrosAcSchema = z.object({
  fuente: id, entrada: id, salida: id,
  inicioHz: z.number().finite().positive(), finHz: z.number().finite().positive(),
  puntosPorDecada: z.number().int().min(1).max(1000),
}).strict().refine(p => p.finHz > p.inicioHz, 'Fin debe superar inicio.')
  .refine(p => cantidadFrecuenciasAc(p) >= 2 && cantidadFrecuenciasAc(p) <= MAX_FRECUENCIAS_AC, 'Entre 2 y 10000 frecuencias.');
export type ParametrosAc = z.infer<typeof ParametrosAcSchema>;
export function cantidadFrecuenciasAc(p: { inicioHz?: number; finHz?: number; puntosPorDecada?: number }): number {
  if (typeof p.inicioHz !== 'number' || typeof p.finHz !== 'number' || typeof p.puntosPorDecada !== 'number') return NaN;
  return Math.floor((Math.log10(p.finHz) - Math.log10(p.inicioHz)) * p.puntosPorDecada + 1e-9) + 1;
}
export const ComplejoAcSchema = z.object({ real: z.number().finite(), imaginaria: z.number().finite() }).strict();
export type ComplejoAc = z.infer<typeof ComplejoAcSchema>;
const complejos = z.array(ComplejoAcSchema).min(2).max(MAX_FRECUENCIAS_AC);
const curva = z.array(z.number().finite().nullable()).min(2).max(MAX_FRECUENCIAS_AC);
export const OpcionesAcSchema = z.object({ fuentes: z.array(id).max(256), pines: z.array(id).max(1024), revisionProyecto: id, fechaUtc: z.string().datetime() });
export type OpcionesAc = z.infer<typeof OpcionesAcSchema>;
export const RespuestaAcSchema = z.object({
  resuelto: z.literal(true), perfil: z.literal('ac-pequena-senal-gpio-fijos'), revisionProyecto: id, fechaUtc: z.string().datetime(),
  parametros: ParametrosAcSchema, frecuenciaHz: z.array(z.number().finite().positive()).min(2).max(MAX_FRECUENCIAS_AC),
  entrada: complejos, salida: complejos, transferencia: complejos, gananciaDb: curva, faseGrados: curva,
  unidades: z.object({ frecuencia: z.literal('Hz'), tension: z.literal('V'), transferencia: z.literal('V/V'), ganancia: z.literal('dB'), fase: z.literal('°') }),
  advertencias: z.array(z.string()),
}).refine(r => [r.entrada, r.salida, r.transferencia, r.gananciaDb, r.faseGrados].every(v => v.length === r.frecuenciaHz.length), 'Series AC incompletas.')
  .refine(r => r.frecuenciaHz.length === cantidadFrecuenciasAc(r.parametros) && r.frecuenciaHz.every((f, k) => Math.abs(Math.log10(f) - Math.log10(r.parametros.inicioHz) - k * (Math.log10(r.parametros.finHz) - Math.log10(r.parametros.inicioHz)) / (r.frecuenciaHz.length - 1)) < 1e-8), 'Barrido AC incompleto.')
  .refine(r => r.gananciaDb.every((v, k) => (v === null) === (r.faseGrados[k] === null)) && r.faseGrados.every(v => v === null || Math.abs(v) <= 180), 'Fase AC inválida.');
export type RespuestaAc = z.infer<typeof RespuestaAcSchema>;
