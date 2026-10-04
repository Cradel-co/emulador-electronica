import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardDescriptorSchema, defaultProject } from '@emu/shared';
import type { ContextoBuild } from './tipos.js';

const fixture = vi.hoisted(() => ({ firmwareRoot: '', run: vi.fn() }));
vi.mock('../paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../paths.js')>();
  return { ...original, PATHS: { ...original.PATHS, get firmware() { return fixture.firmwareRoot; } } };
});
vi.mock('../dockerRunner.js', () => ({ run: fixture.run }));

import { micropython } from './micropython.js';

let root: string;
let sourceDir: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-mp-toolchain-'));
  sourceDir = path.join(root, 'source');
  fixture.firmwareRoot = path.join(root, 'firmware');
  fixture.run.mockReset();
  fixture.run.mockImplementation(() => { throw new Error('La prueba no debe descargar firmware.'); });
  await fs.mkdir(sourceDir);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function context(): ContextoBuild {
  return {
    project: defaultProject('imports', 'micropython'),
    projectDir: sourceDir,
    buildDir: path.join(root, 'build'),
    placa: {
      id: 'esp32-s3-devkitc-1', nombre: 'ESP32-S3',
      desc: BoardDescriptorSchema.parse({
        chip: 'esp32s3', backend: { engine: 'esp-emu' }, logicVoltage: 3.3, maxPinCurrentMa: 40,
        pins: {}, io: { mode: 'bridge-uart', uart: 1, tx: 17, rx: 18 },
        languages: { micropython: { toolchain: 'micropython' } },
      }),
    },
    lenguaje: 'micropython',
    opciones: { firmware: 'cached.bin', gpioOutRegs: [0x60004004] },
    cb: { onLine: () => {} },
    timeoutMs: 5000,
    started: Date.now(),
    registrarProceso: () => {}, terminoProceso: () => {},
  };
}

const source = async (relative: string, content: string) => {
  const full = path.join(sourceDir, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
};

describe('MicroPython toolchain: manifiesto de archivos', () => {
  it('incluye helpers y paquetes del proyecto en delProyecto usando firmware ya disponible', async () => {
    await source('main.py', 'from helper import value\nfrom pkg.sensor import read\nprint(value + read())');
    await source('helper.py', 'value = 20');
    await source('pkg/__init__.py', '');
    await source('pkg/sensor.py', 'def read():\n    return 22');
    await source('boards/board2/main.py', 'private board');
    await source('.cache/old.py', 'generated cache');
    await source('boot.py', 'user generated override');
    await source('simbridge.py', 'user generated override');
    await fs.mkdir(path.join(fixture.firmwareRoot, 'micropython'), { recursive: true });
    const cached = path.join(fixture.firmwareRoot, 'micropython', 'cached.bin');
    await fs.writeFile(cached, 'firmware fixture');

    const result = await micropython.build(context());
    expect(result.ok).toBe(true);
    expect(result.artifacts?.firmware).toBe(cached);
    expect(result.artifacts?.repl?.delProyecto).toEqual(['helper.py', 'main.py', 'pkg/__init__.py', 'pkg/sensor.py']);
    expect(result.artifacts?.repl?.generados.map(file => file.path)).toEqual(['simbridge.py', 'boot.py']);
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('falla por main.py faltante antes de crear carpeta de firmware o iniciar descarga', async () => {
    await source('helper.py', 'value = 20');
    await source('boards/board2/main.py', 'private board main');
    const result = await micropython.build(context());
    expect(result.ok).toBe(false);
    expect(result.artifacts).toBeNull();
    expect(result.errors).toEqual([{ line: null, file: 'main.py', message: 'Falta main.py en la placa seleccionada.' }]);
    expect(fixture.run).not.toHaveBeenCalled();
    await expect(fs.stat(fixture.firmwareRoot)).rejects.toThrow();
  });
});
