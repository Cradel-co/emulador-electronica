import { EmulatorManager } from '../emulator.js';
import type { MotorEmulacion } from './tipos.js';

/** Chips que acepta `esp-emu --chip` (v0.44.0). El ESP32 clásico (LX6) no está. */
export const CHIPS_ESP_EMU = ['esp32c3', 'esp32c5', 'esp32c6', 'esp32h2', 'esp32p4', 'esp32s3', 'esp32s31'];

/**
 * esp-emu (Espressif): emulador real de ESP32-S3/C3/C5/C6/H2/P4. Las entradas van por el
 * puente dentro del firmware (io.mode "bridge-uart", UART1 por TCP), porque esp-emu no
 * deja manejar los pads desde afuera.
 * Opciones: chip (obligatorio, uno de CHIPS_ESP_EMU).
 */
export const espEmu: MotorEmulacion = {
  nombre: 'esp-emu',
  descripcion: 'esp-emu de Espressif (binario local): ESP32-S3/C3/C5/C6/H2/P4. Entradas por el puente UART.',
  disponible: true,
  modosIo: ['bridge-uart'],
  crear: (eventos) => new EmulatorManager(eventos),
  opcionesArranque: (desc, artefactos) => ({
    chip: String(desc.backend.options.chip ?? desc.chip),
    rmtLoopback: artefactos.rmtLoopback ?? [],
  }),
  validarOpciones(opciones, desc) {
    const errores: string[] = [];
    const chip = String(opciones.chip ?? '');
    if (!CHIPS_ESP_EMU.includes(chip)) errores.push(`options.chip: "${chip}" no es un chip de esp-emu (${CHIPS_ESP_EMU.join(', ')})`);
    if (desc.io.mode !== 'bridge-uart') errores.push('esp-emu necesita io.mode "bridge-uart" (no se pueden tocar los pads desde afuera)');
    else if (desc.io.uart !== 1) errores.push('esp-emu expone solo UART1 por TCP para el puente (io.uart = 1)');
    return errores;
  },
};
