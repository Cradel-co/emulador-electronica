import { z } from 'zod';

const numero = z.number().finite();
const texto = z.string().trim().min(1).max(2000);
const antena = z.object({
  id: z.string().trim().min(1).max(200), modelo: texto, fuente: texto, condiciones: texto,
  /** Ganancia en la dirección del otro extremo; no la ganancia máxima del catálogo. */
  gananciaDbi: numero.describe('Ganancia en dBi en la dirección del otro extremo, no la ganancia pico.'),
  /** Alimentación y adaptación; no incluye pérdidas de propagación ni polarización. */
  perdidasDb: numero.nonnegative().describe('Pérdidas de alimentación/adaptación, en dB; no incluyen propagación ni polarización.'),
  dimensionAntenaM: numero.positive(),
}).strict();

/** Contrato propio y opcional. Ningún parámetro se deduce del nombre comercial ni del dibujo. */
export const CanalRfSchema = z.object({
  frecuenciaHz: numero.positive(), distanciaM: numero.positive(),
  dominio: z.object({
    espacioLibre: z.boolean(), lineaDeVista: z.boolean(), campoLejano: z.boolean(),
    sinMultitrayecto: z.boolean(), sinInterferencias: z.boolean(),
  }).strict(),
  transmisor: antena.extend({ potencia: z.discriminatedUnion('unidad', [
    z.object({ valor: numero, unidad: z.literal('dBm') }).strict(),
    z.object({ valor: numero.positive(), unidad: z.literal('mW') }).strict(),
    z.object({ valor: numero.positive(), unidad: z.literal('W') }).strict(),
  ]).describe('Potencia conducida antes de las pérdidas declaradas de alimentación de la antena.') }).strict(),
  receptor: antena.extend({
    sensibilidadDbm: numero.optional(),
    /** Ruido referido a la entrada para el ancho de banda/configuración declarados. */
    ruido: z.object({ potenciaDbm: numero, snrMinimoDb: numero, fuente: texto, condiciones: texto }).strict().optional(),
  }).strict(),
  polarizacion: z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('lineal'), anguloGrados: numero.min(0).max(90) }).strict(),
    z.object({ tipo: z.literal('perdida-declarada'), perdidaDb: numero.nonnegative(), fuente: texto }).strict(),
  ]),
  /** Las condiciones de sensibilidad, ruido y ganancias deben corresponder a este modo. */
  configuracion: z.object({ modulacion: texto, tasaBitsPorS: numero.positive(), anchoBandaHz: numero.positive() }).strict(),
}).strict();
export type CanalRf = z.infer<typeof CanalRfSchema>;

export const FUENTES_CANAL_RF = [
  'https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.525-5-202411-I!!PDF-E.pdf',
  'https://www.keysight.com/kr/ko/assets/9018-07604/article-reprints/9018-07604.pdf',
  'https://www.ti.com/lit/an/swra479a/swra479a.pdf',
  'https://www.mathworks.com/help/phased/ref/polloss.html',
] as const;

export interface PresupuestoRf {
  modo: 'friis-espacio-libre';
  estado: 'sobre-umbral' | 'bajo-umbral' | 'sin-criterio' | 'polarizacion-ortogonal';
  permitirRecepcion: boolean;
  parametros: CanalRf;
  longitudOndaM: number;
  distanciaMinimaCampoLejanoM: number;
  potenciaTransmitidaDbm: number;
  eirpDbm: number;
  perdidaEspacioLibreDb: number;
  /** null representa pérdida infinita para dos polarizaciones lineales ortogonales ideales. */
  perdidaPolarizacionDb: number | null;
  /** null con potenciaRecibidaW=0 representa ausencia ideal de señal, no un valor desconocido. */
  potenciaRecibidaDbm: number | null;
  potenciaRecibidaW: number;
  umbralDbm: number | null;
  margenDb: number | null;
  advertencias: string[];
}
export type EvaluacionRf = PresupuestoRf | {
  modo: 'funcional' | 'no-resuelto';
  estado: 'sin-modelo' | 'datos-invalidos' | 'fuera-dominio';
  permitirRecepcion: boolean;
  advertencias: string[];
};

const C_M_POR_S = 299792458; // Velocidad de la luz en vacío, valor exacto SI.

function noResuelto(estado: 'datos-invalidos' | 'fuera-dominio', advertencias: string[]): EvaluacionRf {
  return { modo: 'no-resuelto', estado, permitirRecepcion: false, advertencias };
}

