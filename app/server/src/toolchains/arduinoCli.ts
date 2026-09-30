import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { run } from '../dockerRunner.js';
import { exists, FIRST_BUILD_TIMEOUT_MS, type BuildCallbacks, type BuildError, type BuildResult } from '../buildService.js';
import { arduinoSketchAvr } from '../templates/languages.js';
import { fallo, pinesDemo, texto, type ContextoBuild, type Toolchain } from './tipos.js';

/**
 * arduino-cli + core arduino:avr. La imagen la construye la app desde
 * docker/arduino-avr/Dockerfile la primera vez; el tag lleva las dos versiones fijadas.
 */
export const ARDUINO_AVR_IMAGE = 'emu-arduino-avr:1.5.1-1.8.6';

const EXT_ARDUINO = new Set(['.cpp', '.c', '.h', '.hpp', '.cc']);

/** Copia el código del proyecto (raíz y src/) a la carpeta del sketch. Devuelve las rutas copiadas. */
async function copiarCodigoArduino(desde: string, hacia: string, rel = ''): Promise<string[]> {
  const copiados: string[] = [];
  const entradas = await fs.readdir(path.join(desde, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entradas) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // arduino-cli compila src/ (recursivo); otras carpetas no las ve.
      if (r === 'src' || r.startsWith('src/')) copiados.push(...(await copiarCodigoArduino(desde, hacia, r)));
      continue;
    }
    if (!EXT_ARDUINO.has(path.extname(e.name).toLowerCase())) continue;
    await fs.mkdir(path.dirname(path.join(hacia, r)), { recursive: true });
    await fs.copyFile(path.join(desde, r), path.join(hacia, r));
    copiados.push(r);
  }
  return copiados;
}

/**
 * Errores de gcc (vía arduino-cli) con el formato de los demás builders:
 * "/build/sketch/sketch.cpp:14:1: error: ..." → { file: 'sketch.cpp', line: 14 }.
 * Solo los del código del usuario llevan archivo; los del core quedan sin ruta.
 */
export function extractArduinoErrors(lines: string[]): BuildError[] {
  const errores: BuildError[] = [];
  for (const cruda of lines) {
    // eslint-disable-next-line no-control-regex
    const line = cruda.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
    const m = /^(.*?):(\d+)(?::(\d+))?:\s*(?:fatal\s+)?error:\s*(.*)$/.exec(line);
    if (m) {
      const archivo = m[1]!.startsWith('/build/sketch/') ? m[1]!.slice('/build/sketch/'.length) : null;
      errores.push({
        file: archivo,
        line: archivo ? Number(m[2]) : null,
        message: archivo ? m[4]! : `${path.basename(m[1]!)}:${m[2]}: ${m[4]}`,
      });
      continue;
    }
    // Errores del enlazador: "sketch.cpp:(.text+0x8): undefined reference to `foo()'"
    const ld = /undefined reference to (.*)$/.exec(line);
    if (ld) errores.push({ file: null, line: null, message: `falta definir ${ld[1]} (undefined reference)` });
    if (/^Error during build:/.test(line) && errores.length === 0) errores.push({ file: null, line: null, message: line });
  }
  return errores;
}

let imagenLista = false;

/** Construye la imagen de arduino-cli si no existe (una sola vez, un par de minutos). */
export async function ensureArduinoImage(cb: BuildCallbacks): Promise<boolean> {
  if (imagenLista) return true;
  const hay = await run('docker', ['image', 'inspect', ARDUINO_AVR_IMAGE], () => undefined, { timeoutMs: 30_000 });
  if (hay.code === 0) {
    imagenLista = true;
    return true;
  }
  cb.onLine('Preparando la imagen de Arduino (arduino-cli + core AVR). Es una sola vez y tarda un par de minutos...');
  const dir = path.join(PATHS.root, 'docker', 'arduino-avr');
  const res = await run('docker', ['build', '-t', ARDUINO_AVR_IMAGE, dir], (l) => cb.onLine(l), { timeoutMs: FIRST_BUILD_TIMEOUT_MS });
  imagenLista = res.code === 0;
  return imagenLista;
}

/**
 * Arduino con arduino-cli en Docker (placas AVR: Uno, Nano...). Salida: .hex para avr8js.
 * Opciones: fqbn (obligatorio, p. ej. "arduino:avr:uno"). Hoy la imagen trae solo el core
 * arduino:avr; otra familia (rp2040, stm32) necesita su core en la imagen.
 *
 * El código del usuario sigue siendo sketch.cpp (igual que en ESP32): se copia a una
 * carpeta de sketch "de verdad" (arduino-cli exige <carpeta>/<carpeta>.ino) con un
 * sketch.ino vacío.
 */
