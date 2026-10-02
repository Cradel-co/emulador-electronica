import { useEstado, useVersion } from './estado.js';
import { acciones, estado } from './puente.js';
import { lenguajeDeArchivo } from '../editor.js';

/**
 * Tres pedazos chicos de la barra que generaban HTML a mano (#9). Cada uno se monta sobre su nodo
 * de siempre; mostrarlos u ocultarlos lo sigue decidiendo `app.ts`.
 */

/** Las pestañas de los archivos del proyecto (`#tabs-archivos`), con la abierta marcada. */
export function Pestanas() {
  const archivos = useEstado(() => estado().archivos as { path: string }[]);
  const activo = useEstado(() => estado().activo as string | null);
  return (
    <>
      {(archivos ?? []).map((f) => (
        <button
          key={f.path}
          className={f.path === activo ? 'activa' : undefined}
          data-tipo={lenguajeDeArchivo(f.path)}
          title={f.path}
          onClick={() => acciones().abrirArchivo(f.path)}
        >
          {f.path}
        </button>
      ))}
    </>
  );
}

/** Dónde estás (`#miga`): el proyecto y el archivo abierto, o "Bienvenida" en el inicio. */
export function Miga() {
  const proyecto = useEstado(() => estado().proyecto as { name: string } | null);
  const activo = useEstado(() => estado().activo as string | null);
  if (!proyecto) return <>Bienvenida</>;
  return <>{proyecto.name}{activo && <><span className="sep">›</span>{activo}</>}</>;
}

/** La ventana de notificaciones (`#lista-notificaciones`): los últimos avisos, el más nuevo arriba. */
export function Notificaciones() {
  // `state.notificaciones` se modifica en el lugar (`unshift`): hace falta la versión.
  useVersion();
  const notifs = estado().notificaciones as { texto: string; hora: Date }[];
  return (
    <>
      <h4>Notificaciones</h4>
      {notifs.length === 0
        ? <p className="vacio">Sin notificaciones.</p>
        : notifs.map((n, i) => (
          <div className="notif" key={`${n.hora.getTime()}-${i}`}>
            <time>{n.hora.toLocaleTimeString()}</time>{n.texto}
          </div>
        ))}
    </>
  );
}
