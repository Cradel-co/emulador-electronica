import { riesgoDesdeFisica } from '../estado-electrico.js';
import { SeccionCamara } from './SeccionCamara.js';
import { Miniatura } from './Miniatura.js';
import { SeccionChip } from './SeccionChip.js';
import { useEstado, useVersion } from './estado.js';
import { acciones, estado, vistas } from './puente.js';
import { cablesDe, NOMBRE_KIND, nombreRef, pinesSinAlimentar } from '../consultas.js';

/** Qué control tiene este módulo en la simulación, si tiene alguno. */
function controlDe(def: any): 'momentary' | 'toggle' | 'botonera' | 'puerta' | null {
  const kind = def.controls?.[0]?.kind;
  if (def.bridge?.role === 'input' && kind === 'momentary') return 'momentary';
  if (def.bridge?.role === 'input' && kind === 'toggle') return 'toggle';
  if (def.type === 'remote-433') return 'botonera';
  if (def.type === 'door-sensor-433') return 'puerta';
  return null;
}

/** El panel del módulo seleccionado: qué es, cómo está cableado, cómo se configura y se acciona. */
export function PanelModulo({ inst, def }: { inst: any; def: any }) {
  // `diagrama` y los Map de `sim` se mutan en el lugar: el snapshot tiene que ser la versión.
  useVersion();
  const diagrama = estado().diagrama;
  const esAire = def.bridge?.role === 'air';
  const sinPlaca = vistas().sinPlaca();
  // Chips del módulo que están en el catálogo (#24): si tiene, el badge lo cuenta.
  const chips = ((def?.chips ?? []) as { id: string }[])
    .map((u) => (estado().chips as Map<string, any>).get(u.id))
    .filter(Boolean);
  const lectura = estado().electrico.get(inst.id);
  const riesgo = riesgoDesdeFisica({ valida: estado().fisicaValida, led: lectura });
  const faltan = pinesSinAlimentar(inst, def, diagrama.wires);
  const control = controlDe(def);

  return (
    <>
      <h2 className="panel-header">{def.name} <span className="sub">· {inst.id}</span></h2>
      <div className="insp">
        <div className="insp-mini"><Miniatura def={def} /></div>
        <p className="insp-desc">{def.description ?? ''}</p>
        <div className={`insp-badge${esAire ? ' aire' : ''}`}>
          {def.camera
            ? def.camera.hardware ? <><b>ArduCAM</b> — conectá alimentación, I2C y SPI; activá la webcam antes de ejecutar el firmware.</> : <><b>Cámara virtual</b> — usa la webcam del computador; funciona sin cables, alimentación ni firmware.</>
            : def.programmable
            ? <><b>Placa programable</b> — su código se edita en la ventana Código. Estas propiedades pertenecen a esta placa.</>
            : esAire
            ? <><b>Inalámbrico</b> — no se programa ni lleva cables: se comunica por radio 433 MHz con el receptor o transmisor conectado a la {vistas().nombrePlaca()}.</>
            : chips.length > 0
              ? <><b>Con chip</b> — adentro tiene {chips.map((c) => `un ${c.nombre}`).join(' y ')} que habla{chips.length > 1 ? 'n' : ''} por su bus con el código de la {vistas().nombrePlaca()}: se emula su lógica, no solo su consumo.</>
              : sinPlaca
                ? <><b>Sin código</b> — se cablea al circuito; con ▶ se energiza y funciona por la corriente que le llega.</>
                : <><b>Sin código</b> — este módulo no se programa: se conecta a la {vistas().nombrePlaca()} con cables y el código de la placa lo controla.</>}
        </div>

        {riesgo && (
          <div className="insp-badge advertencia">
            <b>Riesgo de sobrecorriente</b>: circulan ~{Math.round(lectura?.mA ?? 0)} mA.
            Supera el límite configurado del modelo. El LED sigue conduciendo;
            no se simula su temperatura ni una avería permanente. Revisá la resistencia en serie.
          </div>
        )}

        {!estado().fisicaValida && (
          <div className="insp-badge advertencia">
            <b>Sin medición eléctrica válida</b>: no se puede confirmar el estado físico del módulo.
          </div>
        )}

        {faltan.length > 0 && (
          <div className="insp-badge advertencia">
            ⚠ <b>Sin alimentación</b> — conectá también {faltan.join(' y ')}: sin eso no funciona en la simulación, como en la vida real.
          </div>
        )}

        {def.camera && <SeccionCamara key={`${estado().proyecto.name}:${inst.id}`} project={estado().proyecto.name} instance={inst.id} camera={def.camera} />}
        <SeccionChip inst={inst} def={def} />

        {control && <Controles inst={inst} def={def} control={control} />}

        {def.pins.length > 0 && <Pines inst={inst} def={def} />}

        <h3>Rotación</h3>
        <Rotacion inst={inst} />

        {Object.keys(def.props ?? {}).length > 0 && <Propiedades inst={inst} def={def} />}

        <button className="peligro" id="insp-eliminar" onClick={() => acciones().eliminarModulo(inst.id)}>
          {def.programmable ? 'Quitar la placa' : 'Eliminar módulo'}
        </button>
      </div>
    </>
  );
}

