import type { Toolchain } from './tipos.js';
import { esphome } from './esphome.js';
import { espIdf } from './espIdf.js';
import { arduinoCli } from './arduinoCli.js';
import { micropython } from './micropython.js';
import { platformio } from './platformio.js';

/**
 * Toolchains registrados por nombre (el que usa `board.languages.<l>.toolchain` en el
 * module.json de una placa). Uno nuevo = un archivo con un `Toolchain` y una línea acá.
 */
export const TOOLCHAINS: Record<string, Toolchain> = Object.fromEntries(
  [esphome, espIdf, arduinoCli, micropython, platformio].map((t) => [t.nombre, t]),
);

export function toolchain(nombre: string): Toolchain | undefined {
  return TOOLCHAINS[nombre];
}

export type { Toolchain, ContextoBuild, PlacaBuild } from './tipos.js';
