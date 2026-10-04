import type { ReactNode } from 'react';

/** Ventana sin contenido específico: el consumidor inyecta cuerpo, icono y acciones. */
export function ToolWindow({ id, title, icon, actions, onClose, children }: {
  id: string; title: string; icon?: ReactNode; actions?: ReactNode;
  onClose: () => void; children: ReactNode;
}) {
  const view = id.replace('ventana-', '');
  return <>
    <h2 className="panel-header">
      <button type="button" className="window-grip" data-window-drag={view} aria-label={`Mover ventana ${title}`} title="Mantener presionado y arrastrar">⠿</button>
      {icon}{title}<span className="crece" />{actions}
      <button className="tw-ocultar" title={`Ocultar ${title}`} aria-label={`Ocultar ${title}`} onClick={onClose}>−</button>
    </h2>
    {children}
  </>;
}
