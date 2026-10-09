import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultProject } from '@emu/shared';
import { ProjectStore } from './projectStore.js';

let root: string, store: ProjectStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-atomico-'));
  store = new ProjectStore(root);
  const p = defaultProject('uno', 'micropython'); p.sim.autoReload = false;
  await store.save(p);
  await store.writeFile('uno', 'main.py', 'micropython', 'anterior');
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it.each(['proyecto', 'codigo'])('un fallo de escritura conserva %s completo y limpia temporales', async tipo => {
  const destino = path.join(root, 'uno', tipo === 'proyecto' ? 'project.json' : 'main.py');
  const anterior = await fs.readFile(destino, 'utf8'), escribir = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (file, _data, opciones) => {
    await escribir(file, 'incompleto', opciones); throw new Error('disco lleno');
  });
  await expect(tipo === 'proyecto' ? store.save(defaultProject('uno', 'micropython'))
    : store.writeFile('uno', 'main.py', 'micropython', 'nuevo')).rejects.toThrow('disco lleno');
  expect(await fs.readFile(destino, 'utf8')).toBe(anterior);
  expect((await fs.readdir(path.dirname(destino))).filter(n => n.startsWith('.emu-'))).toEqual([]);
});

it('un fallo antes del rename conserva el original y permite reintentar', async () => {
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename falló'));
  await expect(store.writeFile('uno', 'main.py', 'micropython', 'nuevo')).rejects.toThrow('rename falló');
  expect(await store.readFile('uno', 'main.py', 'micropython')).toBe('anterior');
  expect((await fs.readdir(path.join(root, 'uno'))).filter(n => n.startsWith('.emu-'))).toEqual([]);
  await store.writeFile('uno', 'main.py', 'micropython', 'reintento');
  expect(await store.readFile('uno', 'main.py', 'micropython')).toBe('reintento');
});

// Sin actualizar(), la base reproduce el read-modify-save de sus consumidores.
const actualizar = async (s: ProjectStore, cambio: (p: Awaited<ReturnType<ProjectStore['read']>>) => Promise<Awaited<ReturnType<ProjectStore['read']>>>) => {
  if ('actualizar' in s && typeof s.actualizar === 'function') return s.actualizar('uno', cambio);
  return s.save(await cambio(await s.read('uno')));
};
it('serializa desde la lectura inicial, incluso entre stores con la misma raíz', async () => {
  let liberar: () => void = () => {}; const pausa = new Promise<void>(r => { liberar = r; });
  let inicio: () => void = () => {}; const comenzado = new Promise<void>(r => { inicio = r; });
  const uno = actualizar(store, async p => { inicio(); await pausa; return { ...p, wires: [{ from: 'board.GPIO7', to: 'board.GND' }] }; });
  await comenzado;
  const dos = actualizar(new ProjectStore(root), async p => ({ ...p, sim: { ...p.sim, autoReload: true } }));
  // La base termina el segundo cambio y luego el primero lo sobrescribe.
  await new Promise(r => setTimeout(r, 30)); liberar(); await Promise.all([uno, dos]);
  expect((await store.read('uno')).sim.autoReload).toBe(true);
  expect((await store.read('uno')).wires).toHaveLength(1);
});

it('una actualización rechazada no bloquea la siguiente', async () => {
  await expect(actualizar(store, async () => { throw new Error('cambio inválido'); })).rejects.toThrow('cambio inválido');
  await actualizar(store, async p => ({ ...p, sim: { ...p.sim, autoReload: true } }));
  expect((await store.read('uno')).sim.autoReload).toBe(true);
});

it('otro proyecto y las lecturas siguen disponibles durante una mutación detenida', async () => {
  await store.save(defaultProject('dos', 'micropython'));
  let liberar: () => void = () => {}; const pausa = new Promise<void>(r => { liberar = r; });
  let inicio: () => void = () => {}; const comenzado = new Promise<void>(r => { inicio = r; });
  const pendiente = store.actualizar('uno', async p => { inicio(); await pausa; return p; });
  await comenzado;
  try {
    await store.actualizar('dos', p => ({ ...p, wires: [{ from: 'board.GPIO7', to: 'board.GND' }] }));
    expect((await store.read('dos')).wires).toHaveLength(1);
    expect((await store.read('uno')).name).toBe('uno');
  } finally { liberar(); await pendiente; }
});

it('dos creaciones del mismo proyecto tienen un único ganador', async () => {
  const resultados = await Promise.allSettled([store.crearSinPlaca('nuevo'), new ProjectStore(root).crearSinPlaca('nuevo')]);
  expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const error = resultados.find(r => r.status === 'rejected');
  expect(error?.status === 'rejected' ? error.reason.statusCode : null).toBe(409);
});

it('una creación fallida no deja publicado código parcial y conserva creación exclusiva', async () => {
  const escribir = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (file, _data, opciones) => {
    await escribir(file, 'incompleto', opciones); throw new Error('disco lleno');
  });
  await expect(store.createFile('uno', 'nuevo.py', 'micropython', 'completo')).rejects.toThrow('disco lleno');
  await expect(fs.stat(path.join(root, 'uno', 'nuevo.py'))).rejects.toMatchObject({ code: 'ENOENT' });
  await store.createFile('uno', 'nuevo.py', 'micropython', 'completo');
  await expect(store.createFile('uno', 'nuevo.py', 'micropython', 'otro')).rejects.toMatchObject({ statusCode: 409 });
  expect(await store.readFile('uno', 'nuevo.py', 'micropython')).toBe('completo');
});

it('conserva los permisos del archivo reemplazado', async () => {
  const destino = path.join(root, 'uno', 'main.py'); await fs.chmod(destino, 0o600);
  await store.writeFile('uno', 'main.py', 'micropython', 'nuevo');
  expect((await fs.stat(destino)).mode & 0o777).toBe(0o600);
});
