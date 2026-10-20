import type { ReactNode } from 'react';

/** Cuerpo reutilizable: la pestaña del dock aporta el título y las acciones quedan en su barra. */
export function ToolWindow({ title, actions, children }: {
  title: string; actions?: ReactNode; children: ReactNode;
}) {
  return <>
    {actions && <div className="tool-window-actions" role="toolbar" aria-label={`Acciones de ${title}`}>{actions}</div>}
    {children}
  </>;
}
