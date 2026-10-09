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
  /**
   * Ciclo de trabajo (0..1) con el que el micro está generando la señal. Define la **forma** de la
   * onda —el timbre—, no el volumen: ese ya viene en `ganancia`. Solo con `fuente: "pwm"`; un
   * oscilador interno no lo tiene.
   */
  duty?: number;
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
 * `veredicto` es lo que concluyó el modelo del módulo (`observar` → `ui.on`). **Cuando existe,
 * manda**: el modelo tiene el umbral real con su histéresis y además ve la corriente, así que
 * `umbralV` solo puede aproximarlo. Sin él, el módulo podría prender su dibujo y quedarse
 * callado, o sonar sin conducir.
 *
 * Sin `referencia` no se inventa una curva de volumen: suena a amplitud plena. Sin `umbralV` ni
 * veredicto, cualquier tensión positiva lo hace sonar.
 */
export function eventoPorNivel(
  modulo: string,
  salida: SalidaSonido,
  v: number,
  veredicto?: boolean,
): EventoSonido {
  const sonando = veredicto ?? (salida.umbralV === undefined ? v > 0 : v >= salida.umbralV);
  if (!sonando) return { modulo, sonando: false, ganancia: 0, hz: salida.hz, forma: salida.forma };
  const ganancia = salida.referencia ? gananciaPorTension(v, salida.referencia.v) : 1;
  const evento: EventoSonido = { modulo, sonando: true, ganancia, hz: salida.hz, forma: salida.forma };
  if (salida.dbA !== undefined && salida.referencia) evento.dbA = dbAPorTension(salida.dbA, v, salida.referencia.v);
  return evento;
}

/** Un PWM que el firmware declaró sobre un pin: su frecuencia y su ciclo de trabajo (0..1). */
export interface PwmDeclarado {
  hz: number;
  duty: number;
}

/**
 * El evento de sonido de un módulo cuya frecuencia la pone el micro (`fuente: "pwm"`): un piezo
 * pasivo, que no tiene oscilador propio.
 *
 * La frecuencia **la declara el firmware**, no se reconstruye de la señal: el puente muestrea los
 * registros de salida y un tono de kilohercios se perdería en el aliasing (ver SDD-AUDIO.md).
 * Sin PWM configurado no suena, en vez de inventar un tono.
 *
 * La amplitud sale de dos factores: la tensión, como en `fuente: "nivel"`, y el ciclo de trabajo.
 * El segundo va con **sen(π·duty)**, que sale de la **serie de Fourier** del pulso: la amplitud de
 * su fundamental es `(2V/π)·sen(π·duty)`. Se usa el fundamental porque el oído lo toma como la
 * nota y porque un piezo es resonante y filtra los armónicos. Es máxima al 50 %, nula en los
 * extremos —donde la señal es continua y no mueve aire— y simétrica: 25 % y 75 % suenan igual.
 * No modela el timbre, que sí cambia con el duty. Ver docs/audio.md.
 */
export function eventoPorPwm(
  modulo: string,
  salida: SalidaSonido,
  v: number,
  pwm: PwmDeclarado | undefined,
): EventoSonido {
  const usable = pwm !== undefined
    && Number.isFinite(pwm.hz) && pwm.hz > 0
    && Number.isFinite(pwm.duty) && pwm.duty > 0 && pwm.duty < 1
    && v > 0;
  if (!usable || pwm === undefined) return { modulo, sonando: false, ganancia: 0, forma: salida.forma };
  const porDuty = Math.sin(Math.PI * pwm.duty);
  const porTension = salida.referencia ? gananciaPorTension(v, salida.referencia.v) : 1;
  const evento: EventoSonido = {
    modulo,
    sonando: true,
    ganancia: porTension * porDuty,
    hz: pwm.hz,
    forma: salida.forma,
    duty: pwm.duty,
  };
  if (salida.dbA !== undefined && salida.referencia) {
    // El duty baja la presión sonora igual que una tensión menor: entra en el mismo cálculo.
    evento.dbA = dbAPorTension(salida.dbA, v * porDuty, salida.referencia.v);
  }
  return evento;
}

