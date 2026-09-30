import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run } from '../dockerRunner.js';
import { exists, type BuildResult } from '../buildService.js';
import { extractBuildErrors } from '../yamlSim.js';
import {
  arduinoIdfComponentYml,
  arduinoSketchPara,
  idfCMainCPara,
  idfCMainCppPara,
  idfSdkconfigDefaultsPara,
  idfSdkconfigDefaultsSimPara,
} from '../templates/languages.js';
import { fallo, pinesDemo, texto, type ContextoBuild, type Toolchain } from './tipos.js';

/** Versión fijada (sección 16). */
export const IDF_IMAGE = 'espressif/idf:v5.5.5';

const cmakeRaiz = (): string =>
  'cmake_minimum_required(VERSION 3.16)\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(${name})\n';

/**
 * ESP-IDF en Docker, para C, C++ y Arduino (arduino-esp32 como componente de ESP-IDF, 8.7).
 * Opciones (`board.languages.<l>.options`):
 *   target (obligatorio): `idf.py set-target` (esp32s3, esp32c3, esp32c6...).
 *   arduino: true en el lenguaje "arduino" (agrega el componente arduino-esp32).
 */
export const espIdf: Toolchain = {
  nombre: 'esp-idf',
  descripcion: 'ESP-IDF 5.5 en Docker (C, C++ y Arduino como componente de ESP-IDF); salida: flash mergeado para esp-emu.',
  disponible: true,
  lenguajes: ['idf-c', 'idf-cpp', 'arduino'],

  validarOpciones(_l, opciones) {
    return texto(opciones, 'target') ? [] : ['options.target: falta el target de ESP-IDF (esp32s3, esp32c3...)'];
  },

  plantilla(lenguaje, placa, opciones) {
    const target = texto(opciones, 'target') ?? placa.desc.chip;
    const { entrada: b, salida: l } = pinesDemo(placa.desc);
    const comunes = { 'CMakeLists.txt': cmakeRaiz(), 'sdkconfig.defaults': idfSdkconfigDefaultsPara(target) };
    switch (lenguaje) {
      case 'idf-c':
        return { ...comunes, 'main/main.c': idfCMainCPara(b, l), 'main/CMakeLists.txt': 'idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")\n' };
      case 'idf-cpp':
        return { ...comunes, 'main/main.cpp': idfCMainCppPara(b, l), 'main/CMakeLists.txt': 'idf_component_register(SRCS "main.cpp" INCLUDE_DIRS ".")\n' };
      default:
        return {
          ...comunes,
          'sketch.cpp': arduinoSketchPara(b, l),
          'main/main.cpp': '#include "../../sketch.cpp"\n',
          'main/CMakeLists.txt': 'idf_component_register(SRCS "main.cpp" INCLUDE_DIRS ".")\n',
          'main/idf_component.yml': arduinoIdfComponentYml,
        };
    }
  },

  async build(ctx: ContextoBuild): Promise<BuildResult> {
    const { project, projectDir, buildDir: outDir, cb, started } = ctx;
    const target = texto(ctx.opciones, 'target');
    if (!target) return fallo(started, `${ctx.placa.nombre}: falta options.target para ESP-IDF`);
    await fs.mkdir(outDir, { recursive: true });

    // sdkconfig.defaults.sim (8.6), con el target de la placa.
    await fs.writeFile(path.join(outDir, 'sdkconfig.defaults.sim'), idfSdkconfigDefaultsSimPara(target), 'utf8');
    // sim_config.h con el wifi de la simulación
    await fs.writeFile(
      path.join(outDir, 'sim_config.h'),
      `#pragma once\n#define SIM_WIFI_SSID "${project.sim.wifiSsid}"\n#define SIM_WIFI_PASSWORD "${project.sim.wifiPassword}"\n`,
      'utf8',
    );
    // El puente para ESP-IDF todavía no existe (fase 5): se avisa.
    cb.onNotice?.(
      'Aviso: el puente sim_bridge todavía es solo un componente ESPHome; en C/C++ las entradas no llegan al código del usuario (14.2b pendiente).',
    );

    const args = [
      'run', '--rm',
      '--name', `emu-build-${path.basename(outDir)}`,
      '-u', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '-e', 'HOME=/tmp',
      '-v', `${projectDir}:/project`,
      '-v', `${outDir}:/build`,
      // El proyecto ESP-IDF (CMakeLists.txt raíz) es la carpeta del proyecto.
      '-w', '/project',
      IDF_IMAGE,
      'idf.py',
      '-B', '/build',
      '-D', 'SDKCONFIG=/build/sdkconfig',
      '-D', 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;/build/sdkconfig.defaults.sim',
      'set-target', target,
      'build',
      'merge-bin', '-o', '/build/merged_flash.bin',
    ];
    cb.onLine(`$ docker ${args.join(' ')}`);
    const lines: string[] = [];
    const res = await run('docker', args, (line) => {
      lines.push(line);
      cb.onLine(line);
    }, { timeoutMs: ctx.timeoutMs, onChild: ctx.registrarProceso });
    ctx.terminoProceso();
    if (res.code !== 0) {
      const errors = extractBuildErrors(lines);
      return {
        ok: false,
        durationMs: Date.now() - started,
        errors: errors.length > 0 ? errors : [{ line: null, file: null, message: `La compilación terminó con código ${res.code}.` }],
        lineMap: null,
        warnings: [],
        artifacts: null,
      };
    }
    const firmware = path.join(outDir, 'merged_flash.bin');
    if (!(await exists(firmware))) return fallo(started, `No apareció ${firmware}.`);
    const elf = path.join(outDir, `${project.name}.elf`);
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
