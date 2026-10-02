import { PanelModulo } from './PanelModulo.js';
import { useEstado, useVersion } from './estado.js';
import { acciones, estado, vistas } from './puente.js';
import { nombreRef } from '../consultas.js';

/**
 * El panel de la derecha (`#panel-modulo`): según lo que esté seleccionado, muestra el módulo, el
 * cable, o qué es un proyecto sin placa.
 *
 * Migrado a React (#9). Eran 190 líneas de `innerHTML` con handlers enganchados a mano después de
 * cada repintado. Las preguntas sobre el dibujo salen de `consultas.ts` (puro, probado) y los
 * efectos van por el puente.
 *
 * El panel de código (el editor) sigue siendo imperativo: se repinta en cada tecla, con resaltado
 * de sintaxis. Quién de los dos se ve lo decide `app.ts`, que es el que sabe del editor.
 */
export function PanelDerecho() {
  useVersion();
  const seleccion = useEstado(() => estado().seleccion);
  const diagrama = estado().diagrama;
  const catalogo = estado().catalogo as Map<string, any>;

  const inst = seleccion?.tipo === 'modulo' ? diagrama.modules.find((m: any) => m.id === seleccion.id) : null;
  const def = inst ? catalogo.get(inst.type) : null;

  // Sin placa no hay código: en su lugar, qué es este proyecto y cómo sumarle una placa.
  const muestraCodigo = !seleccion || (seleccion.tipo === 'modulo' && (!inst || def?.programmable));
  if (muestraCodigo) return vistas().sinPlaca() ? <SinPlaca /> : null;

  if (seleccion.tipo === 'cable') return <PanelCable indice={seleccion.indice} />;
  if (!def) return <Desconocido inst={inst} />;
  return <PanelModulo inst={inst} def={def} />;
}

function SinPlaca() {
  const on = useEstado(() => estado().energizado as boolean);
  return (
    <>
      <h2 className="panel-header">Circuito sin placa</h2>
      <div className="insp">
        <p className="insp-desc">
          Un circuito como en una protoboard: fuentes regulables y componentes, sin microcontrolador
          ni código. Cerrá cada camino contra el <b>GND de la fuente</b>.
        </p>
        <div className={`insp-badge${on ? '' : ' advertencia'}`}>
          {on
            ? <><b>Energizado</b> — las fuentes entregan tensión: usá los pulsadores e interruptores. ⏹ lo apaga.</>
            : <><b>Apagado</b> — las fuentes no entregan nada. ▶ energiza el circuito.</>}
        </div>
        <h3>Placa</h3>
        <p className="hint">
          Si querés programar algo, agregá una placa (o arrastrala desde el catálogo): elegís en qué
          lenguaje y aparece su código.
        </p>
        <button type="button" id="sp-agregar-placa" className="primario" onClick={() => acciones().agregarPlaca()}>
          Agregar placa
        </button>
      </div>
    </>
  );
}

function PanelCable({ indice }: { indice: number }) {
  useVersion();
  const diagrama = estado().diagrama;
  const catalogo = estado().catalogo as Map<string, any>;
  const w = diagrama.wires[indice];
  if (!w) return null;
  const nombre = (ref: string) => nombreRef(ref, diagrama.modules, (t) => catalogo.get(t), vistas().nombrePlaca());

  return (
    <>
      <h2 className="panel-header">Cable</h2>
      <div className="insp">
        <p className="insp-conexion"><b>{nombre(w.from)}</b><span>↔</span><b>{nombre(w.to)}</b></p>
        <button className="peligro" id="insp-borrar-cable" onClick={() => acciones().eliminarCable(indice)}>
          Eliminar cable
        </button>
        <p className="hint">También podés seleccionarlo y apretar Supr.</p>
      </div>
    </>
  );
}

function Desconocido({ inst }: { inst: any }) {
  return (
    <>
      <h2 className="panel-header">Módulo desconocido <span className="sub">· {inst.id}</span></h2>
      <div className="insp">
        <div className="insp-badge aire">
          El tipo <b>{inst.type}</b> no está en el catálogo (¿se quitó?). Podés volver a importarlo o
          eliminarlo del circuito.
        </div>
        <button className="peligro" id="insp-eliminar" onClick={() => acciones().eliminarModulo(inst.id)}>
          Eliminar módulo
        </button>
      </div>
    </>
  );
}