export const arduinoCli: Toolchain = {
  nombre: 'arduino-cli',
  descripcion: 'arduino-cli 1.5.1 + core arduino:avr 1.8.6 en Docker (imagen docker/arduino-avr); salida: .hex.',
  disponible: true,
  lenguajes: ['arduino'],

  validarOpciones(_l, opciones) {
    const fqbn = texto(opciones, 'fqbn');
    if (!fqbn) return ['options.fqbn: falta el FQBN de arduino-cli (p. ej. "arduino:avr:uno")'];
    if (!fqbn.startsWith('arduino:avr:')) return [`options.fqbn: la imagen solo trae el core arduino:avr (pediste ${fqbn})`];
    return [];
  },

  plantilla(_l, placa) {
    const d = pinesDemo(placa.desc);
    return { 'sketch.cpp': arduinoSketchAvr(placa.nombre, { n: d.entrada, nombre: d.nombreEntrada }, { n: d.salida, nombre: d.nombreSalida }) };
  },

  async build(ctx: ContextoBuild): Promise<BuildResult> {
    const { projectDir, buildDir: outDir, cb, started } = ctx;
    const fqbn = texto(ctx.opciones, 'fqbn');
    if (!fqbn) return fallo(started, `${ctx.placa.nombre}: falta options.fqbn para arduino-cli`);
    const sketchDir = path.join(outDir, 'sketch');
    await fs.rm(sketchDir, { recursive: true, force: true });
    await fs.mkdir(sketchDir, { recursive: true });
    const copiados = await copiarCodigoArduino(projectDir, sketchDir);
    if (!copiados.includes('sketch.cpp')) return fallo(started, 'El proyecto no tiene sketch.cpp');
    await fs.writeFile(
      path.join(sketchDir, 'sketch.ino'),
      '// Generado por la app: el código está en sketch.cpp (y los .h/.cpp que agregues).\n',
      'utf8',
    );

    if (!(await ensureArduinoImage(cb))) {
      return fallo(started, `No se pudo preparar la imagen ${ARDUINO_AVR_IMAGE} (docker build docker/arduino-avr).`);
    }

    const args = [
      'run', '--rm',
      '--name', `emu-build-${path.basename(outDir)}`,
      '-u', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '-e', 'HOME=/tmp',
      '-v', `${outDir}:/build`,
      ARDUINO_AVR_IMAGE,
      'arduino-cli', 'compile',
      '--fqbn', fqbn,
      // La carpeta de objetos queda entre compilaciones: la segunda vez no recompila el core.
      '--build-path', '/build/obj',
      '--output-dir', '/build/out',
      // Compilación "debug" por defecto (como Android Studio / VS Code): -Og -g, sin LTO. Con la
      // optimización normal (-Os + LTO) el compilador mete digitalRead/digitalWrite/delay adentro
      // del sketch y esas líneas quedan sin código propio: no se les puede poner breakpoint ni se
      // ven las variables. EMU_DEBUG_BUILD=0 vuelve a la compilación optimizada de siempre.
      // Ojo: `--optimize-for-debug` no alcanza — el core arduino:avr 1.8.6 no define un perfil de
      // debug (build.options.json queda con optimization_flags ""). Las *extra_flags van después de
      // las del core en cada receta, así que -Og y -fno-lto pisan a -Os y -flto.
      ...(process.env.EMU_DEBUG_BUILD === '0'
        ? []
        : [
            '--build-property', 'compiler.c.extra_flags=-Og -fno-lto',
            '--build-property', 'compiler.cpp.extra_flags=-Og -fno-lto',
            '--build-property', 'compiler.c.elf.extra_flags=-Og -fno-lto',
          ]),
      '/build/sketch',
    ];
    cb.onLine(`$ docker ${args.join(' ')}`);
    const lines: string[] = [];
    const res = await run('docker', args, (line) => {
      lines.push(line);
      cb.onLine(line);
    }, { timeoutMs: ctx.timeoutMs, onChild: ctx.registrarProceso });
    ctx.terminoProceso();
    if (res.timedOut) return fallo(started, `Se pasó el tiempo de compilación (${Math.round(ctx.timeoutMs / 60_000)} min) y se canceló.`);
    if (res.code !== 0) {
      const errors = extractArduinoErrors(lines);
      return {
        ok: false,
        durationMs: Date.now() - started,
        errors: errors.length > 0 ? errors : [{ line: null, file: null, message: `La compilación terminó con código ${res.code}.` }],
        lineMap: null,
        warnings: [],
        artifacts: null,
      };
    }
    const firmware = path.join(outDir, 'out', 'sketch.ino.hex');
    if (!(await exists(firmware))) return fallo(started, `No apareció ${firmware}.`);
    const elf = path.join(outDir, 'out', 'sketch.ino.elf');
    return {
      ok: true,
      durationMs: Date.now() - started,
      errors: [],
      lineMap: null,
      warnings: [],
      artifacts: { firmware, elf: (await exists(elf)) ? elf : null, usesWebServer: false, usesApi: false, needsRepl: false },
    };
  },
};
