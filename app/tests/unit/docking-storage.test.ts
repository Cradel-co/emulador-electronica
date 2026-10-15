import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDockLayout, moveDockWindow } from '../../web/docking-layout.js';
import { projectDockLayout, saveProjectDockLayout, saveDefaultDockLayout, resetDefaultDockLayout, projectDockFilter, saveProjectDockFilter, clearProjectDockLayout } from '../../web/docking-storage.js';

describe('distribuciones guardadas por proyecto', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('cambiar el predeterminado no cambia los proyectos ya abiertos', () => {
    const original = projectDockLayout('existente');
    const custom = moveDockWindow(defaultDockLayout(), 'componentes', 'grupo-circuito', 'center');
    saveDefaultDockLayout(custom);
    expect(projectDockLayout('nuevo')).toEqual(custom);
    expect(projectDockLayout('existente')).toEqual(original);
    resetDefaultDockLayout();
    expect(projectDockLayout('nuevo')).toEqual(custom);
    expect(projectDockLayout('otro')).toEqual(defaultDockLayout());
  });
  it('separa diseños y filtros, y un nombre recreado recibe el predeterminado', () => {
    const custom = moveDockWindow(defaultDockLayout(), 'codigo', 'grupo-circuito', 'bottom');
    saveProjectDockLayout('A', custom); saveProjectDockFilter('A', '433');
    expect(projectDockLayout('A')).toEqual(custom);
    expect(projectDockLayout('B')).toEqual(defaultDockLayout());
    expect(projectDockFilter('A')).toBe('433'); expect(projectDockFilter('B')).toBe('');
    clearProjectDockLayout('A');
    expect(projectDockLayout('A')).toEqual(defaultDockLayout()); expect(projectDockFilter('A')).toBe('');
  });
  it('una preferencia corrupta o almacenamiento no disponible no rompe el arranque', () => {
    localStorage.setItem('emu:docking:project:A:v1', '{malformado');
    expect(projectDockLayout('A')).toEqual(defaultDockLayout());
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); } });
    expect(projectDockLayout('A')).toEqual(defaultDockLayout());
  });
});
