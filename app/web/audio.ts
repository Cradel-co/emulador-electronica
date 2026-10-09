import { armonicosDePulso } from '@emu/shared';
import type { EventoSonido, FORMAS_ONDA } from '@emu/shared';

/**
 * Adaptador de audio del navegador: convierte los eventos de sonido que manda el server en
 * tonos reales. El emulador no sintetiza nada — el DAC lo pone la placa de sonido de la
 * máquina — así que acá solo se traduce "el módulo bz1 zumba a 2,4 kHz con amplitud 0,6" a
 * un oscilador con su ganancia. Ver docs/audio.md.
 *
 * La Web Audio API entra por un puerto propio (`ContextoAudio`) y no se propaga: el resto de
 * la app no conoce `AudioContext`, `OscillatorNode` ni `GainNode`. Eso la hace testeable sin
 * navegador y permite cambiar de biblioteca sin tocar el dominio.
 */

type FormaOnda = (typeof FORMAS_ONDA)[number];

/** Una voz: un oscilador con su propia ganancia. Una por módulo que suena. */
export interface VozAudio {
  frecuencia(hz: number): void;
  ganancia(valor: number): void;
  forma(f: FormaOnda): void;
  /**
   * Ciclo de trabajo (0..1): sintetiza la onda del pulso real, así que cambia el **timbre**. No
   * toca el volumen, que lo pone `ganancia`.
   */
  ciclo(duty: number): void;
  /** Baja la ganancia a cero. La voz se conserva: los osciladores no se pueden rearrancar. */
  detener(): void;
}

export interface ContextoAudio {
  crearVoz(): VozAudio;
  reanudar(): Promise<void>;
  cerrar(): Promise<void>;
}

export interface EstadoAudio {
  /** El contexto existe. Hasta que el usuario haga un gesto, el navegador no lo permite. */
  habilitado: boolean;
  silenciado: boolean;
  /** 0..1. Arranca a la mitad: una onda cuadrada de 2,4 kHz a volumen pleno es molesta. */
  volumen: number;
  /** Ids de los módulos que están sonando, hayan llegado a oírse o no. */
  sonando: string[];
}

const VOLUMEN_INICIAL = 0.5;
/**
 * Armónicos de la onda del pulso. Con 64, a 440 Hz se cubre todo el rango audible; el navegador
 * se encarga de limitar la banda para que no haya aliasing.
 */
const ARMONICOS = 64;
/** Resolución del ciclo de trabajo para cachear ondas: 1 % alcanza y el oído no distingue más. */
const PASOS_DUTY = 100;

/**
 * El puerto real sobre la Web Audio API. Es el único lugar del repo que la toca.
 *
 * Los cambios de frecuencia y de ganancia se hacen con una rampa de 5 ms: aplicarlos de golpe
 * produce un clic audible. Y una voz que se calla no detiene su oscilador, porque un
 * `OscillatorNode` no se puede volver a arrancar: baja la ganancia y queda lista para reusarse.
 */
export function contextoWebAudio(): ContextoAudio {
  const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Constructor();
  const maestro = ctx.createGain();
  maestro.connect(ctx.destination);
  const rampa = 0.005;
  /**
   * Ondas ya armadas, por ciclo de trabajo redondeado a 1/PASOS_DUTY. Construir una por nota
   * sería desperdicio, y el oído no distingue un 24 % de un 25 %.
   */
  const ondas = new Map<number, PeriodicWave>();
  const ondaDe = (duty: number): PeriodicWave => {
    const paso = Math.round(Math.min(1, Math.max(0, duty)) * PASOS_DUTY);
    const guardada = ondas.get(paso);
    if (guardada) return guardada;
    const { cos, sen } = armonicosDePulso(paso / PASOS_DUTY, ARMONICOS);
    // `createPeriodicWave` normaliza: el volumen lo sigue poniendo la ganancia, no la forma.
    const onda = ctx.createPeriodicWave(cos, sen);
    ondas.set(paso, onda);
    return onda;
  };
  return {
    crearVoz() {
      const osc = ctx.createOscillator();
      const gan = ctx.createGain();
      gan.gain.value = 0;
      osc.connect(gan);
      gan.connect(maestro);
      osc.start();
      return {
        frecuencia: (hz) => osc.frequency.setTargetAtTime(hz, ctx.currentTime, rampa),
        ganancia: (v) => gan.gain.setTargetAtTime(v, ctx.currentTime, rampa),
        forma: (f) => { osc.type = f === 'seno' ? 'sine' : 'square'; },
        ciclo: (duty) => osc.setPeriodicWave(ondaDe(duty)),
        detener: () => gan.gain.setTargetAtTime(0, ctx.currentTime, rampa),
      };
    },
    reanudar: () => ctx.resume(),
    cerrar: () => ctx.close(),
  };
}

