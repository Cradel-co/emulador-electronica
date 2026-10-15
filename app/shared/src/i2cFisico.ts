import { z } from 'zod';

const positivo = z.number().finite().positive();
const noNegativo = z.number().finite().nonnegative();
export const LineaI2cRcSchema = z.object({
  tensionPullupV: positivo,
  resistenciaPullupOhm: positivo.nullable(),
  capacitanciaF: positivo,
  resistenciaLowOhm: noNegativo,
  corrienteSinkMaxA: positivo,
  fugaA: noNegativo,
  vilMaxV: noNegativo,
  vihMinV: positivo,
  entradaMaxV: positivo,
}).strict().refine(l => l.vilMaxV < l.vihMinV && l.vihMinV <= l.entradaMaxV, 'Umbrales de entrada incompatibles');

/** Equivalente declarado de cada línea; no se infieren pF ni geometría del dibujo. */
export const PerfilI2cRcSchema = z.object({
  id: z.string().trim().min(1).max(200),
  fuente: z.string().trim().min(1).max(2000),
  condiciones: z.string().trim().min(1).max(2000),
  modo: z.enum(['standard', 'fast', 'fast-plus']),
  /** Fracción del periodo en que el maestro conduce SCL a bajo. */
  fraccionSclBaja: z.number().finite().gt(0).lt(1),
  sda: LineaI2cRcSchema,
  scl: LineaI2cRcSchema,
}).strict();
export const BusI2cFisicoSchema = z.object({
  sda: z.number().int().nonnegative(), scl: z.number().int().nonnegative(), perfil: PerfilI2cRcSchema,
}).strict().refine(b => b.sda !== b.scl, 'SDA y SCL deben ser distintos');
export const BusesI2cFisicosSchema = z.array(BusI2cFisicoSchema).max(4).refine(
  bs => new Set(bs.map(b => `${b.sda},${b.scl}`)).size === bs.length, 'Bus I2C duplicado',
);
export type LineaI2cRc = z.infer<typeof LineaI2cRcSchema>;
export type PerfilI2cRc = z.infer<typeof PerfilI2cRcSchema>;
