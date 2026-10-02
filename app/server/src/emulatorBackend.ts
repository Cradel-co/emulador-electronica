import type { BuildArtifacts } from './buildService.js';
import type { EmulatorStatus } from './emulator.js';
import type { ChipEnBus } from './bus/proyectoChips.js';

/**
 * Lo que la app necesita de un motor de emulación, sea cual sea el chip:
 * esp-emu (ESP32-S3/C3/C6, emulator.ts) o avr8js (Arduino Uno, avrEmulator.ts).
 * index.ts elige el motor según la placa del proyecto (registro de placas) y
 * después lo usa siempre igual.
 */

/** Canal para manejar pines del firmware en ejecución (el puente de 7.1, o el equivalente del motor). */
export interface PuenteSim {
  /** Pedir que se reporten los cambios de salida de un pin (@WATCH). */
  watch(pin: number): void;
  /** Poner un nivel en una entrada (@IN). */
  setInput(pin: number, level: number): void;
  /** Hacer llegar un código RF al receptor (@RF). */
  sendRf(bits: string, protocol: number): void;
}

export interface OpcionesArranque {
  /** Pares TX:RX para `esp-emu --rmt-loopback` (solo esp-emu). */
  rmtLoopback?: string[];
  /** Chip para `esp-emu --chip` (solo esp-emu). Por defecto esp32s3. */
  chip?: string;
  /** Frecuencia del reloj (solo avr8js). */
  frecuenciaHz?: number;
  /** Pines del MCU: número lógico → puerto/bit (solo motores nativos como avr8js). */
  pinesMcu?: { gpio: number; port: string; bit: number }[];
  /** Chips del dibujo conectados a un bus I2C del micro (solo motores con `board.buses`). */
  chips?: ChipEnBus[];
  /** ms entre la alimentación y la primera instrucción del micro (`board.arranqueMs`). */
  arranqueMs?: number;
}

export interface Emulador {
  start(projectName: string, artifacts: BuildArtifacts, opts?: OpcionesArranque): Promise<EmulatorStatus>;
  stop(): Promise<void>;
  reset(): Promise<string>;
  getStatus(): EmulatorStatus;
  getRecentLog(limit?: number): string[];
  /** Texto a la entrada de la consola (REPL de MicroPython, Serial). */
  writeConsole(data: string): boolean;
  getBridge(): PuenteSim | null;
  /** El puente avisó @READY: estado 'bridge'. */
  markBridgeReady(): void;
  shutdown(): Promise<void>;
}
