import { Fragment } from 'react';
import { Miniatura } from './Miniatura.js';
import { useEstado } from './estado.js';
import { acciones, estado } from './puente.js';

/** Las categorías van en este orden; las que no estén en la lista, al final y alfabéticas. */
const ORDEN = ['Placas', 'Entradas', 'Salidas', 'Pasivos', 'Radio 433 MHz', 'Inalámbricos'];
const pesoDe = (c: string) => (ORDEN.indexOf(c) + 1 || 99);

/**
 * El catálogo de módulos del panel izquierdo (`#lista-modulos`): lo que se puede agregar al
 * circuito, agrupado por categoría y filtrable.
 *
 * Migrado a React (#9). Antes se rearmaba a mano con un cache de nodos por tipo para no rehacer
 * las miniaturas en cada tecla del buscador; acá eso lo resuelve el diffing, y las miniaturas se
 * dibujan una vez porque el `def` de un módulo no cambia.
 */
export function Catalogo() {
  const catalogo = useEstado(() => estado().catalogo as Map<string, any>);
  const filtro = useEstado(() => estado().filtroModulos as string);

  if (!catalogo || catalogo.size === 0) {
    return (
      <div className="vacio-panel">
        <p>Sin módulos todavía</p>
        <span>No se encontró el catálogo (carpeta modules/).</span>
      </div>
    );
  }

  const buscado = filtro.toLowerCase();
  const porCategoria = new Map<string, any[]>();
  for (const m of catalogo.values()) {
    if (buscado && !`${m.name} ${m.category} ${m.type}`.toLowerCase().includes(buscado)) continue;
    if (!porCategoria.has(m.category)) porCategoria.set(m.category, []);
    porCategoria.get(m.category)!.push(m);
  }

  if (porCategoria.size === 0) return <p className="vacio">Sin resultados.</p>;

  const categorias = [...porCategoria.keys()].sort((a, b) => pesoDe(a) - pesoDe(b) || a.localeCompare(b));

  // Cabecera y grilla van como hermanos, hijos directos de `#lista-modulos`: así los tenía el
  // código imperativo y así los espera el CSS. Un div por categoría rompía el scroll.
  return (
    <>
      {categorias.map((categoria) => (
        <Fragment key={categoria}>
          <div className="cat-header">{categoria}</div>
          <div className="cat-grid">
            {porCategoria.get(categoria)!.map((m) => <Tarjeta key={m.type} def={m} />)}
          </div>
        </Fragment>
      ))}
    </>
  );
}

function Tarjeta({ def }: { def: any }) {
  const { agregarModulo, quitarDelCatalogo } = acciones();
  const etiqueta = def.programmable ? 'programable' : (!def.builtin ? 'importado' : null);

  return (
    <div className="card-wrap">
      <button
        type="button"
        className="modulo-card"
        draggable
        data-type={def.type}
        title={def.description ?? def.name}
        onClick={() => agregarModulo(def.type)}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/x-modulo', def.type);
          e.dataTransfer.effectAllowed = 'copy';
        }}
      >
        <Miniatura def={def} />
        <span>{def.name}</span>
        {etiqueta && (
          <small
            className={def.programmable ? 'tag-programable' : 'tag-importado'}
            title={def.origin ? `Importado desde ${def.origin.from}` : undefined}
          >
            {etiqueta}
          </small>
        )}
      </button>
      {/* La tarjeta es un botón: el "quitar" va al lado, porque un botón no puede ir dentro de otro. */}
      {!def.builtin && (
        <button
          type="button"
          className="card-quitar"
          title={`Quitar "${def.name}" del catálogo`}
          aria-label={`Quitar "${def.name}" del catálogo`}
          onClick={() => quitarDelCatalogo(def)}
        >
          ×
        </button>
      )}
    </div>
  );
}
