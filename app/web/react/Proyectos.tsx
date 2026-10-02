import { useEstado } from './estado.js';
import { acciones, estado } from './puente.js';

/** Color estable por nombre, para la insignia: el mismo proyecto siempre se ve igual. */
function colorDe(nombre: string): string {
  let h = 0;
  for (const c of nombre) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 42% 46%)`;
}

/** Iniciales para la insignia: "demo-boton-led" → "DB". */
function inicialesDe(nombre: string): string {
  const partes = nombre.split(/[-_\s]+/).filter(Boolean);
  return ((partes[0]?.[0] ?? '') + (partes[1]?.[0] ?? partes[0]?.[1] ?? '')).toUpperCase() || '?';
}

/**
 * La lista de proyectos de la pantalla de inicio (`#lista-proyectos`): cada uno con su insignia,
 * su lenguaje, cuántos módulos tiene y con qué placa.
 *
 * Migrado a React (#9). El filtro del buscador vivía en el DOM (se leía del input en cada
 * repintado); ahora está en el estado, como el del catálogo.
 */
export function Proyectos() {
  const proyectos = useEstado(() => estado().proyectos as any[]);
  const catalogo = useEstado(() => estado().catalogo as Map<string, any>);
  const filtro = useEstado(() => estado().filtroProyectos as string);
  const { abrirProyecto, eliminarProyecto } = acciones();

  if (!proyectos || proyectos.length === 0) {
    return (
      <div className="vacio-panel">
        <p>Todavía no tenés proyectos</p>
        <span>Creá el primero con "Nuevo proyecto".</span>
      </div>
    );
  }

  const buscado = (filtro ?? '').trim().toLowerCase();
  const lista = proyectos.filter((p) => !buscado || `${p.name} ${p.language}`.toLowerCase().includes(buscado));

  if (lista.length === 0) return <p className="vacio">Ningún proyecto coincide con la búsqueda.</p>;

  return (
    <>
      {lista.map((p) => {
        const placa = p.board ? (catalogo?.get(p.board)?.name ?? p.board) : 'sin placa';
        return (
          <div key={p.name} className="proyecto-card">
            <button type="button" className="proyecto-abrir" onClick={() => abrirProyecto(p.name)}>
              <span className="insignia" style={{ ['--color-proyecto' as any]: colorDe(p.name) }}>
                {inicialesDe(p.name)}
              </span>
              <span className="nombre">{p.name}</span>
              <span className="linea2">
                <span className="lenguaje">{p.language ?? 'circuito'}</span>
                <span className="detalle">
                  {p.modules.length} módulo(s) en el circuito{placa ? ` · ${placa}` : ''}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="quitar"
              title={`Eliminar "${p.name}"`}
              aria-label={`Eliminar "${p.name}"`}
              onClick={() => eliminarProyecto(p.name)}
            >
              ×
            </button>
          </div>
        );
      })}
    </>
  );
}
