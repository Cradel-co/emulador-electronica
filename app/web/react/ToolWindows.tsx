import { createPortal } from 'react-dom';
import { ToolWindow } from './ToolWindow.js';
import { Catalogo } from './Catalogo.js';
import { FileExplorer } from './FileExplorer.js';
import { acciones, estado } from './puente.js';
import { useEstado } from './estado.js';

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
  const views = [
    { id: 'explorador', content: <FileExplorer /> },
    { id: 'componentes', content: <ToolWindow title="Componentes"
      actions={<button id="importar-modulo" className="btn-chico" title="Importar módulos" onClick={() => acciones().importarModulos()}>+ Importar</button>}
      ><Componentes /></ToolWindow> },
  ];
  return <>{views.map(view => {
    const dock = document.getElementById(`ventana-${view.id}`);
    return dock ? createPortal(view.content, dock, view.id) : null;
  })}</>;
}
