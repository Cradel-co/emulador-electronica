import { BusChips, type OpcionesDispositivo } from './busChips.js';
import { SandboxChip } from './chipSandbox.js';
import type { ChipCatalogo } from './catalogoChips.js';

/**
 * Maestro I2C virtual: maneja el bus como lo haría Wire (START, dirección, bytes, STOP) con un
 * reloj que controla quien lo usa. Sirve para probar un chip contra las secuencias de su hoja
 * de datos sin firmware ni emulador (tests de cada chip, `tests.json` de un módulo).
 */
export class MaestroVirtual {
  /** µs de emulación: lo avanza el test. */
  t = 0;
  readonly logs: string[] = [];
  readonly salidas = new Map<string, unknown>();
  /** Nivel actual de cada pin que maneja un chip ("id.PIN"), y su historia con el instante. */
  readonly pines = new Map<string, 0 | 1 | null>();
  readonly historialPines: { t: number; pin: string; nivel: 0 | 1 | null }[] = [];
  /** Lo último que guardó cada chip (memoria no volátil). */
  readonly guardados = new Map<string, unknown>();
  readonly bus: BusChips;
  private agenda: { t: number; fn: () => void }[] = [];

  constructor() {
    this.bus = new BusChips({
      ahoraUs: () => this.t,
      alLog: (l) => this.logs.push(l),
      alSalida: (id, s) => this.salidas.set(id, s),
      alPin: (id, pin, nivel) => {
        this.pines.set(`${id}.${pin}`, nivel);
        this.historialPines.push({ t: this.t, pin: `${id}.${pin}`, nivel });
      },
      programar: (t, fn) => this.agenda.push({ t, fn }),
      alGuardar: (id, d) => this.guardados.set(id, d),
    });
  }

  /** Agrega una instancia de un chip del catálogo (con su propio sandbox). */
  conectar(chip: ChipCatalogo, o: Omit<OpcionesDispositivo, 'motor' | 'chip'> & { entorno?: Record<string, number> }): SandboxChip {
    const motor = new SandboxChip(chip.id, chip.codigo);
    const entorno = Object.fromEntries(Object.entries(chip.entorno).map(([k, m]) => [k, m.default]));
    this.bus.agregar({ ...o, chip: chip.id, motor, maxHz: chip.i2c?.maxHz, diferirEscrituras: chip.i2c?.diferirEscrituras, entorno: { ...entorno, ...o.entorno } });
    return motor;
  }

  /** Avanza el reloj; los despertadores de los chips corren en su instante, en orden. */
  esperar(ms: number): void {
    const hasta = this.t + ms * 1000;
    for (;;) {
      this.agenda.sort((a, b) => a.t - b.t);
      const prox = this.agenda[0];
      if (!prox || prox.t > hasta) break;
      this.agenda.shift();
      this.t = Math.max(this.t, prox.t);
      prox.fn();
    }
    this.t = hasta;
  }

  /** ¿Alguien contesta en esta dirección? (lo que hace un escáner I2C). */
  sondear(dir: number): boolean {
    this.bus.inicio();
    const ack = this.bus.conectar(dir, true);
    this.bus.parada();
    return ack;
  }

  /** Escribe bytes. Devuelve false si la dirección no contestó. */
  escribir(dir: number, bytes: number[]): boolean {
    this.bus.inicio();
    if (!this.bus.conectar(dir, true)) {
      this.bus.parada();
      return false;
    }
    for (const b of bytes) this.bus.escribirByte(b);
    this.bus.parada();
    return true;
  }

  /** Lee n bytes. null si la dirección no contestó. */
  leer(dir: number, n: number): number[] | null {
    this.bus.inicio();
    if (!this.bus.conectar(dir, false)) {
      this.bus.parada();
      return null;
    }
    const out = Array.from({ length: n }, (_, i) => this.bus.leerByte(i < n - 1));
    this.bus.parada();
    return out;
  }

  /** Escribe (normalmente el registro) y lee con START repetido, como readRegister de casi todas las librerías. */
  leerRegistros(dir: number, reg: number[] | number, n: number): number[] | null {
    this.bus.inicio();
    if (!this.bus.conectar(dir, true)) {
      this.bus.parada();
      return null;
    }
    for (const b of Array.isArray(reg) ? reg : [reg]) this.bus.escribirByte(b);
    this.bus.inicio(); // START repetido
    if (!this.bus.conectar(dir, false)) {
      this.bus.parada();
      return null;
    }
    const out = Array.from({ length: n }, (_, i) => this.bus.leerByte(i < n - 1));
    this.bus.parada();
    return out;
  }

  // --- SPI ------------------------------------------------------------------------------

  /** El micro pone un nivel en un pin que vigila el bus (CS, DC, RST). */
  pin(gpio: number, nivel: 0 | 1): void {
    this.bus.pinMcu(gpio, nivel);
  }

  /**
   * Una transacción SPI: baja CS, manda los bytes (con DC si se da) y sube CS. Devuelve lo que
   * entró por MISO. `modo`/`lsbPrimero`/`hz`: la configuración del maestro (por defecto modo 0, 4 MHz).
   */
  spi(cs: number, bytes: number[], o: { dc?: { gpio: number; nivel: 0 | 1 }; modo?: number; lsbPrimero?: boolean; hz?: number; mantenerCs?: boolean } = {}): number[] {
    if (o.dc) this.bus.pinMcu(o.dc.gpio, o.dc.nivel);
    this.bus.pinMcu(cs, 0);
    const out = bytes.map((b) => this.bus.spiByte(b, { modo: o.modo ?? 0, lsbPrimero: o.lsbPrimero ?? false, hz: o.hz ?? 4e6 }));
    if (!o.mantenerCs) this.bus.pinMcu(cs, 1);
    return out;
  }
}
