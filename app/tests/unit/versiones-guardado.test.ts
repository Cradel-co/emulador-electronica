import { expect, it, vi } from 'vitest';
import { ErrorRevision, VersionesGuardado } from '../../web/versiones-guardado.js';

it('serializa capturando la base al comenzar cada envío y recupera errores de red', async () => {
  const v = new VersionesGuardado(); v.cargar('archivo', 'uno');
  const enviar = vi.fn(async (revision: string) => ({ revision: revision === 'uno' ? 'dos' : 'tres' }));
  await Promise.all([v.guardar('archivo', enviar), v.guardar('archivo', enviar)]);
  expect(enviar.mock.calls.map(c => c[0])).toEqual(['uno', 'dos']);
  await expect(v.guardar('archivo', async () => { throw new Error('sin red'); })).rejects.toThrow('sin red');
  await v.guardar('archivo', enviar); expect(v.revision('archivo')).toBe('tres');
});
it('un conflicto conserva la base y bloquea autosaves; la resolución usa una revisión explícita', async () => {
  const v = new VersionesGuardado(); v.cargar('circuito', 'vieja');
  await expect(v.guardar('circuito', async () => { throw new ErrorRevision('conflicto'); })).rejects.toThrow('conflicto');
  const enviar = vi.fn(async () => ({ revision: 'nueva' }));
  await expect(v.guardar('circuito', enviar)).rejects.toThrow('Resolvé');
  expect(enviar).not.toHaveBeenCalled(); expect(v.revision('circuito')).toBe('vieja');
  await v.guardar('circuito', enviar, 'remota');
  expect(enviar).toHaveBeenCalledWith('remota'); expect(v.bloqueado('circuito')).toBe(false);
});
it('un archivo y otro proyecto mantienen revisiones independientes; sin carga no escribe', async () => {
  const v = new VersionesGuardado(); v.cargar('uno/archivo', 'a'); v.cargar('dos/archivo', 'b');
  v.bloquear('uno/archivo');
  await v.guardar('dos/archivo', async revision => ({ revision: revision + '1' }));
  expect(v.revision('uno/archivo')).toBe('a'); expect(v.revision('dos/archivo')).toBe('b1');
  const enviar = vi.fn(); await expect(v.guardar('sin cargar', enviar)).rejects.toThrow('Falta la revisión');
  expect(enviar).not.toHaveBeenCalled();
});
