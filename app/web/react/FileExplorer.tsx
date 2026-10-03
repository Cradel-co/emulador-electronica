import { ToolWindow } from './ToolWindow.js';
import { ExplorerIcon } from './ExplorerIcon.js';
import { useEstado } from './estado.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { acciones, estado } from './puente.js';
import { placasDelProyecto } from '../project-boards.js';
import { carpetaDeArchivo, construirArbolArchivos, type FileTree } from '../file-tree.js';
interface TreeActions { active: string | null; selected: string | null; onOpen: (path: string) => void; onSelect: (path: string) => void }
function TreeChildren({ node, active, selected, onOpen, onSelect }: TreeActions & { node: FileTree }) {
  const children = [...node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
  return <ul>{children.map(child => <li key={child.path}>
    {child.file ? <button className={child.path === active && selected === null ? 'activa' : undefined} title={child.path} onClick={() => onOpen(child.path)}><EntryIcon folder={false} path={child.path} /><span className="explorer-entry-name">{child.name}</span></button>
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
    onClick={() => onSelect(node.path)}><TreeChevron /><span className="explorer-entry-name">{node.name}</span></summary><TreeChildren {...props} /></details>;
}
function TreeChevron() {
  return <svg className="tree-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>;
}
function ActionIcon({ kind }: { kind: 'refresh' | 'collapse' }) {
  return <svg className="file-entry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{kind === 'refresh'
    ? <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" /></>
    : <><rect x="6" y="3" width="15" height="15" rx="2" /><path d="M3 7v12a2 2 0 0 0 2 2h12M10 11h7" /></>}</svg>;
}
function EntryIcon({ folder, path }: { folder: boolean; path?: string }) {
  if (path?.endsWith('.py')) return <svg className="file-entry-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#519aba" d="M12 2c-5 0-5 1-5 4v3h6v1H5c-4 0-4 8 0 8h2v-3c0-3 2-4 5-4h5V6c0-3-1-4-5-4Z" />
    <path fill="#c5a65b" d="M12 22c5 0 5-1 5-4v-3h-6v-1h8c4 0 4-8 0-8h-2v3c0 3-2 4-5 4H7v5c0 3 1 4 5 4Z" />
    <circle cx="10" cy="5" r="1" fill="var(--isla)" /><circle cx="14" cy="19" r="1" fill="var(--isla)" />
  </svg>;
  return <svg className="file-entry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">{folder ? <path d="M3 7V5h7l2 2h9v13H3Z" /> : <><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h4" /></>}</svg>;
}
export function FileTreeView({ paths, directories = [], active, selected = null, onOpen, onSelect = () => {} }: {
  paths: string[]; directories?: string[]; selected?: string | null; active: string | null;
  onOpen: (path: string) => void; onSelect?: (path: string) => void;
}) {
  return <TreeChildren node={construirArbolArchivos(paths, directories)} active={active} selected={selected} onOpen={onOpen} onSelect={onSelect} />;
}
/** Grupo plegable para las raíces del explorador, con acciones inyectables. */
function ExplorerGroup({ label, actions, selected = false, onSelect, children, className = '', revealKey }: {
  label: string; actions?: ReactNode; selected?: boolean; onSelect: () => void; children: ReactNode; className?: string; revealKey?: string | null;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (details.current) details.current.open = true; }, [revealKey]);
  return <details ref={details} className={`explorer-group ${className}`} open>
    <summary className={selected ? 'activa' : undefined} title={label} onClick={onSelect}>
      <TreeChevron /><span className="explorer-root-row"><span className="explorer-root-name">{label}</span>{actions}</span>
    </summary>
    <div className="explorer-group-children">{children}</div>
  </details>;
}

export function FileExplorer() {
  const tree = useRef<HTMLDivElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const revealRoots = () => tree.current?.querySelectorAll<HTMLDetailsElement>('.explorer-group').forEach(group => { group.open = true; });
  const collapse = () => {
    tree.current?.querySelectorAll<HTMLDetailsElement>('details:not(.explorer-project-root)').forEach(group => { group.open = false; });
    setSelected('');
  };
  const refresh = async () => {
    setRefreshing(true); setRefreshError('');
    try { await acciones().actualizarExplorador(); }
    catch (error) { setRefreshError(error instanceof Error ? error.message : 'No se pudo actualizar el explorador.'); }
    finally { setRefreshing(false); }
  };
  const files = useEstado(() => estado().archivos as { path: string }[]);
  const directories = useEstado(() => estado().carpetas as string[]);
  const active = useEstado(() => estado().activo as string | null);
  const boardId = useEstado(() => estado().placaActivaId as string | null);
  const project = useEstado(() => estado().proyecto);
  const boardName = useEstado(() => estado().placa?.nombre as string | undefined);
  const board = placasDelProyecto(project).find(b => b.id === boardId);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [project?.name, boardId, active]);
  const parent = selected ?? carpetaDeArchivo(active);
  const toolbar = <div className="explorer-toolbar" role="toolbar" aria-label="Acciones del explorador" onClick={event => {
    event.preventDefault();
    event.stopPropagation();
  }}>
    <button type="button" disabled={!board} aria-label="Nuevo archivo" title={`Nuevo archivo en ${parent || 'la raíz de la placa'}`} onClick={() => { revealRoots(); acciones().nuevoArchivo(parent); }}><EntryIcon folder={false} /></button>
    <button type="button" disabled={!board} aria-label="Nueva carpeta" title={`Nueva carpeta en ${parent || 'la raíz de la placa'}`} onClick={() => { revealRoots(); acciones().nuevaCarpeta(parent); }}><EntryIcon folder /></button>
    <button type="button" disabled={!board || refreshing} aria-label="Actualizar explorador" title="Actualizar explorador" onClick={() => void refresh()}><ActionIcon kind="refresh" /></button>
    <button type="button" disabled={!board} aria-label="Plegar carpetas" title="Plegar carpetas" onClick={collapse}><ActionIcon kind="collapse" /></button>
  </div>;
  return <ToolWindow id="ventana-explorador" title="Explorador" icon={<ExplorerIcon />}
    onClose={() => acciones().mostrarHerramienta('explorador', false)}>
    <section id="explorador-archivos" className="explorador-archivos" aria-label="Explorador de archivos">
      <div ref={tree} className="file-explorer-tree" data-board-id={board?.id} onClick={event => {
        if (event.target === event.currentTarget) setSelected('');
      }}>
        {project ? <ExplorerGroup key={project.name} label={project.name} revealKey={active} actions={toolbar} onSelect={() => setSelected('')} className="explorer-project-root">
          {board ? <ExplorerGroup key={board.id} label={boardName ?? board.board} revealKey={active} selected={selected === '' || selected === null}
            onSelect={() => setSelected('')} className="explorer-board-root">
            <FileTreeView paths={(files ?? []).map(f => f.path)} directories={directories ?? []} selected={selected} active={active}
              onSelect={setSelected} onOpen={path => { setSelected(null); acciones().abrirArchivo(path); }} />
          </ExplorerGroup> : <p>Seleccioná una placa en el circuito para ver sus archivos.</p>}
        </ExplorerGroup> : <p>Abrí un proyecto para ver sus archivos.</p>}
      </div>
      {refreshError && <p role="alert">{refreshError}</p>}
    </section>
  </ToolWindow>;
}
