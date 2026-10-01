import { BusI2c, type OpcionesDispositivo } from './busI2c.js';
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
  readonly bus: BusI2c;

  constructor() {
    this.bus = new BusI2c({
      ahoraUs: () => this.t,
      alLog: (l) => this.logs.push(l),
      alSalida: (id, s) => this.salidas.set(id, s),
    });
  }

  /** Agrega una instancia de un chip del catálogo (con su propio sandbox). */
  conectar(chip: ChipCatalogo, o: Omit<OpcionesDispositivo, 'motor' | 'chip'> & { entorno?: Record<string, number> }): SandboxChip {
    const motor = new SandboxChip(chip.id, chip.codigo);
    const entorno = Object.fromEntries(Object.entries(chip.entorno).map(([k, m]) => [k, m.default]));
    this.bus.agregar({ ...o, chip: chip.id, motor, maxHz: chip.i2c?.maxHz, entorno: { ...entorno, ...o.entorno } });
    return motor;
  }

  esperar(ms: number): void {
    this.t += ms * 1000;
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
}
