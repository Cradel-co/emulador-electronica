import { z } from 'zod';

/** Instancia de un módulo dentro del dibujo de un proyecto. */
export const ModuleInstanceSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.string().min(1),
  x: z.number(),
  y: z.number(),
  /** Grados, sentido horario, alrededor del centro del dibujo. Sin campo = 0 (proyectos viejos). */
  rotation: z.number().min(0).lt(360).optional(),
  props: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  /**
   * Lo que mide del mundo un módulo con chip (temperatura, humedad...), si el usuario lo movió.
   * Lo que falte toma el `default` del chip (chips/<id>/chip.json).
   */
  entorno: z.record(z.string(), z.number()).optional(),
});

export type ModuleInstance = z.infer<typeof ModuleInstanceSchema>;

export const WireSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export type Wire = z.infer<typeof WireSchema>;
