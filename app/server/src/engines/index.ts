import type { MotorEmulacion } from './tipos.js';
import { espEmu } from './espEmu.js';
import { avr8js } from './avr8js.js';
import { renode } from './renode.js';

/**
 * Motores de emulación registrados por nombre (el que usa `board.backend.engine` en el
 * module.json de una placa). Uno nuevo = un archivo con un `MotorEmulacion` y una línea acá.
 */
export const ENGINES: Record<string, MotorEmulacion> = Object.fromEntries([espEmu, avr8js, renode].map((m) => [m.nombre, m]));

export function motor(nombre: string): MotorEmulacion | undefined {
  return ENGINES[nombre];
}

export type { MotorEmulacion } from './tipos.js';
