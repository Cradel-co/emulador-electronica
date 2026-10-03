import type { ReactNode } from 'react';
import type { ToolDock } from '../tool-windows.js';

/** Ventana sin contenido específico: el consumidor inyecta cuerpo, icono y acciones. */
export function ToolWindow({ id, title, icon, actions, open, dock, onClose, onMove, children }: {
  id: string; title: string; icon?: ReactNode; actions?: ReactNode; open: boolean; dock: ToolDock;
  onClose: () => void; onMove: (dock: ToolDock) => void; children: ReactNode;
}) {
  const destination = dock === 'izq' ? 'der' : 'izq';
  return <section id={id} className="panel isla tool-window" aria-label={title} hidden={!open}>
    <h2 className="panel-header">
      {icon}{title}<span className="crece" />{actions}
      <button className="btn-chico tool-move" title={`Mover ${title} al lateral ${destination === 'izq' ? 'izquierdo' : 'derecho'}`} aria-label={`Mover ${title} al lateral ${destination === 'izq' ? 'izquierdo' : 'derecho'}`} onClick={() => onMove(destination)}>
        {destination === 'izq' ? '←' : '→'}
      </button>
      <button className="tw-ocultar" title={`Ocultar ${title}`} aria-label={`Ocultar ${title}`} onClick={onClose}>−</button>
    </h2>
    {children}
  </section>;
}
