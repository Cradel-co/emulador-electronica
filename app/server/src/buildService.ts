import { promises as fs } from 'node:fs';
import path from 'node:path';
import { lenguajesDe, type Project } from '@emu/shared';
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

  buildDir(name: string): string {
    return path.join(PATHS.builds, name);
  }

  isBuilding(name: string): boolean {
    return this.running.has(name);
  }

  /** Cancela la compilación en curso del proyecto (8.4). */
  cancel(name: string): boolean {
    const job = this.running.get(name);
    if (!job) return false;
    job.kill('SIGKILL');
    this.running.delete(name);
    return true;
  }

  build(project: Project, cb: BuildCallbacks): Promise<BuildResult> {
    const prev = this.inflight.get(project.name);
    if (prev) {
      cb.onLine('Ya había una compilación de este proyecto en curso; se espera a esa.');
      return prev;
    }
    const job = this.doBuild(project, cb).finally(() => this.inflight.delete(project.name));
    this.inflight.set(project.name, job);
    return job;
  }

  private async doBuild(project: Project, cb: BuildCallbacks): Promise<BuildResult> {
    const started = Date.now();
    const placa = await buscarPlaca(project.board);
    if (!placa) return fallo(started, `La placa "${project.board}" no está en el catálogo (¿se quitó el módulo?).`);
    const r = await this.compilarEn(project, placa, path.join(PATHS.projects, project.name), this.buildDir(project.name), cb, {
      clave: project.name,
      timeoutMs: this.everBuilt.has(project.name) ? WARM_BUILD_TIMEOUT_MS : FIRST_BUILD_TIMEOUT_MS,
    });
    if (r.ok) this.everBuilt.add(project.name);
    return r;
  }

  /**
   * Compila el código que está en `projectDir` para una placa, dejando todo en `buildDir`.
   * La usa también la certificación de placas, con carpetas temporales (nunca projects/).
   */
  async compilarEn(
    project: Project,
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