/** Lo último que se le aplicó a una voz, para no repetir órdenes que no cambian nada. */
interface Aplicado { hz: number; ganancia: number; forma: FormaOnda; duty?: number }

export class ControladorAudio {
  snapshot: EstadoAudio = { habilitado: false, silenciado: false, volumen: VOLUMEN_INICIAL, sonando: [] };
  private ctx: ContextoAudio | null = null;
  private voces = new Map<string, VozAudio>();
  private aplicado = new Map<string, Aplicado>();
  /** El último evento de cada módulo, haya sonado o no: al habilitar hay que poder arrancarlos. */
  private ultimos = new Map<string, EventoSonido>();
  private oyentes = new Set<() => void>();

  constructor(private crearContexto: () => ContextoAudio = contextoWebAudio) {}

  suscribir = (fn: () => void) => { this.oyentes.add(fn); return () => { this.oyentes.delete(fn); }; };
  leer = () => this.snapshot;

  private cambiar(c: Partial<EstadoAudio>) {
    this.snapshot = { ...this.snapshot, ...c };
    for (const f of this.oyentes) f();
  }

  /** Tiene que llamarse desde un gesto del usuario: el navegador no deja crear audio solo. */
  async habilitar(): Promise<void> {
    if (!this.ctx) this.ctx = this.crearContexto();
    await this.ctx.reanudar();
    this.cambiar({ habilitado: true });
    for (const e of this.ultimos.values()) this.sincronizar(e);
  }

  aplicar(evento: EventoSonido): void {
    this.ultimos.set(evento.modulo, evento);
    const sonando = [...this.ultimos.values()].filter((e) => this.suena(e)).map((e) => e.modulo).sort();
    this.sincronizar(evento);
    this.cambiar({ sonando });
  }

  silenciar(valor: boolean): void {
    this.cambiar({ silenciado: valor });
    this.reaplicar();
  }

  cambiarVolumen(valor: number): void {
    this.cambiar({ volumen: Math.min(1, Math.max(0, valor)) });
    this.reaplicar();
  }

  /** Corta todo y cierra el contexto (cambio de proyecto, desconexión, salir de la página). */
  async detener(): Promise<void> {
    for (const voz of this.voces.values()) voz.detener();
    this.voces.clear();
    this.aplicado.clear();
    this.ultimos.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.cambiar({ habilitado: false, sonando: [] });
    await ctx?.cerrar();
  }

  /** Un evento suena si lo dice y además trae una frecuencia usable (sin Hz no hay tono). */
  private suena(e: EventoSonido): boolean {
    return e.sonando && typeof e.hz === 'number' && Number.isFinite(e.hz) && e.hz > 0;
  }

  private reaplicar(): void {
    for (const e of this.ultimos.values()) this.sincronizar(e);
  }

  private sincronizar(evento: EventoSonido): void {
    if (!this.ctx || !this.snapshot.habilitado) return;
    const voz = this.voces.get(evento.modulo);
    if (!this.suena(evento)) {
      if (voz) { voz.detener(); this.aplicado.delete(evento.modulo); }
      return;
    }
    const forma = evento.forma ?? 'cuadrada';
    const deseado: Aplicado = {
      hz: evento.hz!,
      ganancia: this.snapshot.silenciado ? 0 : evento.ganancia * this.snapshot.volumen,
      forma,
      // Un seno no tiene ciclo de trabajo: ahí el duty no significa nada y se ignora.
      duty: forma === 'cuadrada' && typeof evento.duty === 'number' ? evento.duty : undefined,
    };
    const actual = this.aplicado.get(evento.modulo);
    const destino = voz ?? this.ctx.crearVoz();
    if (!voz) this.voces.set(evento.modulo, destino);
    if (deseado.duty === undefined) {
      if (actual?.forma !== deseado.forma || actual.duty !== undefined) destino.forma(deseado.forma);
    } else if (actual?.duty !== deseado.duty || actual.forma !== deseado.forma) {
      // La onda del pulso reemplaza la forma genérica: lleva el timbre del ciclo de trabajo.
      destino.ciclo(deseado.duty);
    }
    if (actual?.hz !== deseado.hz) destino.frecuencia(deseado.hz);
    if (actual?.ganancia !== deseado.ganancia) destino.ganancia(deseado.ganancia);
    this.aplicado.set(evento.modulo, deseado);
  }
}

/** El controlador de la app. Los eventos del WebSocket entran por acá (lo llama app.ts). */
export const audio = new ControladorAudio();
export const eventoSonido = (evento: EventoSonido) => audio.aplicar(evento);
export const detenerAudio = () => { void audio.detener(); };

if (typeof window !== 'undefined') window.addEventListener('pagehide', detenerAudio);
