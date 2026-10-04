import {
  AVRADC,
  AVRClock,
  AVREEPROM,
  AVRIOPort,
  AVRTimer,
  AVRSPI,
  AVRTWI,
  AVRUSART,
  AVRWatchdog,
  CPU,
  EEPROMMemoryBackend,
  PinState,
  adcConfig,
  avrInstruction,
  clockConfig,
  eepromConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  spiConfig,
  twiConfig,
  usart0Config,
  watchdogConfig,
} from 'avr8js';
import { AdaptadorAnalogicoAvr, type EstadoAnalogicoAvr } from './analogicoAvr.js';
import type { BusChips } from './bus/busChips.js';

/**
 * Núcleo del emulador AVR (Arduino Uno / ATmega328P) sobre avr8js, el emulador
 * ciclo a ciclo de Wokwi. Es sincrónico y no sabe de tiempo real: quien lo usa
 * (avrWorker.ts, o avrEmulator.ts en modo local) decide cuántos ciclos correr por
 * tramo para ir a 16 MHz de reloj de pared.
 *
 * A diferencia de esp-emu, acá las entradas SÍ llegan al pad: `ponerEntrada` usa
 * AVRIOPort.setPin, que es lo que lee el registro PINx (digitalRead, interrupciones
 * INT0/INT1 y PCINT incluidas).
 */

/** Flash del ATmega328P: 32 KB. */
export const FLASH_BYTES = 0x8000;
/** SRAM del ATmega328P: 2 KB (más los 256 bytes de registros que agrega avr8js). */
const SRAM_BYTES = 0x800;

export interface AvrEventos {
  /** Un byte que el firmware mandó por el Serial (USART0). */
  onSerial: (byte: number) => void;
  /** Cambió el nivel de salida de un pin (Arduino: 0-13 = D0-D13, 14-19 = A0-A5). */
  onPin: (pin: number, nivel: 0 | 1) => void;
}

/**
 * Lee un .hex en formato Intel HEX (lo que genera arduino-cli) a la imagen de flash.
 * Soporta registros de datos (00), fin (01) y dirección extendida (02/04).
 */
export function parsearIntelHex(texto: string, tamano = FLASH_BYTES): Uint8Array {
  const flash = new Uint8Array(tamano);
  let base = 0;
  let lineaN = 0;
  for (const cruda of texto.split(/\r?\n/)) {
    lineaN++;
    const linea = cruda.trim();
    if (!linea) continue;
    if (!linea.startsWith(':')) throw new Error(`hex inválido (línea ${lineaN}): no empieza con ":"`);
    const bytes = Buffer.from(linea.slice(1), 'hex');
    if (bytes.length < 5) throw new Error(`hex inválido (línea ${lineaN}): registro corto`);
    const largo = bytes[0]!;
    const dir = (bytes[1]! << 8) | bytes[2]!;
    const tipo = bytes[3]!;
    if (bytes.length !== largo + 5) throw new Error(`hex inválido (línea ${lineaN}): largo no coincide`);
    let suma = 0;
    for (const b of bytes) suma = (suma + b) & 0xff;
    if (suma !== 0) throw new Error(`hex inválido (línea ${lineaN}): checksum`);
    if (tipo === 0x00) {
      const inicio = base + dir;
      if (inicio + largo > tamano) throw new Error(`el programa no entra en la flash (${tamano} bytes)`);
      flash.set(bytes.subarray(4, 4 + largo), inicio);
    } else if (tipo === 0x01) {
      break;
    } else if (tipo === 0x02) {
      base = ((bytes[4]! << 8) | bytes[5]!) << 4;
    } else if (tipo === 0x04) {
      base = ((bytes[4]! << 8) | bytes[5]!) << 16;
    }
    // 03/05 (dirección de arranque): el AVR arranca siempre en 0.
  }
  return flash;
}

/** Un pin del MCU: número lógico (el de pin.out/pin.in) → puerto y bit. Sale de `board.pins` de la placa. */
export interface PinMcu {
  gpio: number;
  port: string;
  bit: number;
}

