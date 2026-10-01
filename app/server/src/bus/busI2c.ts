import type { SalidaChip } from '@emu/shared';
import { ErrorChip, type EventoChip, type ResultadoLote } from './chipSandbox.js';

/**
 * Bus I2C entre el maestro (el periférico TWI del micro emulado, o un maestro virtual en los
 * tests) y los chips del dibujo. Es eléctricamente un bus de colector abierto con pull-ups:
 *  - un chip responde (ACK) solo si está alimentado, si la dirección es suya y si no está
 *    ocupado (una EEPROM grabando su página no contesta: es el "acknowledge polling");
 *  - si dos chips tienen la misma dirección, los dos contestan y en una lectura el maestro ve
 *    el AND de los bytes (gana el 0, como en el bus real) — y se avisa del conflicto;
 *  - si nadie maneja SDA (el chip se quedó sin bytes), el maestro lee 0xFF (el pull-up).
 *
 * Para que sea rápido, el bus junta la transacción y llama al comportamiento del chip una
 * vez por transacción, no por byte (ver bus/chipSandbox.ts): lo escrito se acumula y se
 * entrega al terminar el segmento, y una lectura se pide de antemano (PREFETCH bytes) y se
 * confirma cuánto se leyó de verdad (`leidos`).
 */

/** Lo que el bus necesita de un chip: correr una tanda de eventos (sandbox o un doble en los tests). */
export interface MotorChip {
  correr(eventos: EventoChip[], entorno: Record<string, number>, props: Record<string, unknown>): ResultadoLote;
}

export interface OpcionesDispositivo {
  /** Id de la instancia en el dibujo ("bme1"). */
  id: string;
  /** Id del chip ("bosch-bme280"), para los mensajes. */
  chip: string;
  motor: MotorChip;
  props?: Record<string, unknown>;
  entorno?: Record<string, number>;
  /** Sin alimentación, el chip no contesta (como en la vida real). */
  alimentado?: boolean;
  /** Frecuencia máxima de SCL que soporta (Hz). */
  maxHz?: number;
  /**
   * Cuándo recibió la alimentación (µs, en el reloj del bus). Por defecto, ahora. Con la placa
   * puede ser negativo: el chip se enciende con ella y el micro arranca después (arranqueMs).
   */
  encendidoEnUs?: number;
}

/** Bytes que se piden de antemano al empezar una lectura (el buffer de Wire en AVR es de 32). */
export const PREFETCH = 32;

interface Dispositivo extends Required<Omit<OpcionesDispositivo, 'maxHz' | 'encendidoEnUs'>> {
  maxHz?: number;
  direcciones: number[];
  ocupadoHasta: number;
  pendientes: EventoChip[];
  roto: string | null;
}

export interface EventosBus {
  /** µs de emulación desde el arranque. */
  ahoraUs: () => number;
  alSalida?: (id: string, salida: SalidaChip) => void;
  alLog?: (linea: string) => void;
}

/** Una transacción del bus, para el analizador (la grabadora del modo debug, los tests). */
export interface TransaccionI2c {
  t: number;
  direccion: number;
  lectura: boolean;
  ack: boolean;
  bytes: number[];
}

export class BusI2c {
  private readonly dispositivos: Dispositivo[] = [];
  /** Segmento en curso: dirección, sentido y quiénes contestaron. */
  private seg: { direccion: number; lectura: boolean; con: Dispositivo[]; bytes: number[]; leidos: Map<Dispositivo, number[]> } | null = null;
  private avisadoConflicto = new Set<number>();
  private avisadoVelocidad = new Set<string>();
  /** Últimas transacciones (para inspeccionar); tope fijo. */
  readonly historial: TransaccionI2c[] = [];

  constructor(private readonly ev: EventosBus) {}

  agregar(o: OpcionesDispositivo): void {
    const d: Dispositivo = {
      id: o.id, chip: o.chip, motor: o.motor, props: o.props ?? {}, entorno: o.entorno ?? {},
      alimentado: o.alimentado ?? true, maxHz: o.maxHz, direcciones: [], ocupadoHasta: 0, pendientes: [], roto: null,
    };
    this.dispositivos.push(d);
    if (d.alimentado) this.correr(d, [{ tipo: 'encender', t: o.encendidoEnUs ?? this.ev.ahoraUs() }]);
  }

  /** Cambió el entorno de una instancia (la temperatura que mueve el usuario). */
  ponerEntorno(id: string, valores: Record<string, number>): boolean {
    const d = this.dispositivos.find((x) => x.id === id);
    if (!d) return false;
    d.entorno = { ...d.entorno, ...valores };
    return true;
  }

  get ids(): string[] {
    return this.dispositivos.map((d) => d.id);
  }

  /** Aviso (una vez por chip) si el maestro usa SCL más rápido de lo que el chip soporta. */
  velocidad(hz: number): void {
    for (const d of this.dispositivos) {
      if (d.maxHz && hz > d.maxHz * 1.05 && !this.avisadoVelocidad.has(d.id)) {
        this.avisadoVelocidad.add(d.id);
        this.ev.alLog?.(`[i2c] ${d.id} (${d.chip}) soporta hasta ${d.maxHz / 1000} kHz y el bus va a ${Math.round(hz / 1000)} kHz: en la placa real puede fallar.`);
      }
    }
  }