export function evaluarCanalRf(entrada?: unknown): EvaluacionRf {
  if (entrada === undefined) return { modo: 'funcional', estado: 'sin-modelo', permitirRecepcion: true,
    advertencias: ['RF funcional: se inyectan bits sin acreditar alcance, potencia recibida ni tasa de errores.'] };
  const pedido = CanalRfSchema.safeParse(entrada);
  if (!pedido.success) return noResuelto('datos-invalidos', pedido.error.issues.map(e => `${e.path.join('.')}: ${e.message}`));
  const c = pedido.data;
  const incumplidas = Object.entries(c.dominio).filter(([, cumple]) => !cumple).map(([nombre]) => nombre);
  if (incumplidas.length) return noResuelto('fuera-dominio', [`Friis requiere espacio libre, LOS y campo lejano, sin multitrayecto ni interferencias. No declarado: ${incumplidas.join(', ')}.`]);
  const longitudOndaM = C_M_POR_S / c.frecuenciaHz;
  // Perfil conservador: condiciones de Fraunhofer para ambas antenas y 10λ para antenas pequeñas.
  // Keysight Antenna Measurement Theory; no es una acreditación de campo lejano en el montaje.
  const distanciaMinimaCampoLejanoM = Math.max(10 * longitudOndaM,
    2 * c.transmisor.dimensionAntenaM ** 2 / longitudOndaM,
    2 * c.receptor.dimensionAntenaM ** 2 / longitudOndaM);
  if (!Number.isFinite(longitudOndaM) || !Number.isFinite(distanciaMinimaCampoLejanoM)) {
    return noResuelto('datos-invalidos', ['Frecuencia o dimensiones fuera del rango numérico representable.']);
  }
  if (c.distanciaM <= distanciaMinimaCampoLejanoM) return noResuelto('fuera-dominio', [
    `Campo lejano no admitido: distancia ${c.distanciaM} m; este perfil exige más de ${distanciaMinimaCampoLejanoM} m (máximo de 10λ y 2D²/λ de ambas antenas).`,
  ]);
  const p = c.transmisor.potencia;
  const potenciaTransmitidaDbm = p.unidad === 'dBm' ? p.valor : 10 * Math.log10(p.valor) + (p.unidad === 'W' ? 30 : 0);
  const eirpDbm = potenciaTransmitidaDbm + c.transmisor.gananciaDbi - c.transmisor.perdidasDb;
  // ITU-R P.525-5, ecuación 5; sumar logaritmos evita overflow del producto d·f.
  const perdidaEspacioLibreDb = 20 * (Math.log10(4 * Math.PI) + Math.log10(c.distanciaM) - Math.log10(longitudOndaM));
  const ortogonal = c.polarizacion.tipo === 'lineal' && c.polarizacion.anguloGrados === 90;
  const perdidaPolarizacionDb = ortogonal ? null : c.polarizacion.tipo === 'perdida-declarada'
    ? c.polarizacion.perdidaDb : -20 * Math.log10(Math.cos(c.polarizacion.anguloGrados * Math.PI / 180));
  const potenciaRecibidaDbm = perdidaPolarizacionDb === null ? null
    : eirpDbm - perdidaEspacioLibreDb + c.receptor.gananciaDbi - c.receptor.perdidasDb - perdidaPolarizacionDb;
  const potenciaRecibidaW = potenciaRecibidaDbm === null ? 0 : 10 ** ((potenciaRecibidaDbm - 30) / 10);
  const umbrales: number[] = [];
  if (c.receptor.sensibilidadDbm !== undefined) umbrales.push(c.receptor.sensibilidadDbm);
  if (c.receptor.ruido) umbrales.push(c.receptor.ruido.potenciaDbm + c.receptor.ruido.snrMinimoDb);
  const umbralDbm = umbrales.length ? Math.max(...umbrales) : null;
  const margenDb = umbralDbm === null || potenciaRecibidaDbm === null ? null : potenciaRecibidaDbm - umbralDbm;
  const numericos = [potenciaTransmitidaDbm, eirpDbm, perdidaEspacioLibreDb, perdidaPolarizacionDb,
    potenciaRecibidaDbm, potenciaRecibidaW, umbralDbm, margenDb].filter(v => v !== null);
  if (!numericos.every(Number.isFinite) || (!ortogonal && potenciaRecibidaW === 0)) {
    return noResuelto('datos-invalidos', ['Presupuesto fuera del rango numérico representable; no se interpreta como señal cero.']);
  }
  const estado = ortogonal ? 'polarizacion-ortogonal' : margenDb === null ? 'sin-criterio' : margenDb >= 0 ? 'sobre-umbral' : 'bajo-umbral';
  return {
    modo: 'friis-espacio-libre', estado, permitirRecepcion: estado === 'sobre-umbral', parametros: c,
    longitudOndaM, distanciaMinimaCampoLejanoM, potenciaTransmitidaDbm, eirpDbm, perdidaEspacioLibreDb,
    perdidaPolarizacionDb, potenciaRecibidaDbm, potenciaRecibidaW, umbralDbm, margenDb,
    advertencias: [
      'Presupuesto ideal con parámetros declarados: no acredita alcance físico, BER/PER, ruido aleatorio, obstáculos, multitrayecto ni selectividad.',
      ...(estado === 'sin-criterio' ? ['Sin sensibilidad o ruido+SNR declarados no se decide recepción ni se inyecta la trama.'] : []),
    ],
  };
}

/** Filtra el presupuesto; el adaptador también debe validar destino eléctrico y transporte. */
export async function transmitirPorCanalRf(
  bits: string, protocolo: number, canalRf: unknown,
  enviar: (bits: string, protocolo: number, canalRf?: unknown) => boolean | Promise<boolean>,
): Promise<{ evaluacion: EvaluacionRf; entregado: boolean }> {
  const evaluacion = evaluarCanalRf(canalRf);
  return { evaluacion, entregado: evaluacion.permitirRecepcion ? await enviar(bits, protocolo, canalRf) : false };
}