/** Los del Arduino Uno (D0-D13 = PD0..PD7/PB0..PB5, A0-A5 = 14..19 = PC0..PC5), por si no se pasa la tabla. */
export const PINES_UNO: PinMcu[] = Array.from({ length: 20 }, (_, g) =>
  g < 8 ? { gpio: g, port: 'D', bit: g } : g < 14 ? { gpio: g, port: 'B', bit: g - 8 } : { gpio: g, port: 'C', bit: g - 14 },
);

/** Puertos del ATmega328P que emula este núcleo. */
export const PUERTOS_ATMEGA328P = ['B', 'C', 'D'] as const;
type Puerto = (typeof PUERTOS_ATMEGA328P)[number];

export class AvrSimulador {
  readonly cpu: CPU;
  readonly frecuenciaHz: number;
  private readonly puertos: Record<'B' | 'C' | 'D', AVRIOPort>;
  private readonly usart: AVRUSART;
  private readonly analogico: AdaptadorAnalogicoAvr;
  /** El I2C (TWI) del ATmega328P: lo atiende un bus de chips si hay alguno conectado. */
  readonly twi: AVRTWI;
  /** El SPI del ATmega328P (SCK D13, MOSI D11, MISO D12). */
  readonly spi: AVRSPI;
  /** Entradas que maneja "algo de afuera" (un módulo del dibujo): pin → nivel. Las demás quedan libres. */
  private readonly manejadas = new Map<number, 0 | 1>();
  /** Último nivel de salida reportado por pin. */
  private readonly reportados = new Map<number, 0 | 1>();
  private readonly colaRx: number[] = [];
  private lineaDesde: number | null = null;

  /**
   * ¿Hay una línea del Serial sin "\n" hace más de `ms` de tiempo SIMULADO? (una vez por
   * línea). Así un `Serial.print` suelto se muestra igual, sin cortar una línea en dos
   * cuando la PC está cargada y el Arduino emulado va más lento que el reloj de pared.
   */
  lineaVencida(ms = 200): boolean {
    if (this.lineaDesde === null || this.cpu.cycles - this.lineaDesde < (ms / 1000) * this.frecuenciaHz) return false;
    this.lineaDesde = null;
    return true;
  }
  private readonly eventos: AvrEventos;
  /** gpio → puerto/bit (sin duplicados: SDA y A4 son el mismo pin del chip). */
  private readonly mapa = new Map<number, { puerto: Puerto; bit: number }>();
  private readonly gpios: number[];

  constructor(hex: string, eventos: AvrEventos, frecuenciaHz = 16_000_000, pines: PinMcu[] = PINES_UNO) {
    this.eventos = eventos;
    this.frecuenciaHz = frecuenciaHz;
    for (const p of pines) {
      if (!(PUERTOS_ATMEGA328P as readonly string[]).includes(p.port) || p.bit < 0 || p.bit > 7) {
        throw new Error(`el pin ${p.gpio} (puerto ${p.port}${p.bit}) no existe en el ATmega328P`);
      }
      if (!this.mapa.has(p.gpio)) this.mapa.set(p.gpio, { puerto: p.port as Puerto, bit: p.bit });
    }
    this.gpios = [...this.mapa.keys()].sort((a, b) => a - b);
    const flash = parsearIntelHex(hex);
    this.cpu = new CPU(new Uint16Array(flash.buffer), SRAM_BYTES);

    // Los periféricos que usa el core de Arduino: sin timer0 no anda millis()/delay(),
    // sin ADC un analogRead() se queda esperando para siempre.
    new AVRTimer(this.cpu, timer0Config);
    new AVRTimer(this.cpu, timer1Config);
    new AVRTimer(this.cpu, timer2Config);
    const reloj = new AVRClock(this.cpu, frecuenciaHz, clockConfig);
    new AVRWatchdog(this.cpu, watchdogConfig, reloj);
    new AVREEPROM(this.cpu, new EEPROMMemoryBackend(1024), eepromConfig);
    this.analogico = new AdaptadorAnalogicoAvr(this.cpu, new AVRADC(this.cpu, adcConfig));

    this.puertos = {
      B: new AVRIOPort(this.cpu, portBConfig),
      C: new AVRIOPort(this.cpu, portCConfig),
      D: new AVRIOPort(this.cpu, portDConfig),
    };
    for (const puerto of Object.values(this.puertos)) {
      // DDR/PORT cambiaron: un pull-up recién activado tiene que verse en PINx.
      puerto.addListener(() => this.aplicarPullUps());
    }

    this.twi = new AVRTWI(this.cpu, twiConfig, frecuenciaHz);
    this.spi = new AVRSPI(this.cpu, spiConfig, frecuenciaHz);

    this.usart = new AVRUSART(this.cpu, usart0Config, frecuenciaHz);
    this.usart.onByteTransmit = (b) => {
      // Línea sin terminar: desde qué ciclo (para saber cuándo mostrarla igual, ver lineaVencida).
      if (b === 10) this.lineaDesde = null;
      else if (this.lineaDesde === null) this.lineaDesde = this.cpu.cycles;
      this.eventos.onSerial(b);
    };
    this.usart.onRxComplete = () => this.alimentarRx();
  }

