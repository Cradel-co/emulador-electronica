import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PATHS } from '../paths.js';
import { run } from '../dockerRunner.js';
import { exists, type BuildCallbacks, type BuildResult } from '../buildService.js';
import { ProjectError } from '../projectStore.js';
import { micropythonMainPara } from '../templates/languages.js';
import { microPythonBoot, microPythonSimbridgePara } from '../templates/micropythonBridge.js';
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
export async function ensureMicropythonFirmware(cb: BuildCallbacks, file = MICROPYTHON_FILE, url = micropythonUrl(file)): Promise<string> {
  const target = firmwarePath(file);
  const hashFile = target + '.sha256';
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await exists(target)) return target;

  cb.onLine(`Descargando el firmware de MicroPython ${MICROPYTHON_VERSION} (${file}, ~2 MB)...`);
  const res = await run('curl', ['-fsSL', '-o', target, url], (line) => cb.onLine(line), { timeoutMs: 120_000 });
  if (res.code !== 0) {
    throw new ProjectError(
      `No se pudo descargar el firmware de MicroPython desde ${url}. ` +
        'Para MicroPython hace falta internet una vez; los demás lenguajes no.',
      502,
    );
  }
  // TOFU: se guarda el hash del primer download para detectar que cambie.
  if (!(await exists(hashFile))) {
    const hash = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    await fs.writeFile(hashFile, `${hash}  ${file}\n`, 'utf8');
    cb.onLine(`SHA-256 del firmware: ${hash}`);
  }
  return target;
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
          delProyecto: (await fs.readdir(ctx.projectDir)).filter(f => /^[a-zA-Z0-9_-]+\.py$/.test(f) && f !== 'boot.py' && f !== 'simbridge.py').sort(),
        },
      },
    };
  },
};
