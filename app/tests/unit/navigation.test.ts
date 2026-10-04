import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceNavigation } from '../../web/navigation.js';
import type { WorkspaceRoute } from '../../web/navigation.js';

function setup(initial = '/', apply = async (route: WorkspaceRoute) => route, canLeave = async () => true) {
  const history = createMemoryHistory({ initialEntries: [initial] });
  const load = vi.fn(apply);
  const error = vi.fn();
  const navigation = createWorkspaceNavigation({ history, apply: load, canLeave, onError: error });
  return { history, load, error, navigation };
}

describe('adaptador de TanStack Router', () => {
  it('migra un enlace anterior y completa la selección resuelta sin aplicar dos veces', async () => {
    const { navigation, load, history } = setup('casa', async route => ({ ...route, board: 'esp32', file: 'main.py' }));
    await navigation.start();
    expect(navigation.current).toEqual({ project: 'casa', board: 'esp32', file: 'main.py' });
    expect(history.location.href).toBe('/projects/casa?board=esp32&file=main.py');
    expect(load).toHaveBeenCalledTimes(1);
    navigation.destroy();
  });

  it('navega con historial, restaura Atrás/Adelante y actualiza sin recrear el espacio de trabajo', async () => {
    const { navigation, load, history } = setup();
    await navigation.start();
    await navigation.navigate({ project: 'casa', board: 'uno', file: 'lib/sensor.py' });
    await navigation.navigate({ project: 'casa', board: 'dos', file: 'main.py' });
    expect(history.length).toBe(3);
    history.back();
    await vi.waitFor(() => expect(navigation.current).toEqual({ project: 'casa', board: 'uno', file: 'lib/sensor.py' }));
    history.forward();
    await vi.waitFor(() => expect(navigation.current.board).toBe('dos'));
    const calls = load.mock.calls.length;
    navigation.replace({ project: 'casa', board: 'dos', file: 'helper.py' });
    expect(navigation.current.file).toBe('helper.py');
    expect(history.length).toBe(3);
    expect(load).toHaveBeenCalledTimes(calls);
    navigation.destroy();
  });

  it('no cambia URL ni aplica una selección cuando no se pudo guardar', async () => {
    const { navigation, load, history } = setup('/projects/casa', undefined, async () => false);
    await navigation.start();
    await navigation.navigate({ project: 'otra' });
    expect(history.location.href).toBe('/projects/casa');
    expect(navigation.current.project).toBe('casa');
    expect(load).toHaveBeenCalledTimes(1);
    navigation.destroy();
  });

  it('vuelve a Inicio e informa un hash dañado sin URIError', async () => {
    const { navigation, error, history } = setup('/projects/%ZZ');
    await navigation.start();
    expect(navigation.current).toEqual({ project: null });
    expect(history.location.href).toBe('/');
    expect(error).toHaveBeenCalledTimes(1);
    navigation.destroy();
  });

  it('corrige un proyecto inexistente con la ruta resuelta por la aplicación', async () => {
    const { navigation, history } = setup('/projects/borrado', async () => ({ project: null }));
    await navigation.start();
    expect(history.location.href).toBe('/');
    expect(navigation.current.project).toBeNull();
    navigation.destroy();
  });

  it('conserva la selección anterior e informa una carga fallida', async () => {
    const { navigation, history, error } = setup('/projects/casa', async route => {
      if (route.project === 'fallo') throw new Error('Servidor desconectado');
      return route;
    });
    await navigation.start();
    await navigation.navigate({ project: 'fallo' });
    expect(navigation.current.project).toBe('casa');
    expect(history.location.href).toBe('/projects/casa');
    expect(error).toHaveBeenCalledTimes(1);
    navigation.destroy();
  });

  it('la última navegación gana mientras se espera el guardado', async () => {
    let finish: (value: boolean) => void = () => {};
    let first = true;
    const { navigation, load } = setup('/', undefined, async () => {
      if (!first) return true;
      first = false;
      return new Promise<boolean>(resolve => { finish = resolve; });
    });
    await navigation.start();
    const previous = navigation.navigate({ project: 'anterior' });
    await Promise.resolve();
    await Promise.resolve();
    const latest = navigation.navigate({ project: 'ultima' });
    finish(true);
    await Promise.all([previous, latest]);
    expect(navigation.current.project).toBe('ultima');
    expect(load.mock.calls.some(([route]) => route.project === 'anterior')).toBe(false);
    navigation.destroy();
  });

  it('serializa cargas y termina mostrando la última ruta pedida', async () => {
    let release: () => void = () => {};
    const loading = new Promise<void>(resolve => { release = resolve; });
    const { navigation, load } = setup('/', async route => {
      if (route.project === 'lenta') await loading;
      return route;
    });
    await navigation.start();
    const first = navigation.navigate({ project: 'lenta' });
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith({ project: 'lenta' }));
    const second = navigation.navigate({ project: 'final' });
    await Promise.resolve();
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(navigation.current.project).toBe('final');
    navigation.destroy();
  });
});
