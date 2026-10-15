export interface EditorPreferences { theme: 'dark' | 'light'; fontSize: number; indentWidth: number }
export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = { theme: 'dark', fontSize: 13, indentWidth: 4 };
const STORAGE_KEY = 'emulador.micropython.editor';
/** Valida preferencias guardadas o importadas sin confiar en el contenido de localStorage. */
export function normalizeEditorPreferences(value: unknown): EditorPreferences {
  const p = value && typeof value === 'object' ? value as Partial<EditorPreferences> : {};
  const indentWidth = p.indentWidth === 2 || p.indentWidth === 4 || p.indentWidth === 8 ? p.indentWidth : 4;
  return {
    theme: p.theme === 'light' ? 'light' : 'dark',
    fontSize: typeof p.fontSize === 'number' && Number.isFinite(p.fontSize) ? Math.max(10, Math.min(24, Math.round(p.fontSize))) : 13,
    indentWidth,
  };
}
function load(): EditorPreferences {
  try { return normalizeEditorPreferences(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')); }
  catch { return { ...DEFAULT_EDITOR_PREFERENCES }; }
}
let current = load();
const listeners = new Set<() => void>();
export const editorPreferences = () => current;
export function subscribeEditorPreferences(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function setEditorPreferences(p: Partial<EditorPreferences>): void {
  current = normalizeEditorPreferences({ ...current, ...p });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* Preferencias válidas durante esta sesión. */ }
  for (const listener of listeners) listener();
}