/**
 * Los eventos de sonido de un circuito ya resuelto: para cada módulo que declara una salida de
 * sonido, la tensión entre sus dos pines decide si suena y con cuánta amplitud.
 *
 * `tensiones` es lo que mediría un tester en cada pin cableado (`"<instancia>.<pin>"`), tal como
 * lo devuelve el motor. Un pin sin cablear no tiene entrada: entonces no hay tensión, y el módulo
 * no suena — se emite el evento en silencio igual, para que el navegador corte lo que venía
 * sonando si lo desconectaron.
 *
 * `uiDe` da lo que concluyó el modelo de cada instancia: si dijo `on`, ese veredicto decide si
 * suena, y la tensión queda solo para la amplitud. Un módulo sin modelo cae al `umbralV`.
 *
 * `pwmDe` da el PWM que el firmware declaró sobre un pin del módulo (el llamador resuelve a qué
 * GPIO está cableado). `i2s` todavía no genera evento: sin el flujo de muestras no hay nada que
 * sintetizar (ver SDD-AUDIO.md).
 */
export function sonidosDelCircuito(
  instancias: readonly { id: string; type: string }[],
  salidasDe: (type: string) => readonly SalidaSonido[] | undefined,
  tensiones: Readonly<Record<string, number>>,
  uiDe?: (id: string) => { on?: boolean; brillo?: number } | undefined,
  pwmDe?: (id: string, pin: string) => PwmDeclarado | undefined,
): EventoSonido[] {
  const eventos: EventoSonido[] = [];
  for (const inst of instancias) {
    for (const salida of salidasDe(inst.type) ?? []) {
      if (salida.tipo !== 'sonido' || salida.fuente === 'i2s') continue;
      const [mas, menos] = salida.pins;
      const vMas = tensiones[`${inst.id}.${mas}`];
      const vMenos = tensiones[`${inst.id}.${menos}`];
      const v = vMas === undefined || vMenos === undefined ? 0 : vMas - vMenos;
      if (salida.fuente === 'pwm') {
        eventos.push(eventoPorPwm(inst.id, salida, v, pwmDe?.(inst.id, mas)));
        continue;
      }
      const on = uiDe?.(inst.id)?.on;
      eventos.push(eventoPorNivel(inst.id, salida, v, typeof on === 'boolean' ? on : undefined));
    }
  }
  return eventos;
}

/**
 * Coeficientes de Fourier de un pulso de 0 a 1 con ciclo de trabajo `duty`, listos para
 * `createPeriodicWave` del navegador.
 *
 * Con ellos se sintetiza la onda **que el micro genera de verdad**, en vez de una cuadrada
 * simétrica a la que solo se le ajusta el volumen. Eso hace que el **timbre** cambie con el ciclo
 * de trabajo, como en un piezo real: un pulso angosto reparte más energía en los armónicos y se
 * oye más delgado y nasal.
 *
 * Para el pulso que arranca en t = 0:
 *
 *     aₙ = (2/nπ)·sen(2πnd)        bₙ = (2/nπ)·(1 − cos(2πnd))
 *
 * El término continuo (n = 0) se descarta: no produce sonido y solo correría la onda. Al 50 % esto
 * da la cuadrada clásica —armónicos impares con 4/nπ, pares en cero— y la magnitud del fundamental
 * sigue a sen(π·d), la misma ley que el volumen (ver `eventoPorPwm`).
 *
 * Ojo al usarlos: `createPeriodicWave` **normaliza** la onda por defecto, así que la amplitud que
 * sale de acá no se acumula con la ganancia del evento. Eso es a propósito: la forma la da esta
 * función y el volumen lo da la ganancia, sin contarse dos veces.
 */
export function armonicosDePulso(duty: number, armonicos: number): { cos: Float32Array; sen: Float32Array } {
  const n = Math.max(1, Math.floor(armonicos));
  const cos = new Float32Array(n + 1);
  const sen = new Float32Array(n + 1);
  const d = Math.min(1, Math.max(0, Number.isFinite(duty) ? duty : 0));
  // cos[0] y sen[0] quedan en 0: es el término continuo, que no suena.
  for (let k = 1; k <= n; k++) {
    const factor = 2 / (k * Math.PI);
    cos[k] = factor * Math.sin(2 * Math.PI * k * d);
    sen[k] = factor * (1 - Math.cos(2 * Math.PI * k * d));
  }
  return { cos, sen };
}
