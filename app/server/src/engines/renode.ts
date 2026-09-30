import type { Emulador } from '../emulatorBackend.js';
import type { MotorEmulacion } from './tipos.js';

/**
 * TODO (preparado, sin implementar): motor genérico con Renode (Antmicro).
 *
 * Es el que habilitaría "casi cualquier placa" del lado de la emulación: Renode emula
 * Cortex-M (STM32, nRF52, RP2040...), RISC-V y más, describiendo la placa con un
 * archivo .repl (plataforma: CPU, memoria, periféricos y a qué GPIO va cada pin).
 * Idea de implementación (misma cara que avrEmulator.ts):
 *   - Opciones: { platform: "platforms/cpus/stm32f103.repl" | ruta a un .repl propio,
 *     machine?: string, uart: "sysbus.usart1", gpio: { "<gpio>": "sysbus.gpioPortA@5" } }.
 *   - Arrancar `renode --disable-xwt --console` con un .resc generado:
 *       mach create; machine LoadPlatformDescription @<repl>; sysbus LoadELF @<firmware.elf>;
 *       emulation CreateServerSocketTerminal <puerto> "uart"; connector Connect <uart> uart; start
 *   - Consola: leer el socket de la terminal → onLog.
 *   - Pines (io.mode "native"): el monitor de Renode permite `gpioPortA OnGPIO 5 true` para
 *     entradas y, para salidas, un GPIO "LED" en el .repl cuyo estado se lee con el monitor
 *     o con un hook Python (`gpioPortA@5 -> led@0`). Emitir onBridgeMessage({OUT}) al cambiar.
 *   - READY: al `start`, igual que avr8js (no hay puente dentro del firmware).
 * Toolchain compañero: platformio (toolchains/platformio.ts) produce el .elf.
 */
export const renode: MotorEmulacion = {
  nombre: 'renode',
  descripcion: 'Renode (Cortex-M, RISC-V... por archivos .repl). Interfaz lista, sin implementar todavía.',
  disponible: false,
  modosIo: ['native'],
  crear(): Emulador {
    throw new Error('El motor "renode" todavía no está implementado (ver server/src/engines/renode.ts).');
  },
  opcionesArranque: () => ({}),
  validarOpciones(opciones) {
    return typeof opciones.platform === 'string' ? [] : ['options.platform: falta el .repl de la plataforma de Renode'];
  },
};