  actualizarAnalogicoAvr(estado: EstadoAnalogicoAvr): void { this.analogico.actualizar(estado); }

  /**
   * Nivel que "ve" un pin de entrada sin nadie que lo maneje: con INPUT_PULLUP, 1
   * (como en la placa); sin pull-up queda flotando y el ATmega lee lo que sea — acá, 0.
   */
  private aplicarPullUps(): void {
    for (const pin of this.gpios) {
      if (this.manejadas.has(pin)) continue;
      const u = this.mapa.get(pin)!;
      const puerto = this.puertos[u.puerto];
      puerto.setPin(u.bit, puerto.pinState(u.bit) === PinState.InputPullUp);
    }
  }

  /** Modo debug (debug/avrControl.ts): PCs (en palabras) donde frenar. null = sin breakpoints, costo cero. */
  puntosDeParada: Set<number> | null = null;
  /** PC (palabras) del breakpoint donde frenó el último tramo; lo limpia el control de depuración. */
  frenadoEn: number | null = null;
  /** Al reanudar desde un breakpoint, esa instrucción se ejecuta sin volver a frenar. */
  saltarParadaEn: number | null = null;

  /** Corre la CPU `ciclos` ciclos de reloj (16 000 000 = 1 s simulado). */
  ejecutar(ciclos: number): void {
    const { cpu } = this;
    const hasta = cpu.cycles + ciclos;
    const puntos = this.puntosDeParada;
    if (puntos) {
      while (cpu.cycles < hasta) {
        if (puntos.has(cpu.pc) && cpu.pc !== this.saltarParadaEn) {
          this.frenadoEn = cpu.pc;
          break;
        }
        this.saltarParadaEn = null;
        avrInstruction(cpu);
        cpu.tick();
      }
    } else {
      while (cpu.cycles < hasta) {
        avrInstruction(cpu);
        cpu.tick();
      }
    }
    if (this.colaRx.length > 0 && !this.usart.rxBusy) this.alimentarRx();
    this.reportarSalidas();
  }

  /** µs simulados desde el arranque. */
  get micros(): number {
    return (this.cpu.cycles / this.frecuenciaHz) * 1e6;
  }

  /**
   * Conecta el I2C (TWI) del micro a un bus de chips. Cada evento se completa después de lo
   * que tarda en el bus real a la velocidad de SCL que configuró el firmware (TWBR y el
   * prescaler): 9 períodos por byte (8 bits + ACK) y ~1 período por START/STOP. Así el sketch
   * ve los mismos tiempos que con el chip de verdad.
   */
  conectarI2c(bus: BusChips): void {
    const twi = this.twi;
    const cpu = this.cpu;
    const periodo = (): number => Math.max(1, Math.round(this.frecuenciaHz / twi.sclFrequency));
    let hzAvisado = 0;
    twi.eventHandler = {
      start: () => {
        const hz = twi.sclFrequency;
        if (hz !== hzAvisado) { hzAvisado = hz; bus.velocidad(hz); }
        bus.inicio();
        cpu.addClockEvent(() => twi.completeStart(), periodo());
      },
      stop: () => {
        bus.parada();
        cpu.addClockEvent(() => twi.completeStop(), periodo());
      },
      connectToSlave: (dir, escritura) => {
        const ack = bus.conectar(dir, escritura);
        cpu.addClockEvent(() => twi.completeConnect(ack), 9 * periodo());
      },
      writeByte: (v) => {
        const ack = bus.escribirByte(v);
        cpu.addClockEvent(() => twi.completeWrite(ack), 9 * periodo());
      },
      readByte: (ack) => {
        const v = bus.leerByte(ack);
        cpu.addClockEvent(() => twi.completeRead(v), 9 * periodo());
      },
    };
  }

