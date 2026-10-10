import path from 'node:path';
import { PATHS } from '../paths.js';
import type { BuildCallbacks, BuildResult } from '../buildService.js';
import { obtenerFirmware } from '../cacheFirmware.js';
import { ProjectError } from '../projectStore.js';
import { micropythonMainPara } from '../templates/languages.js';
import { microPythonBoot, microPythonSimbridgePara } from '../templates/micropythonBridge.js';
import { leerFuentesMicroPython, MicroPythonSourceError, type MicroPythonSourceManifest } from '../micropythonSources.js';
import { fallo, pinesDemo, texto, type ContextoBuild, type Toolchain } from './tipos.js';

/** Versión fijada (sección 16): misma para todos los chips. */
export const MICROPYTHON_VERSION = 'v1.29.0';
export const MICROPYTHON_FILE = `ESP32_GENERIC_S3-20260824-${MICROPYTHON_VERSION}.bin`;
export const micropythonUrl = (file: string): string => `https://micropython.org/resources/firmware/${file}`;
export const MICROPYTHON_URL = micropythonUrl(MICROPYTHON_FILE);

export function firmwarePath(name = MICROPYTHON_FILE): string {
  return path.join(PATHS.firmware, 'micropython', name);
}

/** Descarga el firmware de MicroPython (el de la placa) una sola vez y fija su hash (8.8, 16). */
const firmwareDownloads = new Map<string, Promise<string>>();
export function ensureMicropythonFirmware(cb: BuildCallbacks, file = MICROPYTHON_FILE, url = micropythonUrl(file)): Promise<string> {
  const target = firmwarePath(file);
  const pending = firmwareDownloads.get(target);
  if (pending) return pending;
  const job = downloadFirmware(cb, file, url).finally(() => firmwareDownloads.delete(target));
  firmwareDownloads.set(target, job);
  return job;
}
async function downloadFirmware(cb: BuildCallbacks, file: string, url: string): Promise<string> {
  try { return await obtenerFirmware(firmwarePath(file), url, line => cb.onLine(line)); }
  catch (error) {
    throw new ProjectError(`No se pudo preparar el firmware de MicroPython: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
}

/**
 * MicroPython (8.8): no se compila. Se usa el firmware oficial del chip y, al arrancar,
 * se suben por el REPL simbridge.py (el puente en Python), boot.py y el main.py del usuario.
 * Opciones:
 *   firmware (obligatorio): archivo de micropython.org/resources/firmware/ (o `url`).
 *   url: de dónde bajarlo, si no es de micropython.org.
 *   gpioOutRegs (obligatorio): [GPIO_OUT_REG, GPIO_OUT1_REG?] del chip, para leer las salidas.
 */
export const micropython: Toolchain = {
  nombre: 'micropython',
  descripcion: 'Firmware oficial de MicroPython (se baja una vez); el código se sube por el REPL al arrancar.',
  disponible: true,
  lenguajes: ['micropython'],

  validarOpciones(_l, opciones, placa) {
    const errores: string[] = [];
    if (!texto(opciones, 'firmware')) errores.push('options.firmware: falta el archivo del firmware de MicroPython');
    const regs = opciones.gpioOutRegs;
    if (!Array.isArray(regs) || regs.length === 0 || regs.some((r) => typeof r !== 'number')) {
      errores.push('options.gpioOutRegs: lista de direcciones (números) de GPIO_OUT_REG [y GPIO_OUT1_REG]');
    }
    if (placa.desc.io.mode !== 'bridge-uart') errores.push('micropython: necesita io.mode "bridge-uart" (simbridge.py habla por una UART)');
    return errores;
  },

  plantilla(_l, placa) {
    const { entrada, salida } = pinesDemo(placa.desc);
    return { 'main.py': micropythonMainPara(entrada, salida) };
  },

  async build(ctx: ContextoBuild): Promise<BuildResult> {
    const { started, placa } = ctx;
    const file = texto(ctx.opciones, 'firmware');
    if (!file) return fallo(started, `${placa.nombre}: falta options.firmware para MicroPython`);
    if (placa.desc.io.mode !== 'bridge-uart') return fallo(started, `${placa.nombre}: MicroPython necesita io.mode "bridge-uart"`);
    let sources: MicroPythonSourceManifest;
    try { sources = await leerFuentesMicroPython(ctx.projectDir); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...fallo(started, message), errors: [{ line: null, file: error instanceof MicroPythonSourceError ? error.file ?? null : null, message }] };
    }
    ctx.cb.onLine(`MicroPython: ${sources.files.length} archivo(s) de la placa, ${sources.totalBytes} bytes; se conservan módulos y paquetes.`);
    const firmware = await ensureMicropythonFirmware(ctx.cb, file, texto(ctx.opciones, 'url'));
    const simbridge = microPythonSimbridgePara({
      chip: placa.desc.chipName ?? placa.desc.chip,
      uart: placa.desc.io.uart,
      tx: placa.desc.io.tx,
      rx: placa.desc.io.rx,
      gpioOutRegs: (ctx.opciones.gpioOutRegs as number[] | undefined) ?? [],
    });
    return {
      ok: true,
      durationMs: Date.now() - started,
      errors: [],
      lineMap: null,
      warnings: ['MicroPython no se compila: el código se carga en caliente.'],
      artifacts: {
        firmware,
        elf: null,
        usesWebServer: false,
        usesApi: false,
        needsRepl: true,
        // Sin esto, el chip arranca a un REPL vacío: nada ejecuta el código del usuario (8.8).
        repl: {
          generados: [
            { path: 'simbridge.py', content: simbridge },
            { path: 'boot.py', content: microPythonBoot },
          ],
          delProyecto: sources.files.map(source => source.path),
        },
      },
    };
  },
};
