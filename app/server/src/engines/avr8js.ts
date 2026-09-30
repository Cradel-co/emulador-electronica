import { AvrEmulator } from '../avrEmulator.js';
import { PUERTOS_ATMEGA328P } from '../avrSim.js';
import type { MotorEmulacion } from './tipos.js';

export const MCUS_AVR8JS = ['atmega328p'];

/**
 * avr8js (Wokwi): ATmega328P ciclo a ciclo, en un worker_thread. Nativo: lee y escribe
 * los pines del MCU directo (cada pin de `board.pins` necesita `port` y `bit`).
 * Opciones: mcu ("atmega328p"), clockHz (por defecto 16 MHz).
 */
export const avr8js: MotorEmulacion = {
  nombre: 'avr8js',
  descripcion: 'avr8js (Wokwi): ATmega328P ciclo a ciclo. Entradas nativas en el pad (setPin).',
  disponible: true,
  modosIo: ['native'],
  crear: (eventos) => new AvrEmulator(eventos),
  opcionesArranque: (desc) => ({
    frecuenciaHz: Number(desc.backend.options.clockHz ?? 16_000_000),
    pinesMcu: Object.values(desc.pins).map((p) => ({ gpio: p.gpio, port: p.port ?? '', bit: p.bit ?? -1 })),
  }),
  validarOpciones(opciones, desc) {
    const errores: string[] = [];
    const mcu = String(opciones.mcu ?? 'atmega328p');
    if (!MCUS_AVR8JS.includes(mcu)) errores.push(`options.mcu: "${mcu}" no está soportado (${MCUS_AVR8JS.join(', ')})`);
    const hz = opciones.clockHz;
    if (hz !== undefined && (typeof hz !== 'number' || hz <= 0 || hz > 32_000_000)) errores.push('options.clockHz: número de Hz (hasta 32 MHz)');
    if (desc.io.mode !== 'native') errores.push('avr8js necesita io.mode "native"');
    for (const [nombre, p] of Object.entries(desc.pins)) {
      if (p.port !== undefined && !(PUERTOS_ATMEGA328P as readonly string[]).includes(p.port)) {
        errores.push(`pins.${nombre}: el ATmega328P no tiene el puerto ${p.port} (${PUERTOS_ATMEGA328P.join(', ')})`);
      }
      if (p.bit !== undefined && p.bit > 7) errores.push(`pins.${nombre}: bit ${p.bit} fuera de 0-7`);
    }
    return errores;
  },
};
