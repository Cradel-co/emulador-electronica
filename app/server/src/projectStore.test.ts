import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultProject } from '@emu/shared';
import { ProjectStore } from './projectStore.js';

let root: string;
let store: ProjectStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-store-'));
  store = new ProjectStore(root);
  await store.save(defaultProject('multi', 'micropython'));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('archivos propios de cada placa', () => {
  it('la placa histórica conserva raíz y la adicional usa carpeta independiente', () => {
    expect(store.projectCodeDir('multi')).toBe(path.join(root, 'multi'));
    expect(store.projectCodeDir('multi', 'board2')).toBe(path.join(root, 'multi', 'boards', 'board2'));
  });

  it('escribe y lee el mismo nombre en dos placas sin pisarse', async () => {
    await store.writeFile('multi', 'main.py', 'micropython', 'primary');
    await store.writeFile('multi', 'main.py', 'micropython', 'secondary', 'board2');
    expect(await store.readFile('multi', 'main.py', 'micropython')).toBe('primary');
    expect(await store.readFile('multi', 'main.py', 'micropython', 'board2')).toBe('secondary');
    const first = (await store.listFiles('multi', 'micropython')).map((file) => file.path);
    const second = (await store.listFiles('multi', 'micropython', 'board2')).map((file) => file.path);
    expect(first).toContain('main.py');
    expect(first.some((file) => file.startsWith('boards/'))).toBe(false);
    expect(second).toEqual(['main.py']);
  });

  it('conserva código al reinicializar una placa y reemplaza nombres plantilla', async () => {
    await store.escribirSiFalta('multi', 'micropython', { 'main.py': 'original ${name}', 'lib/util.py': 'helper' }, 'board2');
    await store.escribirSiFalta('multi', 'micropython', { 'main.py': 'changed', 'extra.py': 'new' }, 'board2');
    expect(await store.readFile('multi', 'main.py', 'micropython', 'board2')).toBe('original multi');
    expect(await store.readFile('multi', 'extra.py', 'micropython', 'board2')).toBe('new');
    expect(await store.listFiles('multi', null, 'board2')).toEqual([]);
  });

  it('borra un archivo solo en la placa elegida y protege archivos principales', async () => {
    await store.writeFile('multi', 'utils.py', 'micropython', 'one');
    await store.writeFile('multi', 'utils.py', 'micropython', 'two', 'board2');
    await store.deleteFile('multi', 'utils.py', 'micropython', 'board2');
    expect(await store.readFile('multi', 'utils.py', 'micropython')).toBe('one');
    await expect(store.readFile('multi', 'utils.py', 'micropython', 'board2')).rejects.toThrow();
    await expect(store.deleteFile('multi', 'main.py', 'micropython', 'board2')).rejects.toThrow('principal');
  });

  it('bloquea traversal y acceso a archivos de otras placas', () => {
    expect(() => store.projectCodeDir('multi', '../escape')).toThrow('Id de placa');
    expect(() => store.resolveFile('multi', 'boards/board2/main.py', 'micropython')).toThrow('privada');
    expect(() => store.resolveFile('multi', '../../main.py', 'micropython', 'board2')).toThrow();
    expect(() => store.resolveFile('multi', 'project.json', 'micropython', 'board2')).toThrow('compartido');
  });
});

describe('aislamiento de enlaces simbólicos y plantillas', () => {
  it('rechaza leer, escribir o borrar un archivo enlazado', async () => {
    const outside = path.join(root, 'outside.py');
    await fs.writeFile(outside, 'unchanged');
    await fs.symlink(outside, path.join(root, 'multi', 'linked.py'));
    await expect(store.readFile('multi', 'linked.py', 'micropython')).rejects.toThrow('enlaces simbólicos');
    await expect(store.writeFile('multi', 'linked.py', 'micropython', 'changed')).rejects.toThrow('enlaces simbólicos');
    await expect(store.deleteFile('multi', 'linked.py', 'micropython')).rejects.toThrow('enlaces simbólicos');
    expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
    expect((await store.listFiles('multi', 'micropython')).some((file) => file.path === 'linked.py')).toBe(false);
  });

  it('rechaza una carpeta de placa enlazada a otro directorio', async () => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.mkdir(path.join(root, 'multi', 'boards'));
    await fs.symlink(outside, path.join(root, 'multi', 'boards', 'board2'));
    await expect(store.writeFile('multi', 'main.py', 'micropython', 'changed', 'board2')).rejects.toThrow('enlaces simbólicos');
    await expect(store.listFiles('multi', 'micropython', 'board2')).rejects.toThrow('enlaces simbólicos');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('rechaza metadata de proyecto enlazada', async () => {
    const outside = path.join(root, 'outside.json');
    await fs.writeFile(outside, '{}');
    await fs.rm(path.join(root, 'multi', 'project.json'));
    await fs.symlink(outside, path.join(root, 'multi', 'project.json'));
    await expect(store.save(defaultProject('multi', 'micropython'))).rejects.toThrow('enlaces simbólicos');
    await expect(store.read('multi')).rejects.toThrow('enlaces simbólicos');
    expect(await fs.readFile(outside, 'utf8')).toBe('{}');
  });

  it('copia plantillas con placas y archivos propios sin mezclar el código', async () => {
    const template = path.join(store.templatesDir, 'two-boards');
    await fs.mkdir(path.join(template, 'boards', 'board2'), { recursive: true });
    const base = defaultProject('two-boards', 'micropython');
    const boards = [{ id: 'board', board: base.board, language: base.language }, { id: 'board2', board: base.board, language: base.language }];
    await fs.writeFile(path.join(template, 'project.json'), JSON.stringify({ ...base, boards, modules: [...base.modules, { id: 'board2', type: base.board, x: 260, y: 0, props: {} }] }));
    await fs.writeFile(path.join(template, 'main.py'), 'primary');
    await fs.writeFile(path.join(template, 'boards', 'board2', 'main.py'), 'secondary');
    const project = await store.createFromTemplate('copied', 'two-boards');
    expect(project.boards?.map((board) => board.id)).toEqual(['board', 'board2']);
    expect(await store.readFile('copied', 'main.py', 'micropython')).toBe('primary');
    expect(await store.readFile('copied', 'main.py', 'micropython', 'board2')).toBe('secondary');
  });

  it('rechaza enlaces en plantillas antes de crear el proyecto destino', async () => {
    const template = path.join(store.templatesDir, 'unsafe');
    await fs.mkdir(template, { recursive: true });
    await fs.writeFile(path.join(template, 'project.json'), JSON.stringify(defaultProject('unsafe', 'micropython')));
    await fs.symlink(path.join(root, 'multi'), path.join(template, 'lib'));
    await expect(store.createFromTemplate('copied', 'unsafe')).rejects.toThrow('enlaces simbólicos');
    await expect(fs.stat(path.join(root, 'copied'))).rejects.toThrow();
  });
});
