import { useEffect, useRef } from 'react';
import { useEstado, useVersion } from './estado.js';
import { acciones, estado } from './puente.js';
import { placasDelProyecto } from '../project-boards.js';
import { lenguajeDeArchivo } from '../editor.js';

/**
 * Tres pedazos chicos de la barra que generaban HTML a mano (#9). Cada uno se monta sobre su nodo
 * de siempre; mostrarlos u ocultarlos lo sigue decidiendo `app.ts`.
 */

/** Las pestañas de los archivos del proyecto (`#tabs-archivos`), con la abierta marcada. */
export function Pestanas() {
  const archivos = useEstado(() => estado().archivos as { path: string }[]);
  const activo = useEstado(() => estado().activo as string | null);
  const boardId = useEstado(() => estado().placaActivaId as string | null);
  const project = useEstado(() => estado().proyecto);
  const microPython = placasDelProyecto(project).find(b => b.id === boardId)?.language === 'micropython';
  const activeTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [activo, archivos]);
  return (
    <>
      {(archivos ?? []).map((f) => (
        <button
          key={f.path}
          ref={f.path === activo ? activeTab : undefined}
          className={f.path === activo ? 'activa' : undefined}
          data-tipo={lenguajeDeArchivo(f.path)}
          title={f.path}
          onClick={() => acciones().abrirArchivo(f.path)}
        >
          {f.path}
        </button>
      ))}
      {boardId && microPython && <button className="nuevo-archivo" aria-label="Nuevo archivo MicroPython" title="Nuevo archivo MicroPython" onClick={() => acciones().nuevoArchivo()}>+</button>}
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