  // --- Lado del maestro -------------------------------------------------------------

  /** START (o START repetido). */
  inicio(): void {
    this.cerrarSegmento();
  }

  /** Manda la dirección. Devuelve el ACK (alguien contestó). */
  conectar(direccion: number, escritura: boolean): boolean {
    this.cerrarSegmento();
    const t = this.ev.ahoraUs();
    const con = this.dispositivos.filter((d) => d.alimentado && !d.roto && d.direcciones.includes(direccion) && t >= d.ocupadoHasta);
    if (con.length > 1 && !this.avisadoConflicto.has(direccion)) {
      this.avisadoConflicto.add(direccion);
      this.ev.alLog?.(`[i2c] conflicto: ${con.map((d) => d.id).join(' y ')} usan la misma dirección 0x${direccion.toString(16)}. En el bus real se pisan.`);
    }
    this.seg = { direccion, lectura: !escritura, con, bytes: [], leidos: new Map() };
    if (con.length === 0) {
      this.registrar(direccion, !escritura, false, []);
      this.seg = null;
      return false;
    }
    if (!escritura) for (const d of con) this.seg.leidos.set(d, this.pedirLectura(d, t));
    return true;
  }

  /** Un byte del maestro al chip. ACK si sigue habiendo alguien escuchando. */
  escribirByte(b: number): boolean {
    if (!this.seg || this.seg.lectura) return false;
    this.seg.bytes.push(b & 0xff);
    return true;
  }

  /** Un byte del chip al maestro. `ack`: el maestro va a pedir otro (false = último). */
  leerByte(_ack: boolean): number {
    const s = this.seg;
    if (!s || !s.lectura) return 0xff;
    const i = s.bytes.length;
    let valor = 0xff;
    for (const d of s.con) {
      let buf = s.leidos.get(d)!;
      if (i >= buf.length) {
        // Leyó más de lo pedido de antemano: confirmar lo leído y pedir otra tanda.
        const t = this.ev.ahoraUs();
        d.pendientes.push({ tipo: 'leidos', t, n: PREFETCH });
        buf = buf.concat(this.pedirLectura(d, t));
        s.leidos.set(d, buf);
      }
      valor &= buf[i] ?? 0xff; // colector abierto: gana el 0
    }
    s.bytes.push(valor);
    return valor;
  }

  /** STOP: termina la transacción y entrega lo pendiente a cada chip. */
  parada(): void {
    this.cerrarSegmento();
    for (const d of this.dispositivos) if (d.pendientes.length > 0) this.correr(d, []);
  }

  // --- Interno ------------------------------------------------------------------------

  private cerrarSegmento(): void {
    const s = this.seg;
    if (!s) return;
    this.seg = null;
    const t = this.ev.ahoraUs();
    this.registrar(s.direccion, s.lectura, true, s.bytes);
    for (const d of s.con) {
      if (s.lectura) {
        // Cuántos bytes de la última tanda pedida se leyeron de verdad.
        // (cada tanda es de PREFETCH bytes: las anteriores ya se confirmaron enteras).
        const total = s.leidos.get(d)!.length;
        d.pendientes.push({ tipo: 'leidos', t, n: Math.max(0, s.bytes.length - (total - PREFETCH)) });
      } else {
        d.pendientes.push({ tipo: 'escribir', t, bytes: s.bytes });
      }
    }
  }

  private pedirLectura(d: Dispositivo, t: number): number[] {
    const r = this.correr(d, [{ tipo: 'leer', t, n: PREFETCH }]);
    return r?.lecturas.at(-1) ?? Array<number>(PREFETCH).fill(0xff);
  }

  /** Corre lo pendiente del chip más `extra`. Si el chip falla, queda fuera del bus. */
  private correr(d: Dispositivo, extra: EventoChip[]): ResultadoLote | null {
    const eventos = d.pendientes.concat(extra);
    d.pendientes = [];
    if (d.roto) return null;
    try {
      const r = d.motor.correr(eventos, d.entorno, d.props);
      d.direcciones = r.direcciones;
      d.ocupadoHasta = r.ocupadoHasta;
      for (const l of r.logs) this.ev.alLog?.(`[${d.id}] ${l}`);
      if (r.salida) this.ev.alSalida?.(d.id, r.salida);
      return r;
    } catch (err) {
      d.roto = err instanceof ErrorChip ? err.message : String(err);
      this.ev.alLog?.(`[i2c] ${d.id} dejó de responder: ${d.roto}`);
      return null;
    }
  }

  private registrar(direccion: number, lectura: boolean, ack: boolean, bytes: number[]): void {
    this.historial.push({ t: this.ev.ahoraUs(), direccion, lectura, ack, bytes: bytes.slice(0, 64) });
    if (this.historial.length > 500) this.historial.splice(0, this.historial.length - 500);
  }
}
