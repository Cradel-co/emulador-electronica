import { Component, createContext, lazy, Suspense, useContext, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import type { MDXComponents } from 'mdx/types';
import { leccionesMdx, type LeccionMdx as DatosLeccion, RUTA_PILOTO } from '../aprendizaje/piloto.js';
import { almacenLocalAprendizaje, progresoDeLeccion, registroDeLeccion } from '../aprendizaje/progreso.js';
import { acciones, estado } from './puente.js';
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
function Circuito({ ejemplo = 'ohm' }: { ejemplo?: DatosLeccion['ejemploId'] }) {
  const paralelo = ejemplo === 'paralelo' || ejemplo === 'divisor-cargado';
  return <figure className="mdx-circuito"><svg viewBox="0 0 480 230" role="img" aria-label={`Esquema del circuito ${ejemplo}: fuente de 5 V y resistencias conectadas ${paralelo ? 'con ramas en paralelo' : 'en serie'}`}>
    <g fill="none" stroke="currentColor" strokeWidth="2"><path d={ejemplo === 'paralelo' ? "M65 95V40h355v60m0 65v25H65v-55" : ejemplo === 'ohm' ? "M65 95V40h125m75 0h155v150H65v-55" : "M65 95V40h125m75 0h155v60m0 65v25H65v-55"} /><circle cx="65" cy="115" r="22" /><path d="M57 107h16m-8-8v16m-8 10h16" />{ejemplo !== 'paralelo' && <rect x="190" y="30" width="75" height="20" />}
    {paralelo && <><path d="M300 40v60m0 65v25" /><rect x="290" y="100" width="20" height="65" /><rect x="410" y="100" width="20" height="65" /></>}
    {ejemplo === 'serie' && <rect x="410" y="100" width="20" height="65" />}</g>
    <g fill="currentColor" fontSize="14"><text x="22" y="160">5 V</text>{ejemplo !== 'paralelo' && <text x="196" y="22">R1 · 1 kΩ</text>}{paralelo && <><text x="230" y="140">{ejemplo === 'paralelo' ? 'R1 · 1 kΩ' : 'R2 · 1 kΩ'}</text><text x="353" y="213">{ejemplo === 'paralelo' ? 'R2 · 2 kΩ' : 'R3 · 1 kΩ'}</text></>}{ejemplo === 'serie' && <text x="336" y="140">R2 · 1 kΩ</text>}</g>
  </svg><figcaption>{ejemplo === 'paralelo' ? 'En paralelo, R1 y R2 comparten ambos nodos. Abrí el ejemplo para ver sus conexiones.' : 'Esquema orientativo. Los identificadores coinciden con la práctica del emulador.'}</figcaption></figure>;
}
function Actividad() {
  const leccion = useContext(ContextoLeccion);
  const dialogo = useRef<HTMLDialogElement>(null);
  const [nombre, setNombre] = useState('');
  const creando = useEstado(() => estado().creandoPracticaAprendizaje as boolean);
  useEstado(() => estado().revisionProgresoAprendizaje as number);
  if (!leccion) return null;
  const registro = registroDeLeccion(almacenLocalAprendizaje(), leccion.id);
  return <section className="mdx-actividad"><span className="aprender-eyebrow">LABORATORIO</span><h3>Predecí, simulá y compará</h3>
    <ol><li>Anotá tu predicción antes de abrir la práctica.</li><li>Presioná ▶ para encender la fuente. Abrí Debug → Alimentación y consumo. Desplegá Componentes para ver ΔV, mA y P, y Tensión por pin para consultar cada nodo.</li><li>Compará con estos valores. Después cambiá una resistencia y repetí el cálculo.</li></ol>
    <table><caption>Valores esperados del ejemplo original en régimen DC</caption><thead><tr><th>Magnitud</th><th>Predicción</th></tr></thead><tbody>{leccion.observaciones.map(item => <tr key={item.magnitud}><td>{item.magnitud}</td><td>{item.valor}</td></tr>)}</tbody></table>
    <p>Estos valores son ideales: la simulación puede mostrar pequeñas diferencias numéricas por el modelo de la fuente. Compará usando su tensión de salida medida. La fuente comienza apagada y la práctica crea una copia editable en tus proyectos.</p>
    <div className="mdx-acciones"><button className="primario" disabled={creando} onClick={() => { setNombre(`practica-${leccion.ejemploId}`); dialogo.current?.showModal(); }}>{creando ? 'Creando práctica…' : 'Abrir ejemplo en el emulador'}</button>{registro?.proyectoNombre && <button disabled={creando} onClick={() => acciones().continuarPracticaAprendizaje(leccion.id)}>Continuar práctica</button>}</div>
    <dialog ref={dialogo} className="mdx-dialogo"><form onSubmit={event => { event.preventDefault(); dialogo.current?.close(); acciones().crearPracticaAprendizaje(leccion.ejemploId, nombre); }}><h3>Crear tu práctica</h3><label>Nombre del proyecto<input autoFocus required pattern="[a-z0-9][a-z0-9-]{0,39}" maxLength={40} value={nombre} onChange={event => setNombre(event.target.value)} /></label><p>Usá letras minúsculas, números y guiones.</p><div className="mdx-acciones"><button type="button" onClick={() => dialogo.current?.close()}>Cancelar</button><button type="submit" className="primario">Crear y abrir</button></div></form></dialog>
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
    return <a href={`#/aprender/${leccion.id}`} key={leccion.id} aria-current={actual === leccion.id ? 'page' : undefined}><span>{progreso?.completada ? '✓' : indice + 1}</span><div><strong>{leccion.titulo}</strong><p>{leccion.descripcion}</p><small>{leccion.minutos} min · {progreso?.completada ? 'Completada' : progreso ? 'En curso' : 'Disponible'}</small></div></a>;
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
