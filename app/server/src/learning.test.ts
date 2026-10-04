import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectSchema } from '@emu/shared';
import { ProjectStore } from './projectStore.js';
import { PATHS } from './paths.js';
import { loadCatalog } from './catalog.js';
import { analizarCircuito } from './sim/analisis.js';

let root: string;
let store: ProjectStore;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-learning-')); store = new ProjectStore(root); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('biblioteca _learning', () => {
  it('lista ejemplos distribuidos incluso con una carpeta personal distinta y copia sin modificar el original', async () => {
    expect((await store.listLearning()).map(e => e.id).sort()).toEqual(['divisor-cargado', 'ohm', 'paralelo', 'serie']);
    expect(await store.listTemplates()).toEqual([]);
    const original = await fs.readFile(path.join(PATHS.learning, 'ohm', 'project.json'), 'utf8');
    const copia = await store.createFromLearning('mi-practica', 'ohm');
    expect(copia.name).toBe('mi-practica');
    expect(copia.board).toBeNull();
    const resistor = copia.modules.find(modulo => modulo.id === 'r1');
    if (!resistor) throw new Error('Falta R1 en el ejemplo');
    resistor.props.ohms = 2000;
    await store.save(copia);
    expect(await fs.readFile(path.join(PATHS.learning, 'ohm', 'project.json'), 'utf8')).toBe(original);
    expect((await store.list()).map(p => p.name)).toEqual(['mi-practica']);
    await expect(store.createFromLearning('mi-practica', 'ohm')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rechaza IDs inválidos, ejemplos ausentes y enlaces sin dejar una copia parcial', async () => {
    await expect(store.createFromLearning('copia', '../ohm')).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.createFromLearning('copia', 'ausente')).rejects.toMatchObject({ statusCode: 404 });
    const library = path.join(root, '_learning');
    await fs.mkdir(library);
    await fs.symlink(path.join(PATHS.learning, 'ohm'), path.join(library, 'enlazado'));
    await expect(store.createFromLearning('copia', 'enlazado', library)).rejects.toMatchObject({ statusCode: 403 });
    await fs.cp(path.join(PATHS.learning, 'ohm'), path.join(library, 'roto'), { recursive: true });
    await fs.symlink(path.join(PATHS.learning, 'ohm', 'README.md'), path.join(library, 'roto', 'escape.md'));
    await expect(store.createFromLearning('copia', 'roto', library)).rejects.toMatchObject({ statusCode: 403 });
    expect(await store.exists('copia')).toBe(false);
  });

  it('los ejemplos resueltos por el motor coinciden con las predicciones de las lecciones', async () => {
    const catalogo = await loadCatalog();
    const casos = [
      { id: 'ohm', corrientes: { r1: .005 } },
      { id: 'serie', corrientes: { r1: .0025, r2: .0025 } },
      { id: 'paralelo', corrientes: { r1: .005, r2: .0025 } },
      { id: 'divisor-cargado', corrientes: { r1: 5 / 1500, r2: 5 / 3000, r3: 5 / 3000 } },
    ];
    for (const caso of casos) {
      const proyecto = ProjectSchema.parse(JSON.parse(await fs.readFile(path.join(PATHS.learning, caso.id, 'project.json'), 'utf8')));
      const resultado = await analizarCircuito(proyecto, type => catalogo.find(modulo => modulo.type === type));
      const resistores = resultado.elementos.filter(elemento => elemento.local === 'r');
      const potenciaAbsorbida = resistores.reduce((suma, elemento) => suma + elemento.p, 0);
      expect(potenciaAbsorbida, `${caso.id}: balance de potencia`).toBeCloseTo(resultado.fuentes[0]?.potenciaW ?? 0, 6);
      for (const [id, corriente] of Object.entries(caso.corrientes)) expect(Math.abs(resultado.elementos.find(elemento => elemento.dueno === id && elemento.local === 'r')?.i ?? 0), `${caso.id}/${id}`).toBeCloseTo(corriente, 5);
    }
  }, 60_000);
});
