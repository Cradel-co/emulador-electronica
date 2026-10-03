import { ToolWindow } from './ToolWindow.js';
import { ExplorerIcon } from './ExplorerIcon.js';
import { useEstado } from './estado.js';
import { useEffect, useRef, useState } from 'react';
import { acciones, estado } from './puente.js';
import { placasDelProyecto } from '../project-boards.js';
import { carpetaDeArchivo, construirArbolArchivos, type FileTree } from '../file-tree.js';
interface TreeActions { active: string | null; selected: string | null; onOpen: (path: string) => void; onSelect: (path: string) => void }
function TreeChildren({ node, active, selected, onOpen, onSelect }: TreeActions & { node: FileTree }) {
  const children = [...node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
  return <ul>{children.map(child => <li key={child.path}>
    {child.file ? <button className={child.path === active && selected === null ? 'activa' : undefined} title={child.path} onClick={() => onOpen(child.path)}><EntryIcon folder={false} />{child.name}</button>
      : <TreeDirectory node={child} active={active} selected={selected} onOpen={onOpen} onSelect={onSelect} />}
  </li>)}</ul>;
}
function TreeDirectory(props: TreeActions & { node: FileTree }) {
  const { node, active, selected, onSelect } = props;
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (active?.startsWith(node.path + '/') && details.current) details.current.open = true;
  }, [active, node.path]);
  return <details ref={details} open><summary className={node.path === selected ? 'activa' : undefined} title={node.path}
    onClick={() => onSelect(node.path)}><EntryIcon folder />{node.name}</summary><TreeChildren {...props} /></details>;
}
function EntryIcon({ folder }: { folder: boolean }) {
  return <svg className="file-entry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">{folder ? <path d="M3 7V5h7l2 2h9v13H3Z" /> : <><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h4" /></>}</svg>;
}
export function FileTreeView({ paths, directories = [], active, selected = null, onOpen, onSelect = () => {} }: {
  paths: string[]; directories?: string[]; selected?: string | null; active: string | null;
  onOpen: (path: string) => void; onSelect?: (path: string) => void;
}) {
  return <TreeChildren node={construirArbolArchivos(paths, directories)} active={active} selected={selected} onOpen={onOpen} onSelect={onSelect} />;
}
export function FileExplorer() {
  const files = useEstado(() => estado().archivos as { path: string }[]);
  const directories = useEstado(() => estado().carpetas as string[]);
  const active = useEstado(() => estado().activo as string | null);
  const boardId = useEstado(() => estado().placaActivaId as string | null);
  const project = useEstado(() => estado().proyecto);
  const board = placasDelProyecto(project).find(b => b.id === boardId);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [project?.name, boardId, active]);
  const parent = selected ?? carpetaDeArchivo(active);
  const toolbar = <div className="explorer-toolbar" role="toolbar" aria-label="Acciones del explorador">
    <button type="button" disabled={!board} aria-label="Nuevo archivo" title={`Nuevo archivo en ${parent || 'la raíz de la placa'}`} onClick={() => acciones().nuevoArchivo(parent)}><EntryIcon folder={false} /></button>
    <button type="button" disabled={!board} aria-label="Nueva carpeta" title={`Nueva carpeta en ${parent || 'la raíz de la placa'}`} onClick={() => acciones().nuevaCarpeta(parent)}><EntryIcon folder /></button>
  </div>;
  return <ToolWindow id="ventana-explorador" title="Explorador" icon={<ExplorerIcon />} actions={toolbar}
    onClose={() => acciones().mostrarHerramienta('explorador', false)}>
    <section id="explorador-archivos" className="explorador-archivos" aria-label="Explorador de archivos">
      <div className="file-explorer-tree" data-board-id={board?.id} onClick={event => {
        if (event.target === event.currentTarget) setSelected('');
      }}>
        {board ? <FileTreeView paths={(files ?? []).map(f => f.path)} directories={directories ?? []} selected={selected} active={active}
          onSelect={setSelected} onOpen={path => { setSelected(null); acciones().abrirArchivo(path); }} /> : <p>Seleccioná una placa en el circuito para ver sus archivos.</p>}
      </div>
    </section>
  </ToolWindow>;
}
