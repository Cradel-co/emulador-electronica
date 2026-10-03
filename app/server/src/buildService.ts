import { promises as fs } from 'node:fs';
import path from 'node:path';
import { lenguajesDe, placasDelProyecto, tienePlaca, type Project, type ProyectoConPlaca } from '@emu/shared';
import { PATHS } from './paths.js';
import type { BuildError as BuildErrorLike, LineMap } from './yamlSim.js';
import { buscarPlaca } from './boardRegistry.js';
import { TOOLCHAINS } from './toolchains/index.js';
import type { PlacaBuild } from './toolchains/tipos.js';
import { fallo } from './toolchains/tipos.js';
import { ensureMicropythonFirmware, firmwarePath, MICROPYTHON_FILE, MICROPYTHON_URL, MICROPYTHON_VERSION } from './toolchains/micropython.js';

// Versiones fijadas (sección 16): viven en cada toolchain; se reexportan por compatibilidad.
export { ESPHOME_IMAGE } from './toolchains/esphome.js';
export { IDF_IMAGE } from './toolchains/espIdf.js';
export { ARDUINO_AVR_IMAGE, extractArduinoErrors } from './toolchains/arduinoCli.js';
export { MICROPYTHON_FILE, MICROPYTHON_URL, MICROPYTHON_VERSION };

export const FIRST_BUILD_TIMEOUT_MS = 20 * 60_000;
export const WARM_BUILD_TIMEOUT_MS = 10 * 60_000;

export type BuildError = BuildErrorLike;

export interface BuildResult {
  ok: boolean;
  durationMs: number;
  errors: BuildError[];
  lineMap: LineMap | null;
  artifacts: BuildArtifacts | null;
  warnings: string[];
  /** Artefactos independientes de cada placa cuando se compila el circuito completo. */
  boardResults?: Record<string, BuildResult>;
}

export interface BuildArtifacts {
  firmware: string;
  elf: string | null;
  usesWebServer: boolean;
  usesApi: boolean;
  needsRepl: boolean;
  /** Pares TX:RX para `esp-emu --rmt-loopback` (RF 433, 7.3), si el toolchain los necesita. */
  rmtLoopback?: string[];
  /**
   * Archivos a subir por el REPL al arrancar (MicroPython, 8.8): los que genera el
   * toolchain y los del proyecto (se leen recién al arrancar, así va siempre lo último).
   */
  repl?: { generados: { path: string; content: string }[]; delProyecto: string[] };
}

export interface BuildCallbacks {
  onLine: (line: string) => void;
  onNotice?: (line: string) => void;
}

/**
 * Compila un proyecto con el toolchain que dice su placa para su lenguaje
 * (`board.languages.<lenguaje>.toolchain` del module.json). Los toolchains son
 * plugins (toolchains/); acá solo se resuelve cuál, se evita compilar dos veces lo
 * mismo (8.4) y se puede cancelar.
 */
export class BuildService {
  private running = new Map<string, { kill: (s?: NodeJS.Signals) => void }>();
  private everBuilt = new Set<string>();
  /** Build en vuelo por proyecto: dos clics no compilan dos veces (8.4). */
  private inflight = new Map<string, Promise<BuildResult>>();

  buildDir(name: string, boardId = 'board'): string {
    return boardId === 'board' ? path.join(PATHS.builds, name) : path.join(PATHS.builds, name, 'boards', boardId);
  }

  isBuilding(name: string): boolean {
    return [...this.inflight.keys()].some(key => key.startsWith(`${name}:`)) || [...this.running.keys()].some(key => key === name || key.startsWith(`${name}:`));
  }

  /** Cancela la compilación en curso del proyecto (8.4). */
  cancel(name: string): boolean {
    let cancelled = false;
    for (const [key, job] of this.running) if (key === name || key.startsWith(`${name}:`)) {
      job.kill('SIGKILL'); this.running.delete(key); cancelled = true;
    }
    return cancelled;
  }

