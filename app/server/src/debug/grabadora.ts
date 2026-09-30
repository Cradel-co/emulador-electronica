/**
 * Grabadora del modo debug: siempre encendida, registra todo lo que pasa en una
 * corrida con su tiempo (ms desde que arrancó), en un buffer circular de tamaño fijo:
 * cambios de nivel de cada pin (de entrada y de salida, y quién los causó), líneas de
 * la consola, mensajes del puente, estados del emulador, compilaciones, avisos
 * eléctricos, LEDs que se queman, errores detectados y paradas del depurador.
 *
 * Barata a propósito: un evento es un objeto chico; cuando se llena, se pisa lo más
 * viejo (y se cuenta cuántos se perdieron). Aparte guarda lo que la instantánea
 * necesita siempre a mano aunque el buffer ya haya rotado: el último nivel de cada pin,
 * las últimas líneas de consola y los errores.
 */

export type TipoEvento = 'pin' | 'serial' | 'puente' | 'estado' | 'compilacion' | 'electrico' | 'led' | 'error' | 'debug' | 'app';

export interface EventoTraza {
  /** Número de orden (para pedir "lo nuevo desde X"). */
  seq: number;
  /** ms desde el arranque de la corrida. */
  t: number;
  tipo: TipoEvento;
  [dato: string]: unknown;
}

export interface EstadoPin {
  /** Último nivel de salida que reportó el firmware. */
  salida: 0 | 1 | null;
  /** Último nivel que la app puso en la entrada (botón, MCP...). */
  entrada: 0 | 1 | null;
  /** ms del último cambio. */
  tCambio: number | null;
  /** Cantidad de cambios en la corrida (un PWM se nota acá). */
  cambios: number;
  /** Quién puso la última entrada: 'ui', 'mcp'... */
  origenEntrada?: string;
}

const MAX_TEXTO = 300;

export class Grabadora {
  private buffer: (EventoTraza | undefined)[];
  private cabeza = 0;
  private cantidad = 0;
  private seq = 0;
  private perdidos = 0;
  private inicio = Date.now();
  readonly pines = new Map<number, EstadoPin>();
  private serial: { t: number; linea: string }[] = [];
  private errores: EventoTraza[] = [];
  /** Datos de la corrida (proyecto, placa...). */
  corrida: Record<string, unknown> = {};

  constructor(
    readonly capacidad = 5000,
    private readonly maxSerial = 300,
    private readonly maxErrores = 30,
  ) {
    this.buffer = new Array(capacidad);
  }

  /** Empieza una corrida nueva: vacía todo y el reloj vuelve a 0. */
  reiniciar(corrida: Record<string, unknown> = {}): void {
    this.buffer = new Array(this.capacidad);
    this.cabeza = 0;
    this.cantidad = 0;
    this.perdidos = 0;
    this.inicio = Date.now();
    this.pines.clear();
    this.serial = [];
    this.errores = [];
    this.corrida = { ...corrida, inicio: new Date(this.inicio).toISOString() };
  }

  /** ms desde el arranque de la corrida. */
  ahora(): number {
    return Date.now() - this.inicio;
  }

  get inicioMs(): number {
    return this.inicio;
  }

  registrar(tipo: TipoEvento, datos: Record<string, unknown> = {}): EventoTraza {
    const ev: EventoTraza = { seq: ++this.seq, t: this.ahora(), tipo };
    for (const [k, v] of Object.entries(datos)) {
      if (k === 'seq' || k === 't' || k === 'tipo') continue; // reservados de la traza
      ev[k] = typeof v === 'string' && v.length > MAX_TEXTO ? `${v.slice(0, MAX_TEXTO)}…` : v;
    }
    this.buffer[this.cabeza] = ev;
    this.cabeza = (this.cabeza + 1) % this.capacidad;
    if (this.cantidad < this.capacidad) this.cantidad++;
    else this.perdidos++;
    if (tipo === 'serial') {
      this.serial.push({ t: ev.t, linea: String(ev.linea ?? '') });
      if (this.serial.length > this.maxSerial) this.serial.splice(0, this.serial.length - this.maxSerial);
    } else if (tipo === 'error') {
      this.errores.push(ev);
      if (this.errores.length > this.maxErrores) this.errores.shift();
    }
    return ev;
  }

  /** Cambio de nivel de un pin: actualiza el estado y registra el evento (solo si cambió). */
  pin(pin: number, nivel: 0 | 1, direccion: 'salida' | 'entrada', origen: string): EventoTraza | null {
    let e = this.pines.get(pin);
    if (!e) {
      e = { salida: null, entrada: null, tCambio: null, cambios: 0 };
      this.pines.set(pin, e);
    }
    if (e[direccion] === nivel) return null;
    e[direccion] = nivel;
    e.tCambio = this.ahora();
    e.cambios++;
    if (direccion === 'entrada') e.origenEntrada = origen;
    return this.registrar('pin', { pin, nivel, direccion, origen });
  }

  /** Niveles de salida actuales (para la Ley de Ohm con la simulación en marcha). */
  nivelesSalida(): Map<number, 0 | 1> {
    const m = new Map<number, 0 | 1>();
    for (const [pin, e] of this.pines) if (e.salida !== null) m.set(pin, e.salida);
    return m;
  }

  /** Eventos (en orden) con seq > `desde`. */
  desde(desde = 0, opciones: { tipos?: TipoEvento[]; limite?: number } = {}): { eventos: EventoTraza[]; ultimoSeq: number; perdidos: number; seHuboSaltos: boolean } {
    const limite = Math.max(1, Math.min(opciones.limite ?? 500, this.capacidad));
    const tipos = opciones.tipos && opciones.tipos.length > 0 ? new Set(opciones.tipos) : null;
    const todos: EventoTraza[] = [];
    const primero = (this.cabeza - this.cantidad + this.capacidad) % this.capacidad;
    for (let i = 0; i < this.cantidad; i++) {
      const ev = this.buffer[(primero + i) % this.capacidad]!;
      if (ev.seq <= desde) continue;
      if (tipos && !tipos.has(ev.tipo)) continue;
      todos.push(ev);
    }
    const primeroSeq = this.cantidad > 0 ? this.buffer[primero]!.seq : this.seq + 1;
    return {
      // Si hay más que el límite, van los más nuevos (lo que interesa al depurar).
      eventos: todos.length > limite ? todos.slice(-limite) : todos,
      ultimoSeq: this.seq,
      perdidos: this.perdidos,
      // Se pidió desde un seq que ya se pisó: hay un hueco.
      seHuboSaltos: desde > 0 && desde + 1 < primeroSeq,
    };
  }

  ultimasLineas(n = 40): { t: number; linea: string }[] {
    return this.serial.slice(-n);
  }

  ultimosErrores(): EventoTraza[] {
    return [...this.errores];
  }

  get totalEventos(): number {
    return this.seq;
  }

  get enBuffer(): number {
    return this.cantidad;
  }
}
