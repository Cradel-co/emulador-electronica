import { z } from 'zod';
const temperatura = z.number().finite().min(-273.15);
/** Parámetros declarados por el usuario; no identifica ni certifica hardware. */
export const ModeloTermicoRcSchema = z.object({
  id: z.string().trim().min(1).max(2000), fuente: z.string().trim().min(1).max(2000),
  condiciones: z.string().trim().min(1).max(2000),
  resistenciaKPorW: z.number().finite().positive(), capacidadJPorK: z.number().finite().positive(),
  // Inicial corresponde a la primera muestra del transitorio, no a un tiempo anterior.
  ambienteC: temperatura, inicialC: temperatura, rangoDeclaradoC: z.tuple([temperatura, temperatura]),
}).strict().superRefine((m, ctx) => {
  const [min, max] = m.rangoDeclaradoC;
  if (min >= max) ctx.addIssue({ code: 'custom', message: 'El rango térmico debe ser creciente.', path: ['rangoDeclaradoC'] });
  if ([m.ambienteC, m.inicialC].some(t => t < min || t > max)) ctx.addIssue({ code: 'custom', message: 'Ambiente e inicial deben estar dentro del rango declarado.' });
  const tau = m.resistenciaKPorW * m.capacidadJPorK;
  if (!Number.isFinite(tau) || tau <= 0) ctx.addIssue({ code: 'custom', message: 'La constante térmica debe ser positiva y finita.' });
});
export type ModeloTermicoRc = z.infer<typeof ModeloTermicoRcSchema>;
export const ResultadoTermicoRcSchema = z.object({
  perfil: z.literal('termico-rc-unidireccional'), caracterizadoEnLaboratorio: z.literal(false),
  modelo: ModeloTermicoRcSchema, inicioS: z.number().finite().nonnegative(),
  temperaturaC: z.array(temperatura).min(2).max(50000),
  // La energía evacuada puede ser negativa: el ambiente aporta calor al cuerpo.
  energiaDisipadaJ: z.number().finite().nonnegative(), energiaAlmacenadaDeltaJ: z.number().finite(), energiaEvacuadaJ: z.number().finite(),
}).superRefine((r, ctx) => {
  const [min, max] = r.modelo.rangoDeclaradoC;
  if (r.temperaturaC.some(t => t < min || t > max)) ctx.addIssue({ code: 'custom', message: 'Resultado fuera del rango térmico declarado.' });
});
export type ResultadoTermicoRc = z.infer<typeof ResultadoTermicoRcSchema>;
