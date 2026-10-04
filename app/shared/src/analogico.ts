import { z } from 'zod';

export const CanalAnalogicoAvrSchema = z.enum(['0', '1', '2', '3', '4', '5', 'bandgap', 'gnd']);
export type CanalAnalogicoAvr = z.infer<typeof CanalAnalogicoAvrSchema>;
const noNegativo = z.number().finite().nonnegative();

/** Parámetros declarados por el usuario; no constituyen una calibración de fábrica del Uno. */
export const PerfilAnalogicoAvrSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('ideal-10bits') }).strict(),
  z.object({
    tipo: z.literal('rc-no-ideal'),
    id: z.string().trim().min(1).max(120),
    fuente: z.string().trim().min(1).max(2000),
    condiciones: z.string().trim().min(1).max(2000),
    rangoVEntrada: z.object({ min: noNegativo, max: noNegativo }).strict(),
    capacitanciaF: z.number().finite().positive(),
    resistenciaInterruptorOhm: noNegativo,
    /** Impedancia de Thévenin vista en cada entrada. Ausente/null significa desconocida. */
    resistenciasFuenteOhm: z.record(CanalAnalogicoAvrSchema, noNegativo.nullable()),
    adquisicionS: noNegativo,
    voltajeInicialV: noNegativo,
    /** Multiplica la cuenta continua; offsetLsb se suma después, antes de cuantizar. */
    ganancia: z.number().finite().positive(),
    offsetLsb: z.number().finite(),
    ruido: z.object({
      tipo: z.literal('uniforme'),
      amplitudLsb: noNegativo,
      semilla: z.number().int().min(0).max(0xffffffff),
    }).strict().nullable(),
  }).strict(),
]).superRefine((perfil, ctx) => {
  if (perfil.tipo === 'rc-no-ideal' && perfil.rangoVEntrada.max <= perfil.rangoVEntrada.min) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rangoVEntrada'], message: 'El rango de entrada debe tener min < max.' });
  }
});
export type PerfilAnalogicoAvr = z.infer<typeof PerfilAnalogicoAvrSchema>;
