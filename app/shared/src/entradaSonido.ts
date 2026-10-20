import { z } from 'zod';
export const ReferenciaSonidoSchema = z.object({
  dbfs: z.number().finite().min(-120).max(0),
  nivel: z.number().finite().min(0).max(180),
}).strict();
export const MuestraEntradaSonidoSchema = z.object({
  secuencia: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  dbfs: z.number().finite().min(-160).max(0).nullable(),
  referencia: ReferenciaSonidoSchema,
}).strict();
export type ReferenciaSonido = z.infer<typeof ReferenciaSonidoSchema>;
export type MuestraEntradaSonido = z.infer<typeof MuestraEntradaSonidoSchema>;
export interface EntradaSonido extends MuestraEntradaSonido {
  origen: 'microfono'; nivelEstimado: number; recibidoMs: number;
}
/** Referencia de simulación, sin ponderación A ni acreditación acústica. Silencio digital usa estímulo cero. */
export function nivelDesdeDbfs(dbfs: number | null, referencia: ReferenciaSonido): number {
  return dbfs === null ? 0 : dbfs - referencia.dbfs + referencia.nivel;
}