/** Los controles de simulación: el pulsador, la llave, la botonera del remoto, la puerta. */
function Controles({ inst, def, control }: { inst: any; def: any; control: string }) {
  useVersion();
  const listo = estado().sim.listo as boolean;
  const presionado = estado().panelPresionado;
  const cerrado = Boolean(estado().sim.controles.get(inst.id));
  const { controlModulo, presionarMomentario } = acciones();

  return (
    <>
      <h3>Simulación</h3>
      <div className={`insp-control${listo ? '' : ' deshabilitado'}`}>
        {control === 'momentary' && (
          <button
            type="button"
            className={`btn-accionar${presionado?.id === inst.id ? ' activo' : ''}`}
            data-accion="momentary"
            onMouseDown={(e) => { e.preventDefault(); presionarMomentario(inst); }}
            onTouchStart={(e) => { e.preventDefault(); presionarMomentario(inst); }}
          >
            Mantener presionado
          </button>
        )}
        {control === 'toggle' && (
          <button type="button" className={`btn-accionar${cerrado ? ' activo' : ''}`} data-accion="toggle"
            onClick={() => controlModulo(inst, 'toggle', 0)}>
            {cerrado ? 'Apagar' : 'Encender'}
          </button>
        )}
        {control === 'puerta' && (
          <button type="button" className={`btn-accionar${cerrado ? ' activo' : ''}`} data-accion="toggle"
            onClick={() => controlModulo(inst, 'toggle', 0)}>
            {cerrado ? 'Cerrar puerta' : 'Abrir puerta'}
          </button>
        )}
        {control === 'botonera' && (
          <div className="botonera-remoto">
            {['A', 'B', 'C', 'D'].map((l, i) => (
              <button key={l} type="button" className="btn-accionar" data-accion="boton" data-indice={i}
                onClick={() => controlModulo(inst, 'boton', i)}>
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="hint">
        {listo ? 'También podés tocar el dibujo del módulo en el circuito.' : vistas().textoEsperaSimulacion()}
      </p>
    </>
  );
}

/** La tabla de pines: tipo de cada uno y a dónde va, con el botón de desconectar. */
function Pines({ inst, def }: { inst: any; def: any }) {
  useVersion();
  const diagrama = estado().diagrama;
  const catalogo = estado().catalogo as Map<string, any>;
  const buscar = (t: string) => catalogo.get(t);
  const nombre = vistas().nombrePlaca();

  return (
    <>
      <h3>Pines</h3>
      <table className="insp-pines"><tbody>
        {def.pins.map((p: any) => {
          const ref = `${inst.id}.${p.name}`;
          const conectados = cablesDe(ref, diagrama.wires);
          return (
            <tr key={p.name}>
              <td className={`pin-nombre ${p.kind}`}>{p.name}</td>
              <td className="pin-kind">{NOMBRE_KIND[p.kind] ?? p.kind}</td>
              <td>
                {conectados.length === 0
                  ? <span className="sin">sin conectar</span>
                  : conectados.map((w) => {
                    const otro = w.from === ref ? w.to : w.from;
                    const i = diagrama.wires.indexOf(w);
                    return (
                      <span className="conexion" key={`${w.from}-${w.to}`}>
                        → {nombreRef(otro, diagrama.modules, buscar, nombre)}
                        <button className="quitar" data-cable={i} title="Desconectar"
                          onClick={() => acciones().desconectar(i)}>×</button>
                      </span>
                    );
                  })}
              </td>
            </tr>
          );
        })}
      </tbody></table>
      <p className="hint">
        Para cablear: click en un pin del módulo en el circuito y después en {vistas().sinPlaca()
          ? 'otro pin (cerrá los caminos contra el GND de la fuente)'
          : `un pin de la ${nombre}`}.
      </p>
    </>
  );
}

/** Girar el módulo: de a 90° con los botones, a cualquier ángulo con el rango o escribiendo. */
function Rotacion({ inst }: { inst: any }) {
  const grados = ((inst.rotation ?? 0) % 360 + 360) % 360;
  const { girar } = acciones();

  return (
    <div className="insp-rotacion">
      <button type="button" data-girar="-90" title="Girar 90° a la izquierda (Shift+R)" aria-label="Girar a la izquierda"
        onClick={() => girar(inst, grados - 90, true)}>⟲</button>
      <input type="range" min={0} max={359} step={1} value={grados} data-rotacion-rango aria-label="Ángulo"
        onChange={(e) => girar(inst, Number(e.target.value), false)}
        onMouseUp={(e) => girar(inst, Number((e.target as HTMLInputElement).value), true)}
        onKeyUp={(e) => girar(inst, Number((e.target as HTMLInputElement).value), true)} />
      <label className="grados">
        <input type="number" min={0} max={359} value={grados} data-rotacion aria-label="Grados"
          onChange={(e) => girar(inst, Number(e.target.value) || 0, true)} />°
      </label>
      <button type="button" data-girar="90" title="Girar 90° a la derecha (R)" aria-label="Girar a la derecha"
        onClick={() => girar(inst, grados + 90, true)}>⟳</button>
    </div>
  );
}

/** Las propiedades editables del módulo (color del LED, ohms de la resistencia, etiqueta...). */
function Propiedades({ inst, def }: { inst: any; def: any }) {
  const { cambiarProp } = acciones();

  return (
    <>
      <h3>Propiedades</h3>
      <div className="insp-props">
        {Object.entries(def.props as Record<string, any>).map(([k, p]) => {
          const valor = inst.props?.[k] ?? p.default ?? '';
          const etiqueta = p.label ?? k;
          if (p.enum) {
            return (
              <label key={k}>{etiqueta}
                <select data-prop={k} value={String(valor)} onChange={(e) => cambiarProp(inst, k, e.target.value)}>
                  {p.enum.map((o: string) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            );
          }
          if (p.type === 'boolean') {
            return (
              <label key={k} className="check">
                <input type="checkbox" data-prop={k} checked={Boolean(valor)}
                  onChange={(e) => cambiarProp(inst, k, e.target.checked)} />
                {' '}{etiqueta}
              </label>
            );
          }
          return (
            <label key={k}>{etiqueta}
              <input
                type={p.type === 'number' ? 'number' : 'text'}
                data-prop={k}
                defaultValue={String(valor)}
                key={`${inst.id}-${k}-${String(valor)}`}
                onChange={(e) => cambiarProp(inst, k, p.type === 'number' ? Number(e.target.value) : e.target.value)}
              />
            </label>
          );
        })}
      </div>
    </>
  );
}
