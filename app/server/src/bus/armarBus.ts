import { BusI2c, type EventosBus } from './busI2c.js';
import { SandboxChip } from './chipSandbox.js';
import type { ChipEnBus } from './proyectoChips.js';

/**
 * Arma el bus I2C de una corrida con los chips del dibujo. Los chips se encienden con la
 * placa: `arranqueMs` antes de que el micro ejecute su primera instrucción. Un chip cuyo código
 * no carga queda afuera y se avisa (los demás andan igual). Sin chips, null.
 */
export function armarBusI2c(chips: ChipEnBus[], arranqueMs: number, ev: EventosBus): BusI2c | null {
  if (chips.length === 0) return null;
  const bus = new BusI2c(ev);
  for (const c of chips) {
    try {
      bus.agregar({
        id: c.id, chip: c.chip, motor: new SandboxChip(c.chip, c.codigo), props: c.props, entorno: c.entorno,
        alimentado: c.alimentado, maxHz: c.maxHz, encendidoEnUs: -arranqueMs * 1000, diferirEscrituras: c.diferirEscrituras, guardado: c.guardado,
      });
    } catch (err) {
      ev.alLog?.(`[i2c] ${c.nombre}: ${(err as Error).message}`);
    }
  }
  return bus;
}

/**
 * Entradas del micro que manejan varios a la vez: la app (botones del dibujo, el motor eléctrico)
 * y los chips (INT, SQW). Son líneas de colector abierto con pull-up: gana el 0 (AND cableado).
 * Un chip que suelta la línea vale 1 si la placa tiene pull-up en ese pin, o nada si no.
 */
export class LineasCompartidas {
  private readonly app = new Map<number, 0 | 1 | null>();
  private readonly chips = new Map<number, Map<string, 0 | 1 | null>>();

  constructor(private readonly aplicar: (gpio: number, nivel: 0 | 1 | null) => void) {}

  /** Lo que pide la app para una entrada (null = la suelta). */
  desdeApp(gpio: number, nivel: 0 | 1 | null): void {
    if (nivel === null) this.app.delete(gpio);
    else this.app.set(gpio, nivel);
    this.recalcular(gpio);
  }

  /** Un pin de un chip cableado al micro. */
  desdeChip(chip: ChipEnBus, pin: string, nivel: 0 | 1 | null): void {
    const gpio = chip.pinesGpio[pin];
    if (gpio === undefined) return;
    const efectivo = nivel === null && chip.pullUps.includes(pin) ? 1 : nivel;
    let m = this.chips.get(gpio);
    if (!m) this.chips.set(gpio, (m = new Map()));
    m.set(`${chip.id}.${pin}`, efectivo);
    this.recalcular(gpio);
  }

  /** Vuelve a aplicar todo (una CPU nueva después de un reset). */
  reaplicar(): void {
    for (const gpio of new Set([...this.app.keys(), ...this.chips.keys()])) this.recalcular(gpio);
  }

  /** Nivel combinado de una línea, o null si nadie la maneja. */
  nivel(gpio: number): 0 | 1 | null {
    const deChips = [...(this.chips.get(gpio)?.values() ?? [])];
    if (deChips.includes(0) || this.app.get(gpio) === 0) return 0;
    if (this.app.has(gpio)) return this.app.get(gpio)!;
    return deChips.includes(1) ? 1 : null;
  }

  private recalcular(gpio: number): void {
    this.aplicar(gpio, this.nivel(gpio));
  }
}
