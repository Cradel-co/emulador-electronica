import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { run } from '../dockerRunner.js';
import { exists, type BuildResult } from '../buildService.js';
import { buildSimYaml, extractBuildErrors, rmtLoopbackPairs, type PlacaEsphome } from '../yamlSim.js';
import { esphomeMainYamlPara } from '../templates/esphome.js';
import { fallo, pinesDemo, texto, type ContextoBuild, type PlacaBuild, type Toolchain } from './tipos.js';

/** Versión fijada (sección 16): cambiarla a propósito, nunca con latest. */
export const ESPHOME_IMAGE = 'ghcr.io/esphome/esphome:2026.9.0';

/**
 * Lo que yamlSim necesita de la placa, sacado del descriptor.
 * Opciones (`board.languages.esphome.options`):
 *   board (obligatorio): `esp32.board` de ESPHome.
 *   variant: `esp32.variant` (esp32s3, esp32c3...). Por defecto, el `chip` de la placa.
 *   unsupportedInputPins: pines que esp-emu no acepta como entrada simulada.
 */
export function placaEsphome(placa: PlacaBuild, opciones: Record<string, unknown>): PlacaEsphome {
  const desc = placa.desc;
  if (desc.io.mode !== 'bridge-uart') throw new Error(`${placa.nombre}: ESPHome necesita io.mode "bridge-uart"`);
  const extra = Array.isArray(opciones.unsupportedInputPins) ? (opciones.unsupportedInputPins as unknown[]).map(Number) : [];
  return {
    nombre: placa.nombre,
    chip: desc.chipName ?? desc.chip,
    board: texto(opciones, 'board') ?? placa.id,
    variant: texto(opciones, 'variant') ?? desc.chip,
    uartTx: desc.io.tx,
    uartRx: desc.io.rx,
    sinEntrada: new Set([...Object.keys(desc.reservedPins).map(Number), ...extra]),
    rf: desc.features.includes('rf433'),
  };
}

export const esphome: Toolchain = {
  nombre: 'esphome',
  descripcion: 'ESPHome (YAML) en Docker, con el puente sim_bridge inyectado solo en la simulación.',
  disponible: true,
  lenguajes: ['esphome'],

  validarOpciones(_l, opciones, placa) {
    const errores: string[] = [];
    if (!texto(opciones, 'board')) errores.push('languages.esphome.options.board: falta el `esp32.board` de ESPHome');
    if (placa.desc.io.mode !== 'bridge-uart') errores.push('languages.esphome: necesita io.mode "bridge-uart" (el puente sim_bridge)');
    return errores;
  },

  plantilla(_l, placa, opciones) {
    const { entrada, salida } = pinesDemo(placa.desc);
    return {
      'main.yaml': esphomeMainYamlPara(texto(opciones, 'board') ?? placa.id, entrada, salida),
      'secrets.yaml': '# Credenciales de la simulación: las usa solo el emulador.\nwifi_ssid: sim-wifi\nwifi_password: sim-password\n',
    };
  },

  async build(ctx: ContextoBuild): Promise<BuildResult> {
    const { project, projectDir, buildDir: outDir, cb, timeoutMs: timeout, started } = ctx;
    const userYaml = await fs.readFile(path.join(projectDir, 'main.yaml'), 'utf8').catch(() => null);
    if (userYaml === null) return fallo(started, 'El proyecto no tiene main.yaml');

    // 1-5: YAML de simulación + mapa de líneas + secrets
    let sim;
    try {
      sim = buildSimYaml(project, userYaml, { placa: placaEsphome(ctx.placa, ctx.opciones) });
    } catch (err) {
      return fallo(started, (err as Error).message);
    }
    const { text: simYaml, lineMap, warnings } = sim;
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'main.sim.yaml'), simYaml, 'utf8');
    await fs.copyFile(path.join(projectDir, 'secrets.yaml'), path.join(outDir, 'secrets.yaml')).catch(() => undefined);
    for (const w of warnings) cb.onNotice?.(w);

    // 6: Docker
    const args = [
      'run', '--rm',
      '--name', `emu-build-${path.basename(outDir)}`,
      '-u', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '-e', 'HOME=/tmp',
      '-v', `${outDir}:/config`,
      '-v', `${PATHS.firmwareComponents}:/components:ro`,
      '-v', `${PATHS.cache}:/cache`,
      ESPHOME_IMAGE, 'compile', 'main.sim.yaml',
    ];
    cb.onLine(`$ docker ${args.join(' ')}`);
    const lines: string[] = [];
    const res = await run('docker', args, (line) => {
      lines.push(line);
      cb.onLine(line);
    }, { timeoutMs: timeout, onChild: ctx.registrarProceso });
    ctx.terminoProceso();

    const errors = extractBuildErrors(lines);
    if (res.timedOut) {
      return { ...fallo(started, `Se pasó el tiempo de compilación (${Math.round(timeout / 60_000)} min) y se canceló.`), lineMap, warnings };
    }
    if (res.code !== 0) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        errors: errors.length > 0 ? errors : [{ line: null, file: null, message: `La compilación terminó con código ${res.code}.` }],
        lineMap, warnings, artifacts: null,
      };
    }

    // 7: artefactos (ESPHome usa el `esphome.name` del YAML, que en la plantilla es el nombre del proyecto)
    const base = path.join(outDir, '.esphome', 'build', project.name, 'build');
    const firmware = path.join(base, 'firmware.factory.bin');
    const elf = path.join(base, 'firmware.elf');
    if (!(await exists(firmware))) {
      return { ...fallo(started, `La compilación terminó bien pero no apareció ${firmware}.`), lineMap, warnings };
    }
    // RF (7.3): pares para --rmt-loopback si la placa lo simula y el YAML usa RF.
    const usaRf = /remote_(receiver|transmitter):/.test(userYaml);
    return {
      ok: true,
      durationMs: Date.now() - started,
      errors: [],
      lineMap,
      warnings,
      artifacts: {
        firmware,
        elf: (await exists(elf)) ? elf : null,
        usesWebServer: /^web_server:/m.test(simYaml),
        usesApi: /^api:/m.test(simYaml),
        needsRepl: false,
        ...(usaRf && ctx.placa.desc.features.includes('rf433') ? { rmtLoopback: rmtLoopbackPairs() } : {}),
      },
    };
  },
};
