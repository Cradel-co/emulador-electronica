import { Component, createContext, lazy, Suspense, useContext, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import type { MDXComponents } from 'mdx/types';
import { leccionesMdx, type LeccionMdx as DatosLeccion, RUTA_PILOTO } from '../aprendizaje/piloto.js';
import { almacenLocalAprendizaje, progresoDeLeccion, registroDeLeccion } from '../aprendizaje/progreso.js';
import { acciones, estado } from './puente.js';
import { CircuitoAprendizaje as Circuito } from './CircuitoAprendizaje.js';
import { ejemploPorId, observacionesEjemplo, type EjemploId } from '../aprendizaje/ejemplos.js';
import { useEstado } from './estado.js';

/** Registro explícito: solamente se compila contenido editorial versionado en el repositorio. */
const documentos = {
  'magnitudes-dc': lazy(() => import('../aprendizaje/lecciones/magnitudes-dc.mdx')),
  'ley-ohm': lazy(() => import('../aprendizaje/lecciones/ley-ohm.mdx')),
  'redes-resistivas': lazy(() => import('../aprendizaje/lecciones/redes-resistivas.mdx')),
  'kirchhoff-corrientes': lazy(() => import('../aprendizaje/lecciones/kirchhoff-corrientes.mdx')),
  'kirchhoff-tensiones': lazy(() => import('../aprendizaje/lecciones/kirchhoff-tensiones.mdx')),
  'tellegen-potencia': lazy(() => import('../aprendizaje/lecciones/tellegen-potencia.mdx')),
};
const ContextoLeccion = createContext<DatosLeccion | null>(null);

function Aviso({ titulo, children }: { titulo: string; children: ReactNode }) {
  return <aside className="mdx-aviso"><strong>{titulo}</strong><div>{children}</div></aside>;
}
function Formula({ children, descripcion }: { children: ReactNode; descripcion?: string }) {
  return <figure className="mdx-formula"><div>{children}</div>{descripcion && <figcaption>{descripcion}</figcaption>}</figure>;
}
function Ejemplo({ titulo, children }: { titulo: string; children: ReactNode }) {
  return <section className="mdx-ejemplo"><h3>{titulo}</h3>{children}</section>;
}
function Pregunta({ titulo, respuesta }: { titulo: string; respuesta: string }) {
  return <section className="mdx-pregunta"><h3>Comprobá lo aprendido</h3><p>{titulo}</p><details><summary>Ver explicación</summary><p>{respuesta}</p></details></section>;
}
function Actividad({ ejemplo }: { ejemplo?: EjemploId }) {
  const leccion = useContext(ContextoLeccion);
  const dialogo = useRef<HTMLDialogElement>(null);
  const [nombre, setNombre] = useState('');
  const creando = useEstado(() => estado().creandoPracticaAprendizaje as boolean);
  useEstado(() => estado().revisionProgresoAprendizaje as number);
  if (!leccion) return null;
  const ejemploId = ejemplo ?? leccion.ejemploId;
  const circuito = ejemploPorId(ejemploId);
  const observaciones = circuito ? observacionesEjemplo(circuito) : leccion.observaciones;
  const registro = registroDeLeccion(almacenLocalAprendizaje(), leccion.id);
  return <section className="mdx-actividad" data-ejemplo={ejemploId}><span className="aprender-eyebrow">LABORATORIO</span><h3>Predecí, simulá y compará</h3><p><strong>{circuito?.titulo}</strong></p>
    <ol><li>Anotá tu predicción antes de abrir la práctica.</li><li>Presioná ▶ para encender la fuente. Abrí Debug → Alimentación y consumo. Desplegá Componentes para ver ΔV, mA y P, y Tensión por pin para consultar cada nodo.</li><li>Compará con estos valores. Después cambiá una resistencia y repetí el cálculo.</li></ol>
    <table><caption>Valores esperados del ejemplo original en régimen DC</caption><thead><tr><th>Magnitud</th><th>Predicción</th></tr></thead><tbody>{observaciones.map(item => <tr key={item.magnitud}><td>{item.magnitud}</td><td>{item.valor}</td></tr>)}</tbody></table>
    <p>Estos valores son ideales: la simulación puede mostrar pequeñas diferencias numéricas por el modelo de la fuente. Compará usando su tensión de salida medida. La fuente comienza apagada y la práctica crea una copia editable en tus proyectos.</p>
    {!ejemplo && registro?.proyectoNombre && <p>Última práctica de esta lección: <strong>{registro.proyectoNombre}</strong>.</p>}
    <div className="mdx-acciones"><button className="primario" disabled={creando} onClick={() => { setNombre(`practica-${ejemploId}`); dialogo.current?.showModal(); }}>{creando ? 'Creando práctica…' : ejemplo ? 'Abrir variante en el emulador' : 'Abrir ejemplo en el emulador'}</button>{!ejemplo && registro?.proyectoNombre && <button disabled={creando} onClick={() => acciones().continuarPracticaAprendizaje(leccion.id)}>Continuar práctica</button>}</div>
    <dialog ref={dialogo} className="mdx-dialogo"><form onSubmit={event => { event.preventDefault(); dialogo.current?.close(); acciones().crearPracticaAprendizaje(ejemploId, nombre); }}><h3>Crear tu práctica</h3><label>Nombre del proyecto<input autoFocus required pattern="[a-z0-9][a-z0-9-]{0,39}" maxLength={40} value={nombre} onChange={event => setNombre(event.target.value)} /></label><p>Usá letras minúsculas, números y guiones.</p><div className="mdx-acciones"><button type="button" onClick={() => dialogo.current?.close()}>Cancelar</button><button type="submit" className="primario">Crear y abrir</button></div></form></dialog>
  </section>;
}
const componentes: MDXComponents = { Aviso, Formula, Ejemplo, Pregunta, Circuito, Actividad };
class ErrorContenido extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* El error de carga se representa dentro de la lección. */ }
  render() { return this.state.error ? <p role="alert">No se pudo cargar la lección. <button onClick={() => window.location.reload()}>Reintentar</button></p> : this.props.children; }
}

