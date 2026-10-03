import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EDITOR_PREFERENCES, normalizeEditorPreferences } from '../../web/editor-preferences.js';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('preferencias del editor MicroPython', () => {
  it.each([undefined, null, 'dark', 42, [], { theme: 'solarized', fontSize: '18', indentWidth: '2' }])('descarta datos inválidos %j', value => {
    expect(normalizeEditorPreferences(value)).toEqual(DEFAULT_EDITOR_PREFERENCES);
  });
  it('acepta los temas y tamaños de sangría soportados', () => {
    for (const indentWidth of [2, 4, 8]) {
      expect(normalizeEditorPreferences({ theme: 'light', fontSize: 18, indentWidth })).toEqual({ theme: 'light', fontSize: 18, indentWidth });
    }
  });
  it.each([NaN, Infinity, -Infinity])('descarta fuentes no finitas %s', fontSize => {
    expect(normalizeEditorPreferences({ fontSize }).fontSize).toBe(13);
  });
  it('limita la fuente y redondea valores fraccionarios', () => {
    expect(normalizeEditorPreferences({ fontSize: 2 }).fontSize).toBe(10);
    expect(normalizeEditorPreferences({ fontSize: 200 }).fontSize).toBe(24);
    expect(normalizeEditorPreferences({ fontSize: 15.6 }).fontSize).toBe(16);
    expect(normalizeEditorPreferences({ fontSize: 15.2 }).fontSize).toBe(15);
  });
  it.each([0, 3, 4.5, 16, null])('restaura sangría de 4 espacios ante valor inválido %s', indentWidth => {
    expect(normalizeEditorPreferences({ indentWidth }).indentWidth).toBe(4);
  });
  it('funciona sin localStorage y notifica cambios válidos', async () => {
    vi.resetModules(); vi.stubGlobal('localStorage', undefined);
    const prefs = await import('../../web/editor-preferences.js');
    expect(prefs.editorPreferences()).toEqual(DEFAULT_EDITOR_PREFERENCES);
    const listener = vi.fn();
    const unsubscribe = prefs.subscribeEditorPreferences(listener);
    expect(() => prefs.setEditorPreferences({ theme: 'light', fontSize: 18 })).not.toThrow();
    expect(prefs.editorPreferences()).toEqual({ theme: 'light', fontSize: 18, indentWidth: 4 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe(); prefs.setEditorPreferences({ indentWidth: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('descarta JSON corrupto almacenado', async () => {
    vi.resetModules(); vi.stubGlobal('localStorage', { getItem: () => '{no-json' });
    const prefs = await import('../../web/editor-preferences.js');
    expect(prefs.editorPreferences()).toEqual(DEFAULT_EDITOR_PREFERENCES);
  });
  it('carga valores persistidos y valida sus límites', async () => {
    vi.resetModules(); const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ theme: 'light', fontSize: 100, indentWidth: 8 }), setItem });
    const prefs = await import('../../web/editor-preferences.js');
    expect(prefs.editorPreferences()).toEqual({ theme: 'light', fontSize: 24, indentWidth: 8 });
    prefs.setEditorPreferences({ fontSize: 14 });
    expect(setItem).toHaveBeenCalledWith('emulador.micropython.editor', JSON.stringify({ theme: 'light', fontSize: 14, indentWidth: 8 }));
  });
});
