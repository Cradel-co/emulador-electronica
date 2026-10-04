import { useEstado } from './estado.js';
import { acciones, estado } from './puente.js';

export function LayoutSettings() {
  const proyecto = useEstado(() => estado().proyecto as { name: string } | null);
  const message = useEstado(() => estado().distribucionMensaje as string);
  return <form method="dialog" className="editor-preferences layout-settings">
    <h2>Distribución de ventanas</h2>
    <p>Cada proyecto guarda su distribución de ventanas. El predeterminado se usa al abrir proyectos que todavía no tienen una distribución propia.</p>
    {proyecto
      ? <p>Proyecto actual: <strong>{proyecto.name}</strong></p>
      : <p>Abrí un proyecto para guardar o restaurar su distribución.</p>}
    <div className="layout-settings-actions">
      <button type="button" disabled={!proyecto} onClick={() => acciones().guardarDistribucionPredeterminada()}>Guardar distribución actual como predeterminada</button>
      <button type="button" disabled={!proyecto} onClick={() => acciones().restaurarDistribucionProyecto()}>Restaurar este proyecto al predeterminado</button>
      <button type="button" onClick={() => acciones().restaurarDistribucionOriginal()}>Restablecer el predeterminado original</button>
    </div>
    {message && <p role="status">{message}</p>}
    <div className="editor-preferences-actions"><button type="submit">Cerrar</button></div>
  </form>;
}
