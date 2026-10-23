import { z } from 'zod';

const CambioBanco = z.object({ instanteMs: z.number().int().min(0).max(5000),
  alimentacion: z.boolean(), reset: z.boolean(),
}).strict();
/** Cada consulta reproduce una historia acotada; no mantiene una corrida global. */
export const SolicitudBancoComponentesSchema = z.object({
  hastaMs: z.number().int().min(0).max(5000),
  representacion: z.enum(['separada', 'completa']),
  cambios: z.array(CambioBanco).min(1).max(32),
}).strict().superRefine((s, ctx) => {
  if (s.cambios[0]?.instanteMs !== 0 || s.cambios.some((c, i) => c.instanteMs > s.hastaMs || (i > 0 && c.instanteMs <= (s.cambios[i - 1]?.instanteMs ?? -1)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'La historia comienza en 0 y sus cambios son estrictamente crecientes hasta el horizonte.' });
  }
});
export type SolicitudBancoComponentes = z.infer<typeof SolicitudBancoComponentesSchema>;
export const ResultadoBancoComponentesSchema = z.object({
  motor: z.literal('componentes-propios'),
  muestras: z.array(z.object({ instanteMs: z.number().finite(), alimentacion: z.boolean(), reset: z.boolean(),
    estado: z.enum(['apagado', 'reset', 'alto', 'alta-impedancia']),
    fuenteV: z.number().finite(), salidaV: z.number().finite(), ledV: z.number().finite(),
    corrienteMa: z.number().finite(), ledEncendido: z.boolean(),
  })).min(1).max(54),
  instancias: z.array(z.object({ ruta: z.array(z.string()), tipo: z.string(), dominios: z.array(z.enum(['electrico', 'funcional'])) })).min(1).max(20),
  avisos: z.array(z.string()),
});
export type ResultadoBancoComponentes = z.infer<typeof ResultadoBancoComponentesSchema>;
