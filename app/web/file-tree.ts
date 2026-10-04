export interface FileTree { name: string; path: string; children: Map<string, FileTree>; file: boolean }
/** Genera la jerarquía sin efectos para reutilizarla en vistas y probar carpetas anidadas. */
export function construirArbolArchivos(paths: string[], directories: string[] = []): FileTree {
  const root: FileTree = { name: '', path: '', children: new Map(), file: false };
  for (const [path, file] of [...directories.map(path => [path, false] as const), ...paths.map(path => [path, true] as const)]) {
    let current = root;
    const parts = path.split('/').filter(Boolean);
    parts.forEach((name, index) => {
      const node = current.children.get(name) ?? { name, path: parts.slice(0, index + 1).join('/'), children: new Map(), file: false };
      current.children.set(name, node); current = node;
      if (index === parts.length - 1 && file) node.file = true;
    });
  }
  return root;
}

export const carpetaDeArchivo = (path: string | null) => path?.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export type EntryKind = 'file' | 'directory';
export interface EntryCreationContext { project: string; boardId: string; parent: string; kind: EntryKind; language: string }
const SUFFIX: Record<string, string> = { micropython: '.py', esphome: '.yaml', 'idf-c': '.c', 'idf-cpp': '.cpp', arduino: '.cpp' };
/** Resolver el destino no depende de la vista ni del estado global del editor. */
export function rutaNuevaEntrada(parent: string, name: string, kind: EntryKind, language: string): string {
  const input = name.trim();
  if (!input || input.includes('\\') || input.includes('\0') || input.split('/').some(segment => !segment || segment.startsWith('.'))) {
    throw new Error('Usá una ruta relativa sin segmentos vacíos, ocultos ni ..');
  }
  const base = input.split('/').at(-1) ?? '';
  const suffix = kind === 'file' && !base.includes('.') ? SUFFIX[language] ?? '' : '';
  return `${parent ? parent + '/' : ''}${input}${suffix}`;
}

/** Árbol de una instancia de placa; las rutas siempre son relativas a esa placa. */
export interface BoardFileTree { id: string; name: string; files: { path: string }[]; directories: string[] }
