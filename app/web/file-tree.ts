export interface FileTree { name: string; path: string; children: Map<string, FileTree>; file: boolean }
/** Genera la jerarquía sin efectos para reutilizarla en vistas y probar carpetas anidadas. */
export function construirArbolArchivos(paths: string[]): FileTree {
  const root: FileTree = { name: '', path: '', children: new Map(), file: false };
  for (const path of paths) {
    let current = root;
    const parts = path.split('/').filter(Boolean);
    parts.forEach((name, index) => {
      const node = current.children.get(name) ?? { name, path: parts.slice(0, index + 1).join('/'), children: new Map(), file: false };
      current.children.set(name, node); current = node;
      if (index === parts.length - 1) node.file = true;
    });
  }
  return root;
}
