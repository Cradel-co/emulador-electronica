import { z } from 'zod';

/**
 * Salida de sonido de un módulo y su traducción a lo que el navegador tiene que sintetizar.
 *
 * El emulador NO convierte números en voltaje: el DAC lo pone la placa de sonido de la
 * máquina del usuario. Acá se arma la *descripción* del sonido (qué frecuencia, con cuánta
 * amplitud, desde qué módulo) y el adaptador del navegador la reproduce.
 *
 * La frecuencia no sale del motor: sin análisis transitorio no hay forma de calcularla. Sale
 * de la hoja de datos cuando el oscilador es interno al componente (`fuente: "nivel"`) o la
 * declara el firmware cuando la pone el micro (`fuente: "pwm"`). Lo que sí se deriva de lo
 * que calculó el motor es la amplitud. Ver SDD-AUDIO.md.
 */

export const FUENTES_SONIDO = ['nivel', 'pwm', 'i2s'] as const;
export const FORMAS_ONDA = ['cuadrada', 'seno'] as const;

export const SalidaSonidoSchema = z
  .object({
    tipo: z.literal('sonido'),
    /**
     * De dónde sale la frecuencia. Es el único campo que distingue los tres casos:
     *  - `nivel`: el componente trae su oscilador y suena si le llega tensión (buzzer activo).
     *  - `pwm`: la frecuencia la pone el micro y la declara el puente (buzzer pasivo).
     *  - `i2s`: un flujo de muestras hacia un DAC externo.
     */
    fuente: z.enum(FUENTES_SONIDO),
    /** Entre qué dos pines se mide la tensión que lo alimenta (el `+` primero). */
    pins: z.tuple([z.string().min(1), z.string().min(1)]),
    /** Frecuencia fija de la hoja de datos (Hz). Solo con `fuente: "nivel"`. */
    hz: z.number().positive().optional(),
    /** Tensión mínima a la que arranca el oscilador (V). Por debajo no suena: no suena flojo. */
    umbralV: z.number().nonnegative().optional(),
    /** Presión sonora de la hoja de datos (dBA) a la tensión y distancia de `referencia`. */
    dbA: z.number().optional(),
    referencia: z.object({ v: z.number().positive(), cm: z.number().positive() }).optional(),
    forma: z.enum(FORMAS_ONDA).optional(),
  })
  .strict();

export type SalidaSonido = z.infer<typeof SalidaSonidoSchema>;

/** Lo que el server le manda al navegador para que un módulo suene. */
export interface EventoSonido {
  /** Id de la instancia del módulo en el diagrama. */
  modulo: string;
  sonando: boolean;
  /** Amplitud relativa, 0..1. */
  ganancia: number;
  hz?: number;
  forma?: (typeof FORMAS_ONDA)[number];
  /** Presión sonora estimada a la distancia de referencia (dBA). Informa; no la reproduce. */
  dbA?: number;
}

/**
 * Amplitud relativa (0..1) de un transductor alimentado con `v`, contra la tensión de su hoja
 * de datos. La presión sonora es proporcional a la tensión, así que la amplitud también.
 *
 * Se recorta en 1: por encima de su tensión nominal un buzzer distorsiona y se daña, no suena
 * proporcionalmente más fuerte. El aviso de que se está pasando es tarea del `model.js`.
 */
export function gananciaPorTension(v: number, referenciaV: number): number {
  if (!(referenciaV > 0) || !(v > 0)) return 0;
  return Math.min(1, v / referenciaV);
}

/**
 * Presión sonora estimada (dBA) a la distancia de referencia: cada vez que se duplica la
 * tensión suben 6 dB. A diferencia de la ganancia, esto no se recorta: es un dato que se
 * informa, no una señal que se reproduce.
 */
export function dbAPorTension(dbAReferencia: number, v: number, referenciaV: number): number {
  if (!(referenciaV > 0) || !(v > 0)) return -Infinity;
  return dbAReferencia + 20 * Math.log10(v / referenciaV);
}

/**
 * El evento de sonido de un módulo cuyo oscilador es interno (`fuente: "nivel"`), a partir de
 * la tensión que el motor calculó entre sus pines.
 *
 * Sin `referencia` no se inventa una curva de volumen: suena a amplitud plena. Sin `umbralV`,
 * cualquier tensión positiva lo hace sonar.
 */
export function eventoPorNivel(modulo: string, salida: SalidaSonido, v: number): EventoSonido {
  const sonando = salida.umbralV === undefined ? v > 0 : v >= salida.umbralV;
  if (!sonando) return { modulo, sonando: false, ganancia: 0, hz: salida.hz, forma: salida.forma };
  const ganancia = salida.referencia ? gananciaPorTension(v, salida.referencia.v) : 1;
  const evento: EventoSonido = { modulo, sonando: true, ganancia, hz: salida.hz, forma: salida.forma };
  if (salida.dbA !== undefined && salida.referencia) evento.dbA = dbAPorTension(salida.dbA, v, salida.referencia.v);
  return evento;
}
