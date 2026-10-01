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
        alimentado: c.alimentado, maxHz: c.maxHz, encendidoEnUs: -arranqueMs * 1000,
      });
    } catch (err) {
      ev.alLog?.(`[i2c] ${c.nombre}: ${(err as Error).message}`);
    }
  }
  return bus;
}
