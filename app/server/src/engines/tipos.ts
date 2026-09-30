import type { BoardDescriptor } from '@emu/shared';
import type { BuildArtifacts } from '../buildService.js';
import type { EmulatorEvents } from '../emulator.js';
import type { Emulador, OpcionesArranque } from '../emulatorBackend.js';

/**
 * Interfaz de un motor de emulación (plugin). Ver README.md de esta carpeta.
 *
 * Una placa elige su motor en el module.json:
 *   "backend": { "engine": "avr8js", "options": { "mcu": "atmega328p", "clockHz": 16000000 } }
 * El server busca "avr8js" en ENGINES (index.ts), crea una instancia con `crear(eventos)`
 * y la arranca con `opcionesArranque(desc, artefactos)`.
 *
 * La instancia (`Emulador`, emulatorBackend.ts) avisa todo por `EmulatorEvents`:
 *   onLog(línea)                → consola (emu.log)
 *   onState(estado)             → starting / booted / bridge / crashed / hung / stopped
 *   onBridgeMessage({READY})    → la simulación está lista para manejar pines ("En vivo")
 *   onBridgeMessage({OUT pin})  → cambió una salida (pin.out)
 * y recibe entradas por `getBridge().setInput(pin, nivel)` (pin.in) / `watch(pin)`.
 */
export interface MotorEmulacion {
  /** Nombre con el que lo referencia `board.backend.engine`. */
  nombre: string;
  descripcion: string;
  /** false = interfaz lista pero sin implementar: las placas que lo usan no emulan. */
  disponible: boolean;
  /** `io.mode` que soporta: por el puente dentro del firmware, o nativo. */
  modosIo: ('bridge-uart' | 'native')[];
  crear(eventos: EmulatorEvents): Emulador;
  /** Opciones de arranque a partir del descriptor y de lo que dejó el toolchain. */
  opcionesArranque(desc: BoardDescriptor, artefactos: BuildArtifacts): OpcionesArranque;
  /** Chequeos de `board.backend.options` (además del esquema). */
  validarOpciones?(opciones: Record<string, unknown>, desc: BoardDescriptor): string[];
}