  build(project: Project, cb: BuildCallbacks, boardId?: string): Promise<BuildResult> {
    const selected = boardId ?? placasDelProyecto(project)[0]?.id ?? 'board';
    const key = `${project.name}:${selected}`;
    const prev = this.inflight.get(key);
    if (prev) {
      cb.onLine('Ya había una compilación de este proyecto en curso; se espera a esa.');
      return prev;
    }
    const job = this.doBuild(project, cb, selected).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  async buildBoards(project: Project, cb: (boardId: string) => BuildCallbacks): Promise<BuildResult> {
    const started = Date.now();
    const boards = placasDelProyecto(project);
    if (!boards.length) return fallo(started, 'Proyecto sin placa: no hay código que compilar.');
    const results = await Promise.all(boards.map(async board => [board.id, await this.build(project, cb(board.id), board.id)] as const));
    const boardResults = Object.fromEntries(results);
    const primary = results[0]![1];
    return { ...primary, ok: results.every(([, r]) => r.ok), durationMs: Date.now() - started,
      errors: results.flatMap(([id, r]) => r.errors.map(e => ({ ...e, message: boards.length > 1 ? `[${id}] ${e.message}` : e.message }))),
      warnings: results.flatMap(([, r]) => r.warnings), boardResults };
  }

  private async doBuild(project: Project, cb: BuildCallbacks, boardId: string): Promise<BuildResult> {
    const started = Date.now();
    const board = placasDelProyecto(project).find(b => b.id === boardId);
    if (!board) return fallo(started, `No existe la placa "${boardId}" en este proyecto.`);
    const selected: ProyectoConPlaca = { ...project, board: board.board, language: board.language };
    const placa = await buscarPlaca(board.board);
    if (!placa) return fallo(started, `La placa "${board.board}" no está en el catálogo (¿se quitó el módulo?).`);
    const key = `${project.name}:${boardId}`;
    const codeDir = boardId === 'board' ? path.join(PATHS.projects, project.name) : path.join(PATHS.projects, project.name, 'boards', boardId);
    const r = await this.compilarEn(selected, placa, codeDir, this.buildDir(project.name, boardId), cb, {
      clave: key,
      timeoutMs: this.everBuilt.has(key) ? WARM_BUILD_TIMEOUT_MS : FIRST_BUILD_TIMEOUT_MS,
    });
    if (r.ok) this.everBuilt.add(key);
    return r;
  }

  /**
   * Compila el código que está en `projectDir` para una placa, dejando todo en `buildDir`.
   * La usa también la certificación de placas, con carpetas temporales (nunca projects/).
   */
  async compilarEn(
    project: ProyectoConPlaca,
    placa: PlacaBuild,
    projectDir: string,
    buildDir: string,
    cb: BuildCallbacks,
    opts: { clave?: string; timeoutMs?: number } = {},
  ): Promise<BuildResult> {
    const started = Date.now();
    const destino = placa.desc.languages[project.language];
    if (!destino) {
      return fallo(started, `${placa.nombre} no se puede programar en ${project.language}. Lenguajes de esta placa: ${lenguajesDe(placa.desc).join(', ')}.`);
    }
    const t = TOOLCHAINS[destino.toolchain];
    if (!t) return fallo(started, `${placa.nombre}: el toolchain "${destino.toolchain}" no existe en este server.`);
    if (!t.disponible) return fallo(started, `El toolchain "${t.nombre}" todavía no está implementado.`);
    const clave = opts.clave ?? buildDir;
    await fs.mkdir(buildDir, { recursive: true });
    try {
      return await t.build({
        project,
        projectDir,
        buildDir,
        placa,
        lenguaje: project.language,
        opciones: destino.options,
        cb,
        timeoutMs: opts.timeoutMs ?? FIRST_BUILD_TIMEOUT_MS,
        started,
        registrarProceso: (kill) => this.running.set(clave, { kill }),
        terminoProceso: () => this.running.delete(clave),
      });
    } finally {
      this.running.delete(clave);
    }
  }

  // --- MicroPython (8.8): se mantienen por compatibilidad -----------------------

  firmwarePath(name = MICROPYTHON_FILE): string {
    return firmwarePath(name);
  }

  ensureMicropythonFirmware(cb: BuildCallbacks, file = MICROPYTHON_FILE): Promise<string> {
    return ensureMicropythonFirmware(cb, file);
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
