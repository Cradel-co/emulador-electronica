import { defaultDockLayout, normalizeDockLayout, type DockLayout } from './docking-layout.js';

const DEFAULT_KEY = 'emu:docking:default:v1';
const key = (project: string) => `emu:docking:project:${encodeURIComponent(project)}:v1`;
function read(name: string): DockLayout | null {
  try {
    const value = localStorage.getItem(name);
    return value ? normalizeDockLayout(JSON.parse(value)) : null;
  } catch { return null; }
}
export function projectDockLayout(project: string, hasBoard = true): DockLayout {
  const own = read(key(project));
  if (own) return hasBoard ? own : { ...own, open: { ...own.open, codigo: false } };
  const initial = read(DEFAULT_KEY) ?? defaultDockLayout();
  if (!hasBoard) initial.open.codigo = false;
  saveProjectDockLayout(project, initial);
  return initial;
}
export function saveProjectDockLayout(project: string, layout: DockLayout): void {
  try { localStorage.setItem(key(project), JSON.stringify(layout)); } catch { /* El diseño sigue funcionando sin almacenamiento. */ }
}
export function defaultSavedDockLayout(): DockLayout { return read(DEFAULT_KEY) ?? defaultDockLayout(); }
export function saveDefaultDockLayout(layout: DockLayout): void {
  try { localStorage.setItem(DEFAULT_KEY, JSON.stringify(layout)); } catch { /* Preferencia opcional. */ }
}
export function resetDefaultDockLayout(): void {
  try { localStorage.removeItem(DEFAULT_KEY); } catch { /* Preferencia opcional. */ }
}
export function projectDockFilter(project: string): string {
  try { return localStorage.getItem(`${key(project)}:filter`) ?? ''; } catch { return ''; }
}
export function saveProjectDockFilter(project: string, filter: string): void {
  try { localStorage.setItem(`${key(project)}:filter`, filter); } catch { /* Preferencia opcional. */ }
}
export function clearProjectDockLayout(project: string): void {
  try { localStorage.removeItem(key(project)); localStorage.removeItem(`${key(project)}:filter`); } catch { /* Preferencia opcional. */ }
}
