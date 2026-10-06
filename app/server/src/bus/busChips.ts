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
  /** Puede recibir las escrituras en tanda (ver `diferirEscrituras` en chip.json). */
  diferirEscrituras?: boolean;
  /** Lo que el chip guardó en la ejecución anterior (memoria no volátil). */
  guardado?: unknown;
  /** Si el chip está en el bus SPI: su CS y su DC (gpio del micro) y lo que acepta. */
  spi?: { csGpio: number; dcGpio?: number; modos: number[]; lsbPrimero: boolean; soloEscritura: boolean; maxHz?: number };
  /** Pines del micro que el chip lee (gpio → nombre del pin del chip): RST, ENABLE... */
  entradas?: Record<number, string>;
  /**
   * Cuándo recibió la alimentación (µs, en el reloj del bus). Por defecto, ahora. Con la placa
   * puede ser negativo: el chip se enciende con ella y el micro arranca después (arranqueMs).
   */
  encendidoEnUs?: number;
}

/** Bytes que se piden de antemano al empezar una lectura (el buffer de Wire en AVR es de 32). */
export const PREFETCH = 32;
/** Escrituras diferidas: se entregan en tanda de hasta 16, o a los 10 ms de la primera. */
const DIFERIR_MAX = 16;
const DIFERIR_US = 10_000;

interface Dispositivo extends Required<Omit<OpcionesDispositivo, 'maxHz' | 'encendidoEnUs' | 'diferirEscrituras' | 'guardado' | 'spi' | 'entradas'>> {
  guardado?: unknown;
  generacion: number;
  maxHz?: number;
  spi?: NonNullable<OpcionesDispositivo['spi']>;
  entradas: Record<number, string>;
  /** SPI: CS en bajo ahora. */
  seleccionado: boolean;
  diferir: boolean;
  /** Despertador agendado para entregar las escrituras diferidas. */
  entregaAgendada: boolean;
  direcciones: number[];
  ocupadoHasta: number;
  pendientes: EventoChip[];
  roto: string | null;
  /** Despertador pedido (µs) y si ya está agendado en el host. */
  despertar: number | null;
  /** Último nivel de cada pin propio (para volver a aplicarlo si el micro se resetea). */
  pines: Map<string, 0 | 1 | null>;
}

export interface EventosBus {
  /** µs de emulación desde el arranque. */
  ahoraUs: () => number;
  alSalida?: (id: string, salida: SalidaChip) => void;
  alLog?: (linea: string) => void;
  /** Un chip cambió un pin propio (INT, SQW): el host lo lleva al pin del micro cableado. */
  alPin?: (id: string, pin: string, nivel: 0 | 1 | null) => void;
  /** Llamar a `fn` cuando la emulación llegue a `tUs` (el host lo agenda en su reloj). */
  programar?: (tUs: number, fn: () => void) => void;
  /** Un chip guardó su memoria no volátil (EEPROM, la hora con pila): el host la persiste. */
  alGuardar?: (id: string, datos: unknown) => void;
}

/** Una transacción del bus, para el analizador (la grabadora del modo debug, los tests). */
export interface TransaccionI2c {
  t: number;
  direccion: number;
  lectura: boolean;
  ack: boolean;
  bytes: number[];
}

