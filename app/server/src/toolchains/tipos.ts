import type { BoardDescriptor, Language, Project } from '@emu/shared';
import type { BuildCallbacks, BuildResult } from '../buildService.js';

/**
 * Interfaz de un toolchain (plugin de compilación). Ver README.md de esta carpeta.
 *
 * Una placa elige su toolchain por lenguaje en el module.json:
 *   "languages": { "arduino": { "toolchain": "arduino-cli", "options": { "fqbn": "arduino:avr:uno" } } }
 * El server busca "arduino-cli" en TOOLCHAINS (index.ts) y le pasa esas `options`.
 */

/** La placa tal como la ve un toolchain: su id (el `type` del módulo), nombre y descriptor. */
export interface PlacaBuild {
  id: string;
  nombre: string;
  desc: BoardDescriptor;
}

export interface ContextoBuild {
  project: Project;
  /** Carpeta con el código del usuario (projects/<nombre>, o una temporal al certificar). */
  projectDir: string;
  /** Carpeta de trabajo de la compilación (.build/<nombre>): el toolchain escribe lo que quiera acá. */
  buildDir: string;
  placa: PlacaBuild;
  lenguaje: Language;
  /** `board.languages.<lenguaje>.options` del module.json. */
  opciones: Record<string, unknown>;
  cb: BuildCallbacks;
  timeoutMs: number;
  /** Momento en que arrancó la compilación (para durationMs). */
  started: number;
  /** Registra el proceso en curso, para poder cancelarlo (8.4). */
  registrarProceso: (kill: (s?: NodeJS.Signals) => void) => void;
  terminoProceso: () => void;
}

export interface Toolchain {
  /** Nombre con el que lo referencia `board.languages.<l>.toolchain`. */
  nombre: string;
  descripcion: string;
  /** false = interfaz lista pero sin implementar: las placas que lo usan quedan en "solo-dibujo". */
  disponible: boolean;
  /** Lenguajes que sabe compilar. */
  lenguajes: Language[];
  /** Compila (o prepara) el firmware. Los errores tienen que venir parseados (archivo/línea/mensaje). */
  build(ctx: ContextoBuild): Promise<BuildResult>;
  /**
   * Archivos de un proyecto nuevo (ruta → contenido; "${name}" = nombre del proyecto),
   * usando el circuito de prueba de la placa (`board.demo`). La placa puede pisarlos con
   * `board.templates.<lenguaje>.files`.
   */
  plantilla(lenguaje: Language, placa: PlacaBuild, opciones: Record<string, unknown>): Record<string, string>;
  /** Chequeos propios de `options` (además del esquema). Devuelve los errores. */
  validarOpciones?(lenguaje: Language, opciones: Record<string, unknown>, placa: PlacaBuild): string[];
}

/** Resultado de compilación fallida con un solo mensaje. */
export function fallo(started: number, message: string): BuildResult {
  return { ok: false, durationMs: Date.now() - started, errors: [{ line: null, file: null, message }], lineMap: null, warnings: [], artifacts: null };
}

/** Número de pin del circuito de prueba (`board.demo`), para las plantillas. */
export function pinesDemo(desc: BoardDescriptor): { entrada: number; salida: number; nombreEntrada: string; nombreSalida: string } {
  const entrada = desc.demo ? desc.pins[desc.demo.input]?.gpio : undefined;
  const salida = desc.demo ? desc.pins[desc.demo.output]?.gpio : undefined;
  return {
    entrada: entrada ?? 6,
    salida: salida ?? 7,
    nombreEntrada: desc.demo?.input ?? 'GPIO6',
    nombreSalida: desc.demo?.output ?? 'GPIO7',
  };
}

export function texto(opciones: Record<string, unknown>, clave: string): string | undefined {
  const v = opciones[clave];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
