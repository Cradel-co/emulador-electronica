import { useEstado } from './estado.js';
import { acciones, estado } from './puente.js';
import { placasDelProyecto } from '../project-boards.js';
import { construirArbolArchivos, type FileTree } from '../file-tree.js';
function TreeChildren({ node, active, onOpen }: { node: FileTree; active: string | null; onOpen: (path: string) => void }) {
  const children = [...node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
  return <ul>{children.map(child => <li key={child.path}>
    {child.file ? <button className={child.path === active ? 'activa' : undefined} title={child.path} onClick={() => onOpen(child.path)}>{child.name}</button>
      : <details open><summary>{child.name}</summary><TreeChildren node={child} active={active} onOpen={onOpen} /></details>}
  </li>)}</ul>;
}
export function FileTreeView({ paths, active, onOpen }: { paths: string[]; active: string | null; onOpen: (path: string) => void }) {
  return <TreeChildren node={construirArbolArchivos(paths)} active={active} onOpen={onOpen} />;
}
export function FileExplorer() {
  const files = useEstado(() => estado().archivos as { path: string }[]);
  const active = useEstado(() => estado().activo as string | null);
  const boardId = useEstado(() => estado().placaActivaId as string | null);
  const project = useEstado(() => estado().proyecto);
  const board = placasDelProyecto(project).find(b => b.id === boardId);
  return <>
    <h3>Explorador{board && <span>{board.id}</span>}</h3>
    {board ? <FileTreeView paths={(files ?? []).map(f => f.path)} active={active} onOpen={path => acciones().abrirArchivo(path)} /> : <p>Seleccioná una placa en el circuito para ver sus archivos.</p>}
  </>;
}