export class BusChips {
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
      despertar: null, pines: new Map(), diferir: o.diferirEscrituras ?? false, entregaAgendada: false,
      spi: o.spi, entradas: o.entradas ?? {}, seleccionado: false, guardado: o.guardado, generacion: 0,
    };
    this.dispositivos.push(d);
    if (d.alimentado) this.correr(d, [{ tipo: 'encender', t: o.encendidoEnUs ?? this.ev.ahoraUs(), guardado: o.guardado }]);
  }

  /**
   * Se corta la alimentación (se detiene la corrida): cada chip recibe `apagar` con lo que tenía
   * pendiente, para guardar lo último de su memoria no volátil.
   */
  apagar(): void {
    for (const d of this.dispositivos) this.ponerAlimentacion(d.id, false);
  }

  /** VCC efectivo. Un corte invalida transacciones y temporizadores anteriores. */
  ponerAlimentacion(id: string, on: boolean): boolean {
    const d = this.dispositivos.find((x) => x.id === id);
    if (!d) return false;
    if (d.alimentado === on) return true;
    const t = this.ev.ahoraUs();
    // Sin STOP, la escritura en curso no constituye una transacción completa.
    if (this.seg) {
      this.seg.con = this.seg.con.filter((x) => x !== d);
      this.seg.leidos.delete(d);
    }
    d.generacion++;
    if (!on) {
      this.correr(d, [{ tipo: 'apagar', t }]);
      d.alimentado = false;
      for (const pin of d.pines.keys()) {
        d.pines.set(pin, null);
        this.ev.alPin?.(d.id, pin, null);
      }
      d.despertar = null;
      d.entregaAgendada = false;
      d.seleccionado = false;
      d.pendientes = [];
      d.direcciones = [];
      d.ocupadoHasta = 0;
    } else {
      d.alimentado = true;
      this.correr(d, [{ tipo: 'encender', t, guardado: d.guardado }]);
      for (const [gpio, nombre] of Object.entries(d.entradas)) {
        const nivel = this.nivelesMcu.get(Number(gpio));
        if (nivel !== undefined) d.pendientes.push({ tipo: 'pin', t, nombre, nivel });
      }
      if (d.spi && this.nivelesMcu.get(d.spi.csGpio) === 0) {
        d.seleccionado = true;
        d.pendientes.push({ tipo: 'seleccionar', t });
      }
      if (d.pendientes.length) this.correr(d, []);
    }
    return true;
  }

  /** Cambió el entorno de una instancia (la temperatura que mueve el usuario). */
  ponerEntorno(id: string, valores: Record<string, number>): boolean {
    const d = this.dispositivos.find((x) => x.id === id);
    if (!d) return false;
    // Antes de cambiarlo, el chip se pone al día con el entorno VIEJO: una medición o conversión
    // que terminó antes de este instante tiene que haber medido lo que había entonces.
    if (d.alimentado && !d.roto) this.correr(d, [{ tipo: 'tick', t: this.ev.ahoraUs() }]);
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
    if (!this.seg || this.seg.lectura || this.seg.con.length === 0) return false;
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

  /** STOP: termina la transacción y entrega lo pendiente a cada chip (o lo junta, si el chip lo permite). */
  parada(): void {
    this.cerrarSegmento();
    const t = this.ev.ahoraUs();
    for (const d of this.dispositivos) {
      if (d.pendientes.length === 0) continue;
      const primero = d.pendientes[0]!.t;
      const soloEscrituras = d.pendientes.every((e) => e.tipo === 'escribir');
      if (d.diferir && this.ev.programar && soloEscrituras && d.pendientes.length < DIFERIR_MAX && t - primero < DIFERIR_US) {
        // Se entrega más tarde, en tanda: a los 10 ms del primero como mucho.
        if (!d.entregaAgendada) {
          d.entregaAgendada = true;
          const generacion = d.generacion;
          this.ev.programar(primero + DIFERIR_US, () => {
            if (!d.alimentado || d.generacion !== generacion) return;
            d.entregaAgendada = false;
            if (d.pendientes.length > 0) this.correr(d, []);
          });
        }
        continue;
      }
      this.correr(d, []);
    }
  }

  // --- SPI y pines del micro ---------------------------------------------------------

  /** Último nivel de salida de cada pin del micro que interesa (CS, DC, RST...). */
  private readonly nivelesMcu = new Map<number, 0 | 1>();
  private avisadoModo = new Set<string>();

  /** Pines del micro que el bus tiene que vigilar: los CS, los DC y las entradas de los chips. */
  gpiosVigilados(): number[] {
    const g = new Set<number>();
    for (const d of this.dispositivos) {
      if (d.spi) { g.add(d.spi.csGpio); if (d.spi.dcGpio !== undefined) g.add(d.spi.dcGpio); }
      for (const k of Object.keys(d.entradas)) g.add(Number(k));
    }
    return [...g];
  }

  /**
   * El micro cambió el nivel de un pin que el bus vigila (en el instante exacto en que lo
   * escribe el programa): CS selecciona o suelta un chip SPI; un RST le llega al chip.
   */
  pinMcu(gpio: number, nivel: 0 | 1): void {
    if (this.nivelesMcu.get(gpio) === nivel) return;
    this.nivelesMcu.set(gpio, nivel);
    const t = this.ev.ahoraUs();
    for (const d of this.dispositivos) {
      if (!d.alimentado || d.roto) continue;
      const nombre = d.entradas[gpio];
      if (nombre !== undefined) d.pendientes.push({ tipo: 'pin', t, nombre, nivel });
      if (d.spi?.csGpio === gpio) {
        if (nivel === 0 && !d.seleccionado) { d.seleccionado = true; d.pendientes.push({ tipo: 'seleccionar', t }); }
        else if (nivel === 1 && d.seleccionado) { d.seleccionado = false; d.pendientes.push({ tipo: 'soltar', t }); }
      }
      // Lo que no es de una pantalla en tanda se entrega enseguida (un RST, una selección).
      if (d.pendientes.length > 0 && !(d.spi?.soloEscritura && d.seleccionado)) this.correr(d, []);
    }
  }

  /** Un byte por SPI: lo que sale del micro por MOSI. Devuelve lo que entra por MISO (0xFF si nadie contesta). */
  spiByte(mosi: number, cfg: { modo: number; lsbPrimero: boolean; hz: number }): number {
    const t = this.ev.ahoraUs();
    let miso = 0xff;
    for (const d of this.dispositivos) {
      if (!d.spi || !d.seleccionado || !d.alimentado || d.roto) continue;
      if (d.spi.maxHz && cfg.hz > d.spi.maxHz * 1.05 && !this.avisadoVelocidad.has(d.id)) {
        this.avisadoVelocidad.add(d.id);
        this.ev.alLog?.(`[spi] ${d.id} (${d.chip}) soporta hasta ${d.spi.maxHz / 1e6} MHz y el bus va a ${(cfg.hz / 1e6).toFixed(1)} MHz: en la placa real puede fallar.`);
      }
      // Modo SPI u orden de bits distintos a los del chip: el byte llega corrido, como en la placa real.
      const modoMal = !d.spi.modos.includes(cfg.modo);
      const ordenMal = cfg.lsbPrimero !== d.spi.lsbPrimero;
      if ((modoMal || ordenMal) && !this.avisadoModo.has(d.id)) {
        this.avisadoModo.add(d.id);
        this.ev.alLog?.(`[spi] ${d.id} (${d.chip}) usa ${modoMal ? `el modo ${d.spi.modos.join('/')}` : ''}${modoMal && ordenMal ? ' y ' : ''}${ordenMal ? (d.spi.lsbPrimero ? 'LSB primero' : 'MSB primero') : ''}, y el programa usa el modo ${cfg.modo}${cfg.lsbPrimero ? ', LSB primero' : ''}: los datos llegan corridos.`);
      }
      const entra = deformar(mosi, modoMal, ordenMal);
      const dc: 0 | 1 = d.spi.dcGpio === undefined ? 1 : (this.nivelesMcu.get(d.spi.dcGpio) ?? 0);
      if (d.spi.soloEscritura) {
        // Una pantalla no contesta: se juntan los bytes y se entregan en tanda.
        const ultimo = d.pendientes.at(-1);
        if (ultimo?.tipo === 'spi' && ultimo.mosi.length < 4096) { ultimo.mosi.push(entra); ultimo.dc.push(dc); }
        else d.pendientes.push({ tipo: 'spi', t, mosi: [entra], dc: [dc] });
        const bytes = d.pendientes.reduce((n, e) => n + (e.tipo === 'spi' ? e.mosi.length : 0), 0);
        if (bytes >= 4096) this.correr(d, []);
        else this.agendarEntrega(d);
        continue;
      }
      const r = this.correr(d, [{ tipo: 'spi', t, mosi: [entra], dc: [dc] }]);
      miso &= deformar(r?.lecturas.at(-1)?.[0] ?? 0xff, modoMal, ordenMal);
    }
    return miso;
  }

  /** Entrega lo juntado de una pantalla a los 10 ms del primer byte, como mucho. */
  private agendarEntrega(d: Dispositivo): void {
    if (d.entregaAgendada || !this.ev.programar || d.pendientes.length === 0) return;
    d.entregaAgendada = true;
    const generacion = d.generacion;
    this.ev.programar(d.pendientes[0]!.t + DIFERIR_US, () => {
      if (!d.alimentado || d.generacion !== generacion) return;
      d.entregaAgendada = false;
      if (d.pendientes.length > 0) this.correr(d, []);
    });
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
    if (d.roto || !d.alimentado) return null;
    try {
      const r = d.motor.correr(eventos, d.entorno, d.props);
      d.direcciones = r.direcciones;
      d.ocupadoHasta = r.ocupadoHasta;
      for (const l of r.logs) this.ev.alLog?.(`[${d.id}] ${l}`);
      if (r.salida) this.ev.alSalida?.(d.id, r.salida);
      if ('guardar' in r) { d.guardado = r.guardar; this.ev.alGuardar?.(d.id, r.guardar); }
      for (const [pin, nivel] of Object.entries(r.pines)) {
        if (d.pines.get(pin) === nivel) continue;
        d.pines.set(pin, nivel);
        this.ev.alPin?.(d.id, pin, nivel);
      }
      if (r.despertarEn !== null && (d.despertar === null || r.despertarEn < d.despertar)) this.agendar(d, r.despertarEn);
      return r;
    } catch (err) {
      d.roto = err instanceof ErrorChip ? err.message : String(err);
      this.ev.alLog?.(`[${d.spi ? 'spi' : 'i2c'}] ${d.id} dejó de responder: ${d.roto}`);
      return null;
    }
  }

  /** Agenda el despertador de un chip en el reloj del host (si el host sabe agendar). */
  private agendar(d: Dispositivo, t: number): void {
    if (!this.ev.programar) return;
    d.despertar = t;
    const generacion = d.generacion;
    this.ev.programar(t, () => {
      if (!d.alimentado || d.generacion !== generacion || d.despertar !== t) return; // lo reemplazó uno más temprano
      d.despertar = null;
      this.correr(d, [{ tipo: 'tick', t: this.ev.ahoraUs() }]);
    });
  }

  /**
   * El host cambió de reloj (un reset del micro crea una CPU nueva): vuelve a agendar los
   * despertadores pendientes y a aplicar los pines que manejan los chips.
   */
  reengancharHost(): void {
    for (const d of this.dispositivos) {
      if (!d.alimentado) continue;
      if (d.despertar !== null) {
        const t = d.despertar;
        d.despertar = null;
        this.agendar(d, t);
      }
      for (const [pin, nivel] of d.pines) this.ev.alPin?.(d.id, pin, nivel);
    }
  }

  private registrar(direccion: number, lectura: boolean, ack: boolean, bytes: number[]): void {
    this.historial.push({ t: this.ev.ahoraUs(), direccion, lectura, ack, bytes: bytes.slice(0, 64) });
    if (this.historial.length > 500) this.historial.splice(0, this.historial.length - 500);
  }
}

/** Un byte que pasa por un SPI mal configurado: corrido un bit (modo) o al revés (orden de bits). */
function deformar(b: number, modoMal: boolean, ordenMal: boolean): number {
  let x = b & 0xff;
  if (ordenMal) { let r = 0; for (let i = 0; i < 8; i++) r |= ((x >> i) & 1) << (7 - i); x = r; }
  if (modoMal) x = (x << 1) & 0xff; // se muestrea en el flanco equivocado: un bit corrido
  return x;
}
