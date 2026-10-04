import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearManifiestoMicroPython, esFuenteMicroPython, leerFuentesMicroPython } from './micropythonSources.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-mp-sources-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const write = async (relative: string, content: string) => {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
};

describe('manifiesto de módulos MicroPython', () => {
  it('conserva helpers, paquetes e imports sin concatenar', () => {
    const files = [
      { path: 'main.py', content: 'from helpers import value\nfrom lib.sensor import read\nprint(value + read())\n' },
      { path: 'helpers.py', content: 'value = 20\n' },
      { path: 'lib/__init__.py', content: '' },
      { path: 'lib/sensor.py', content: 'def read():\n    return 22\n' },
    ];
    const manifest = crearManifiestoMicroPython(files);
    expect(manifest.files).toHaveLength(4);
    for (const file of files) expect(manifest.files).toContainEqual(file);
    expect(manifest.totalBytes).toBe(files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0));
  });

  it.each(['boards/board2/main.py', '.venv/lib.py', 'lib/.secret.py', '__pycache__/x.py', 'simbridge.py', 'boot.py', '../escape.py', '/absolute.py', 'lib\\x.py', 'main.cpp'])('excluye ruta privada/generada/noPython: %s', (file) => {
    expect(esFuenteMicroPython(file)).toBe(false);
    expect(crearManifiestoMicroPython([{ path: 'main.py', content: '' }, { path: file, content: 'private' }]).files).toEqual([{ path: 'main.py', content: '' }]);
  });

  it('permite módulos homónimos de boot dentro de un paquete', () => {
    expect(esFuenteMicroPython('pkg/boot.py')).toBe(true);
    expect(esFuenteMicroPython('pkg/simbridge.py')).toBe(true);
  });

  it('exige main.py raíz, detecta duplicados y limita tamaño por bytes UTF8', () => {
    expect(() => crearManifiestoMicroPython([{ path: 'lib/main.py', content: '' }])).toThrow('Falta main.py');
    expect(() => crearManifiestoMicroPython([{ path: 'main.py', content: '' }, { path: 'main.py', content: '' }])).toThrow('duplicado');
    expect(() => crearManifiestoMicroPython([{ path: 'main.py', content: 'ñ'.repeat(524289) }])).toThrow('1 MiB');
  });

  it('lee un árbol recursivo de una placa sin incluir otras placas ni código generado', async () => {
    await write('main.py', 'from lib.helper import value\nprint(value)');
    await write('lib/__init__.py', '');
    await write('lib/helper.py', 'value=42');
    await write('boot.py', 'generated');
    await write('simbridge.py', 'generated');
    await write('boards/board2/main.py', 'secondary');
    await write('boards/board2/helper.py', 'secondary helper');
    await write('.hidden/other.py', 'hidden');
    const manifest = await leerFuentesMicroPython(root);
    expect(manifest.files.map(file => file.path)).toEqual(['lib/__init__.py', 'lib/helper.py', 'main.py']);
    const secondary = await leerFuentesMicroPython(path.join(root, 'boards', 'board2'));
    expect(secondary.files.map(file => file.path)).toEqual(['helper.py', 'main.py']);
    expect(secondary.files.find(file => file.path === 'main.py')?.content).toBe('secondary');
  });

  it('falla si falta main.py, incluso si otra placa lo tiene', async () => {
    await write('boards/board2/main.py', 'other board');
    await expect(leerFuentesMicroPython(root)).rejects.toThrow('Falta main.py');
  });

  it('falla si un archivo desaparece durante la lectura, sin convertirlo en código vacío', async () => {
    await write('main.py', 'from helper import value');
    await write('helper.py', 'value=42');
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('ENOENT'));
    await expect(leerFuentesMicroPython(root)).rejects.toThrow('No se pudo leer');
  });

  it('rechaza un ancestro enlazado en la carpeta seleccionada', async () => {
    await write('real/main.py', '');
    await fs.symlink(path.join(root, 'real'), path.join(root, 'linked'));
    await fs.mkdir(path.join(root, 'real', 'sub'));
    await fs.writeFile(path.join(root, 'real', 'sub', 'main.py'), '');
    await expect(leerFuentesMicroPython(path.join(root, 'linked', 'sub'))).rejects.toThrow('enlaces simbólicos');
  });

  it('rechaza archivos y carpetas enlazadas, pero ignora boards privados', async () => {
    await write('main.py', '');
    await fs.symlink(path.join(root, 'main.py'), path.join(root, 'helper.py'));
    await expect(leerFuentesMicroPython(root)).rejects.toThrow('enlaces simbólicos');
    await fs.rm(path.join(root, 'helper.py'));
    await fs.symlink(root, path.join(root, 'boards'));
    expect((await leerFuentesMicroPython(root)).files.map(file => file.path)).toEqual(['main.py']);
    await fs.symlink(root, path.join(root, 'lib'));
    await expect(leerFuentesMicroPython(root)).rejects.toThrow('enlaces simbólicos');
  });
});