  /**
   * Conecta todo lo que el bus de chips necesita del micro: el I2C, el SPI y los pines que
   * vigila (CS, DC, RST), avisando cada cambio en el instante en que el programa lo escribe.
   */
  conectarChips(bus: BusChips): void {
    this.conectarI2c(bus);
    this.conectarSpi(bus);
    const vigilados = bus.gpiosVigilados();
    if (vigilados.length === 0) return;
    const avisar = (): void => {
      for (const g of vigilados) {
        const u = this.mapa.get(g);
        if (!u) continue;
        const st = this.puertos[u.puerto].pinState(u.bit);
        // Un pin que no maneja como salida (o con pull-up) queda en alto: CS sin elegir, RST suelto.
        bus.pinMcu(g, st === PinState.Low ? 0 : 1);
      }
    };
    for (const puerto of Object.values(this.puertos)) puerto.addListener(avisar);
    avisar();
  }

  /** SPI: cada byte tarda lo que dice el divisor de reloj que configuró el firmware (8 períodos de SCK). */
  conectarSpi(bus: BusChips): void {
    const spi = this.spi;
    spi.onByte = (v) => {
      const miso = bus.spiByte(v, { modo: spi.spiMode, lsbPrimero: spi.dataOrder === 'lsbFirst', hz: spi.spiFrequency });
      this.cpu.addClockEvent(() => spi.completeTransfer(miso), spi.transferCycles);
    };
  }

  get ciclos(): number {
    return this.cpu.cycles;
  }

  /** Nivel de salida actual de un pin: 1 solo si es OUTPUT y está en HIGH. */
  nivelSalida(pin: number): 0 | 1 {
    const u = this.mapa.get(pin);
    if (!u) return 0;
    return this.puertos[u.puerto].pinState(u.bit) === PinState.High ? 1 : 0;
  }

  /**
   * Manda los cambios de salida desde el último reporte. Se llama al final de cada
   * tramo (no en cada escritura al puerto): un PWM a 1 kHz no debe inundar la UI
   * con miles de eventos por segundo, alcanza con el nivel al cierre de cada tramo.
   */
  reportarSalidas(): void {
    for (const pin of this.gpios) {
      const nivel = this.nivelSalida(pin);
      if (this.reportados.get(pin) === nivel) continue;
      // Al arrancar todos están en 0: solo se avisa cuando algo cambia de verdad.
      if (!this.reportados.has(pin) && nivel === 0) {
        this.reportados.set(pin, 0);
        continue;
      }
      this.reportados.set(pin, nivel);
      this.eventos.onPin(pin, nivel);
    }
  }

  /** Olvida lo reportado de un pin: el próximo tramo lo vuelve a mandar (equivale a @WATCH). */
  vigilar(pin: number): void {
    this.eventos.onPin(pin, this.nivelSalida(pin));
    this.reportados.set(pin, this.nivelSalida(pin));
  }

  /**
   * Un módulo maneja una entrada (un botón que tira a GND, por ejemplo). `null` = la
   * suelta: vuelve a quedar con su pull-up o flotando, como un botón sin apretar.
   */
  ponerEntrada(pin: number, nivel: 0 | 1 | null): boolean {
    const u = this.mapa.get(pin);
    if (!u) return false;
    if (nivel === null) this.manejadas.delete(pin);
    else this.manejadas.set(pin, nivel);
    const puerto = this.puertos[u.puerto];
    if (nivel === null) puerto.setPin(u.bit, puerto.pinState(u.bit) === PinState.InputPullUp);
    else puerto.setPin(u.bit, nivel === 1);
    return true;
  }