export function IndiceMdx() {
  useEstado(() => estado().revisionProgresoAprendizaje as number);
  const actual = useEstado(() => (estado().aprendizajeRuta as { leccion?: string } | null)?.leccion);
  return <nav className="mdx-indice" aria-label="Lecciones de la ruta">{leccionesMdx.map((leccion, indice) => {
    const progreso = progresoDeLeccion(almacenLocalAprendizaje(), leccion.id, leccion.revision);
    const registro = registroDeLeccion(almacenLocalAprendizaje(), leccion.id);
    return <a href={`#/aprender/${leccion.id}`} key={leccion.id} aria-current={actual === leccion.id ? 'page' : undefined}><span>{progreso?.completada ? '✓' : indice + 1}</span><div><strong>{leccion.titulo}</strong><p>{leccion.descripcion}</p><small>{leccion.minutos} min · {progreso?.completada ? 'Completada' : progreso ? 'En curso' : registro ? 'Pendiente de revisar' : 'Disponible'}</small></div></a>;
  })}</nav>;
}

export function LeccionMdx({ leccion }: { leccion: DatosLeccion }) {
  const titulo = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titulo.current?.focus(); }, [leccion.id]);
  const Documento = documentos[leccion.id as keyof typeof documentos];
  const indice = leccionesMdx.findIndex(item => item.id === leccion.id);
  const anterior = leccionesMdx[indice - 1];
  return <ContextoLeccion.Provider value={leccion}><a className="aprender-volver" href={`#/aprender/rutas/${RUTA_PILOTO}`}>← Volver al recorrido</a><header className="aprender-intro"><span className="aprender-eyebrow">LECCIÓN {indice + 1} DE {leccionesMdx.length} · {leccion.minutos} MIN</span><h1 ref={titulo} tabIndex={-1}>{leccion.titulo}</h1><p>{leccion.descripcion}</p></header>
    <div className="aprender-leccion-layout"><aside className="aprender-indice"><h2>Tu recorrido</h2><IndiceMdx /></aside><article className="mdx-contenido">{leccion.requisitos.length > 0 && <p className="mdx-requisitos">Antes de empezar: {leccion.requisitos.map(id => { const requisito = leccionesMdx.find(item => item.id === id); return <a key={id} href={`#/aprender/${id}`}>{requisito?.titulo}</a>; })}</p>}
      <ErrorContenido key={leccion.id}><Suspense fallback={<p role="status">Cargando lección…</p>}>{Documento ? <Documento components={componentes} /> : <p>El contenido todavía no está disponible.</p>}</Suspense></ErrorContenido>
      <footer className="mdx-acciones">{anterior && <a href={`#/aprender/${anterior.id}`}>← Lección anterior</a>}<button className="primario" onClick={() => acciones().completarAprendizaje(leccion.id, leccion.revision, 'contenido')}>{indice === leccionesMdx.length - 1 ? 'Completar recorrido' : 'Completar y continuar'}</button></footer>
    </article></div></ContextoLeccion.Provider>;
}
