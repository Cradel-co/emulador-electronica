import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardDescriptorSchema, defaultProject } from '@emu/shared';
import type { ContextoBuild } from './tipos.js';

const fixture = vi.hoisted(() => ({ firmwareRoot: '', run: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock('../paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../paths.js')>();
  return { ...original, PATHS: { ...original.PATHS, get firmware() { return fixture.firmwareRoot; } } };
});
vi.mock('../dockerRunner.js', () => ({ run: fixture.run }));

import { ensureMicropythonFirmware, micropython } from './micropython.js';

let root: string;
let sourceDir: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-mp-toolchain-'));
  sourceDir = path.join(root, 'source');
  fixture.firmwareRoot = path.join(root, 'firmware');
  fixture.run.mockReset();
  fixture.run.mockImplementation(() => { throw new Error('La prueba no debe descargar firmware.'); });
  fixture.fetch.mockReset();
  fixture.fetch.mockImplementation(async () => { throw new Error('La prueba no debe acceder a la red.'); });
  vi.stubGlobal('fetch', fixture.fetch);
  await fs.mkdir(sourceDir);
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });

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
    await fs.writeFile(cached + '.sha256', createHash('sha256').update('firmware fixture').digest('hex') + '  cached.bin\n');

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


it('rechaza firmware cacheado que no coincide con la huella conservada', async () => {
  const target = path.join(fixture.firmwareRoot, 'micropython', 'corrupto.bin');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'corrupto');
  await fs.writeFile(target + '.sha256', '0'.repeat(64) + '  corrupto.bin\n');
  await expect(ensureMicropythonFirmware({ onLine: () => {} }, 'corrupto.bin')).rejects.toThrow('integridad');
  expect(await fs.readFile(target, 'utf8')).toBe('corrupto');
});
it('rechaza caché histórica sin huella en lugar de acreditar verificación', async () => {
  const target = path.join(fixture.firmwareRoot, 'micropython', 'historico.bin');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'historico');
  await expect(ensureMicropythonFirmware({ onLine: () => {} }, 'historico.bin')).rejects.toThrow('sin huella');
  await expect(fs.stat(target + '.sha256')).rejects.toThrow();
});

it('comparte una descarga concurrente del mismo firmware y verifica la caché siguiente', async () => {
  let liberar: () => void = () => {};
  const espera = new Promise<void>(resolve => { liberar = resolve; });
  fixture.fetch.mockImplementationOnce(async () => { await espera; return new Response('firmware nuevo'); });
  const a = ensureMicropythonFirmware({ onLine: () => {} }, 'nuevo.bin');
  const b = ensureMicropythonFirmware({ onLine: () => {} }, 'nuevo.bin');
  expect(a).toBe(b); liberar();
  expect(await a).toBe(await b);
  await ensureMicropythonFirmware({ onLine: () => {} }, 'nuevo.bin');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});
it('una descarga fallida libera la cola para reintentar sin publicar un binario parcial', async () => {
  fixture.fetch.mockRejectedValueOnce(new Error('sin red')).mockResolvedValueOnce(new Response('recuperado'));
  await expect(ensureMicropythonFirmware({ onLine: () => {} }, 'retry.bin')).rejects.toThrow('sin red');
  await expect(fs.stat(path.join(fixture.firmwareRoot, 'micropython', 'retry.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  await ensureMicropythonFirmware({ onLine: () => {} }, 'retry.bin');
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});
