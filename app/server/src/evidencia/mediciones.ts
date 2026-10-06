import { z } from 'zod';

/** Referencias de método, no tolerancias ni certificaciones del modelo. */
export const fuentesMetrologia = [
  'https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf',
  'https://www.bipm.org/en/doi/10.59161/jcgm106-2012',
  'https://ilac.org/publications-and-resources/ilac-guidance-series/',
] as const;
const texto = z.string().trim().min(1);
const numero = z.number().finite();
// UTC canónico: rechaza fechas normalizadas por Date (30 de febrero, etc.).
const fecha = texto.refine(s => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s)) return false;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) && d.toISOString() === (s.includes('.') ? s : s.replace('Z', '.000Z'));
}, 'Fecha UTC no válida');
const estimacion = z.object({
  valor: numero, unidad: texto, incertidumbreEstandar: numero.nonnegative(), presupuesto: texto,
  justificacionCero: texto.optional(),
}).strict().refine(e => e.incertidumbreEstandar !== 0 || Boolean(e.justificacionCero), 'Incertidumbre cero sin justificación');
const rango = z.object({ unidad: texto, min: numero, max: numero }).strict()
  .refine(r => r.min <= r.max, 'Rango invertido');
const esquema = z.object({
  schema: z.literal(1), id: texto,
  origen: z.enum(['sintetico', 'laboratorio']), uso: z.enum(['ajuste', 'validacion']),
  identidad: z.object({ modelo: texto, solver: texto, firmware: texto, hardware: texto, fixture: texto }).strict(),
  procedimiento: texto, instrumento: z.object({ id: texto, calibracion: texto }).strict(), registradoEn: fecha,
  dominio: z.object({ fenomeno: texto, magnitud: texto, unidad: texto, condiciones: z.record(rango) }).strict(),
  condiciones: z.record(z.object({ unidad: texto, valor: numero }).strict()),
  medicion: estimacion,
  prediccion: z.object({ ...estimacion.innerType().shape, fenomeno: texto }).strict()
    .refine(e => e.incertidumbreEstandar !== 0 || Boolean(e.justificacionCero), 'Incertidumbre cero sin justificación'),
  correlacion: z.object({ rho: numero.min(-1).max(1), justificacion: texto }).strict(),
  regla: z.object({ tipo: z.literal('intervalo-guardado'), limiteAbsoluto: numero.nonnegative(), k: numero.positive(), justificacion: texto, definidoEn: fecha, fuente: texto }).strict(),
}).strict();
export type RegistroMedicion = z.infer<typeof esquema>;
export type EstadoEvidencia = 'aceptado' | 'rechazado' | 'indeterminado' | 'no-evaluable' | 'fuera-de-dominio';
export interface InformeMedicion {
  schema: 1;
  estado: EstadoEvidencia;
  clasificacion: 'sintetico' | 'datos-declarados';
  /** El software nunca acredita una calibración, origen o campaña de laboratorio. */
  certificacion: false;
  diagnosticos: string[];
  fuentes: readonly string[];
  registro?: RegistroMedicion;
  diferencia?: number;
  incertidumbreDiferencia?: number;
  intervaloDiscrepancia?: { min: number; max: number; unidad: string };
}

/**
 * Evaluación escalar dentro del dominio declarado, con incertidumbres estándar
 * y correlación documentadas: uΔ²=uM²+uP²−2ρuMuP (GUM).
 * Regla no binaria elegida explícitamente por el caso, inspirada en bandas de
 * guarda JCGM106/ILAC G8. No estima riesgo probabilístico ni impone k=2.
 * Fechas, presupuestos y calibración son declaraciones del usuario: su orden
 * no prueba independencia, reserva de muestras ni autenticidad experimental.
 * Todas las unidades deben coincidir literalmente: no convierte unidades.
 */
export function evaluarMedicion(entrada: unknown): InformeMedicion {
  const base: InformeMedicion = { schema: 1, estado: 'no-evaluable', clasificacion: 'datos-declarados', certificacion: false, diagnosticos: [], fuentes: fuentesMetrologia };
  const validado = esquema.safeParse(entrada);
  if (!validado.success) return { ...base, diagnosticos: validado.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  const r = validado.data;
  base.registro = r;
  base.clasificacion = r.origen === 'sintetico' ? 'sintetico' : 'datos-declarados';
  const problemas: string[] = [];
  if (r.uso !== 'validacion') problemas.push('Los datos de ajuste no acreditan validación reservada.');
  if (Date.parse(r.regla.definidoEn) >= Date.parse(r.registradoEn)) problemas.push('La regla debe estar definida antes de registrar la comparación.');
  const nombres = Object.keys(r.dominio.condiciones);
  if (!Object.hasOwn(r.dominio.condiciones, 'tiempo')) problemas.push('El dominio requiere una condición temporal explícita.');
  if (nombres.length !== Object.keys(r.condiciones).length || nombres.some(n => !Object.hasOwn(r.condiciones, n))) problemas.push('Las condiciones observadas y declaradas deben coincidir completamente.');
  if (r.medicion.unidad !== r.dominio.unidad || r.prediccion.unidad !== r.dominio.unidad) problemas.push('Unidades de medición/predicción distintas del dominio.');
  for (const n of nombres) {
    const limite = r.dominio.condiciones[n]; const observado = r.condiciones[n];
    if (limite && observado && limite.unidad !== observado.unidad) problemas.push(`Unidad incompatible en ${n}.`);
  }
  if (problemas.length) return { ...base, diagnosticos: problemas };
  const fuera = nombres.filter(n => {
    const l = r.dominio.condiciones[n]; const o = r.condiciones[n];
    return l && o && (o.valor < l.min || o.valor > l.max);
  });
  if (r.prediccion.fenomeno !== r.dominio.fenomeno) fuera.push('fenomeno');
  if (fuera.length) return { ...base, estado: 'fuera-de-dominio', diagnosticos: fuera.map(n => `Fuera del dominio: ${n}.`) };
  const diferencia = Math.abs(r.medicion.valor - r.prediccion.valor);
  const um = r.medicion.incertidumbreEstandar; const up = r.prediccion.incertidumbreEstandar;
  // Forma equivalente evita cancelación de u²+u²−2u² para rho cercano a 1.
  const varianza = (um - up) ** 2 + 2 * (1 - r.correlacion.rho) * um * up;
  const incertidumbreDiferencia = Math.sqrt(varianza);
  const banda = r.regla.k * incertidumbreDiferencia;
  const min = Math.max(0, diferencia - banda); const max = diferencia + banda;
  if (![diferencia, varianza, incertidumbreDiferencia, banda, min, max].every(Number.isFinite)) return { ...base, diagnosticos: ['Aritmética no finita: no puede evaluarse la evidencia.'] };
  const estado = max <= r.regla.limiteAbsoluto ? 'aceptado' : min > r.regla.limiteAbsoluto ? 'rechazado' : 'indeterminado';
  return { ...base, estado, diferencia, incertidumbreDiferencia, intervaloDiscrepancia: { min, max, unidad: r.dominio.unidad } };
}
