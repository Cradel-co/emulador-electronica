import { PanelModulo } from './PanelModulo.js';
import { useEstado, useVersion } from './estado.js';
import { acciones, estado, vistas } from './puente.js';
import { nombreRef } from '../consultas.js';

/** Contenido de la ventana Detalle: componente, cable o explicación del circuito sin placa. */
export function PanelDerecho() {
  useVersion();
  const seleccion = useEstado(() => estado().seleccion);
  const diagrama = estado().diagrama;
  const catalogo = estado().catalogo as Map<string, any>;

  const inst = seleccion?.tipo === 'modulo' ? diagrama.modules.find((m: any) => m.id === seleccion.id) : null;
  const def = inst ? catalogo.get(inst.type) : null;

  if (!seleccion || (seleccion.tipo === 'modulo' && !inst)) {
    return vistas().sinPlaca() ? <SinPlaca /> : <p className="insp">Seleccioná un componente o un cable del circuito para ver sus propiedades.</p>;
  }

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