  /** Bytes que llegan al Serial del Arduino (lo que escribe el usuario en la consola). */
  escribirSerial(datos: Uint8Array | number[]): void {
    for (const b of datos) this.colaRx.push(b & 0xff);
    // Límite: si el sketch nunca lee el Serial, no crecer para siempre.
    if (this.colaRx.length > 4096) this.colaRx.splice(0, this.colaRx.length - 4096);
    if (!this.usart.rxBusy) this.alimentarRx();
  }

  private alimentarRx(): void {
    const siguiente = this.colaRx[0];
    if (siguiente === undefined) return;
    // writeByte da false si el receptor está ocupado o el sketch no llamó a Serial.begin.
    if (this.usart.writeByte(siguiente)) this.colaRx.shift();
  }
}

/** Cuánto simula cada tramo como máximo antes de devolverle el control al event loop. */
const TRAMO_MS = 10;
/** Si queda más atrasado que esto (PC lenta, breakpoint), no intenta alcanzar: resigna el tiempo. */
const ATRASO_MAX_MS = 250;

/**
 * Corre el simulador a velocidad real (16 MHz de reloj de pared) en tramos cortos,
 * sin bloquear el event loop: entre tramo y tramo entran los mensajes (botones,
 * consola) y salen los eventos. Si la PC no da abasto, corre lo más rápido que
 * puede y lo informa en `velocidad()` (1 = tiempo real).
 */
export class RelojAvr {
  private vivo = false;
  private inicioMs = 0;
  private ciclosInicio = 0;
  private timer: NodeJS.Timeout | NodeJS.Immediate | null = null;
  private muestra = { ms: 0, ciclos: 0, velocidad: 1 };

  constructor(
    private readonly sim: AvrSimulador,
    private readonly alTerminarTramo: () => void = () => undefined,
    private readonly alError?: (error: unknown) => void,
  ) {}

  arrancar(): void {
    if (this.vivo) return;
    this.vivo = true;
    this.inicioMs = performance.now();
    this.ciclosInicio = this.sim.ciclos;
    this.muestra = { ms: this.inicioMs, ciclos: this.ciclosInicio, velocidad: 1 };
    this.paso();
  }

  parar(): void {
    this.vivo = false;
    if (this.timer) {
      clearTimeout(this.timer as NodeJS.Timeout);
      clearImmediate(this.timer as NodeJS.Immediate);
    }
    this.timer = null;
  }

  /** Velocidad medida respecto al tiempo real (1 = 16 MHz reales). */
  velocidad(): number {
    return this.muestra.velocidad;
  }

  private paso = (): void => {
    this.timer = null;
    if (!this.vivo) return;
    const hz = this.sim.frecuenciaHz;
    const ahora = performance.now();
    let objetivo = this.ciclosInicio + ((ahora - this.inicioMs) / 1000) * hz;
    if (objetivo - this.sim.ciclos > (ATRASO_MAX_MS / 1000) * hz) {
      // Muy atrasado: se reacomoda la referencia para no quedar corriendo "de más" para siempre.
      this.inicioMs = ahora;
      this.ciclosInicio = this.sim.ciclos;
      objetivo = this.sim.ciclos;
    }
    const pendiente = Math.min(objetivo - this.sim.ciclos, (TRAMO_MS / 1000) * hz);
    if (pendiente > 0) {
      try {
        this.sim.ejecutar(Math.ceil(pendiente));
        this.alTerminarTramo();
      } catch (error) {
        this.parar();
        if (this.alError) this.alError(error);
        else throw error;
        return;
      }
    }
    if (ahora - this.muestra.ms >= 1000) {
      const v = (this.sim.ciclos - this.muestra.ciclos) / hz / ((ahora - this.muestra.ms) / 1000);
      this.muestra = { ms: ahora, ciclos: this.sim.ciclos, velocidad: v };
    }
    if (!this.vivo) return;
    // Atrasado: seguir enseguida (dejando pasar los mensajes); adelantado: esperar un poco.
    const atrasado = this.ciclosInicio + ((performance.now() - this.inicioMs) / 1000) * hz - this.sim.ciclos > 0;
    this.timer = atrasado ? setImmediate(this.paso) : setTimeout(this.paso, 1);
  };
}
