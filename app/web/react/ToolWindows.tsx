import { createPortal } from 'react-dom';
import { ToolWindow } from './ToolWindow.js';
import { Catalogo } from './Catalogo.js';
import { FileExplorer } from './FileExplorer.js';
import { ExplorerIcon } from './ExplorerIcon.js';
import { acciones, estado } from './puente.js';
import { useEstado } from './estado.js';
import type { ToolWindowLayout, ToolWindowId } from '../tool-windows.js';

function Componentes() {
  const filtro = useEstado(() => estado().filtroModulos as string);
  return <>
    <label className="buscar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input id="buscar-modulos" placeholder="Buscar módulo…" value={filtro} onChange={e => acciones().filtrarModulos(e.target.value)} />
    </label>
    <p className="ayuda-paleta">Arrastrá un módulo al circuito, o hacé click para agregarlo.</p>
    <div id="lista-modulos" className="lista-modulos"><Catalogo /></div>
  </>;
}

/** Registro de ventanas: cada contenido se inyecta en la misma estructura reutilizable. */
export function ToolWindows() {
  const layout = useEstado(() => estado().ventanasHerramientas as ToolWindowLayout);
  const views = [
    { id: 'explorador' as const, title: 'Explorador', icon: <ExplorerIcon />, body: <section id="explorador-archivos" className="explorador-archivos" aria-label="Explorador de archivos"><FileExplorer /></section> },
    { id: 'componentes' as const, title: 'Componentes', actions: <button id="importar-modulo" className="btn-chico" title="Importar módulos" onClick={() => acciones().importarModulos()}>+ Importar</button>, body: <Componentes /> },
  ];
  return <>{views.map(view => {
    const config = layout[view.id];
    const dock = document.getElementById(`dock-${config.dock}`);
    if (!dock) return null;
    return createPortal(<ToolWindow id={`ventana-${view.id}`} title={view.title} icon={view.icon} actions={view.actions}
      open={config.open} dock={config.dock} onClose={() => acciones().mostrarHerramienta(view.id, false)}
      onMove={destination => acciones().moverHerramienta(view.id as ToolWindowId, destination)}>
      {view.body}
    </ToolWindow>, dock, view.id);
  })}</>;
}
