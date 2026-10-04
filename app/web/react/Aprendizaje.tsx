import { Aprender } from './Aprender.js';
import { LeccionMdx } from './LeccionMdx.js';
import { leccionMdxPorId } from '../aprendizaje/piloto.js';
import { aprendizaje } from './aprendizaje-estado.js';
import { useEffect, useRef } from 'react';
import { acciones, estado } from './puente.js';
import { useEstado } from './estado.js';
import { contenidoAprendizaje, leccionPorId, type BloqueAprendizaje } from '../aprendizaje/contenido.js';
import { almacenLocalAprendizaje, progresoDeLeccion, registroDeLeccion } from '../aprendizaje/progreso.js';

function Bloque({ bloque }: { bloque: BloqueAprendizaje }) {
  switch (bloque.tipo) {
    case 'parrafo': return <p>{bloque.texto}</p>;
    case 'lista': return <ul>{bloque.elementos.map((elemento, i) => <li key={i}>{elemento}</li>)}</ul>;
    case 'aviso': return <aside className="aprendizaje-aviso"><b>{bloque.titulo}</b><p>{bloque.texto}</p></aside>;
    case 'codigo': return <pre><code>{bloque.texto}</code></pre>;
    case 'figura': return <figure><img src={bloque.origen} alt={bloque.alt} />{bloque.descripcion && <figcaption>{bloque.descripcion}</figcaption>}</figure>;
  }
}

export function Aprendizaje() {
  const catalogo = useEstado(() => aprendizaje.route);
  const ruta = useEstado(() => estado().aprendizajeRuta as { leccion?: string; paso?: string } | null);
  useEstado(() => estado().revisionProgresoAprendizaje as number);
  const creandoPractica = useEstado(() => estado().creandoPracticaAprendizaje as boolean);
  const encabezado = useRef<HTMLHeadingElement>(null);
  const tituloPaso = useRef<HTMLHeadingElement>(null);
  const rutaAnterior = useRef<{ leccion?: string; paso?: string } | null>(null);
  const claveRuta = ruta ? `${ruta.leccion ?? ''}\u0000${ruta.paso ?? ''}` : null;

  useEffect(() => {
    if (!ruta) return;
    const anterior = rutaAnterior.current;
    const cambioDePaso = Boolean(ruta.leccion && anterior?.leccion === ruta.leccion && anterior.paso !== ruta.paso);
    (cambioDePaso ? tituloPaso.current : encabezado.current)?.focus();
    rutaAnterior.current = { ...ruta };
  }, [claveRuta]);

  if (!ruta) return null;

  const mdx = ruta.leccion ? leccionMdxPorId(ruta.leccion) : undefined;
  if (mdx) return <LeccionMdx leccion={mdx} />;
  if (catalogo.learning) return <Aprender />;

  if (!ruta.leccion) {
    const lecciones = contenidoAprendizaje.filter(item => !leccionMdxPorId(item.id)).sort((a, b) => a.orden - b.orden);
    return (
      <>
        <Aprender />
        <section className="aprender-seccion"><h2>Tu primera práctica con un LED</h2>
        <div className="aprendizaje-lista">
          {lecciones.map(leccion => {
            const progreso = progresoDeLeccion(almacenLocalAprendizaje(), leccion.id, leccion.revision);
            const registro = registroDeLeccion(almacenLocalAprendizaje(), leccion.id);
            const pendienteRevision = Boolean(registro && registro.revision !== leccion.revision);
            return (
              <article className="aprendizaje-tarjeta" key={leccion.id}>
                <div><span>{leccion.nivel === 'inicial' ? 'Inicial' : leccion.nivel}</span><span>{leccion.duracionMinutos} min</span>
                  {pendienteRevision && <span>Pendiente de revisar</span>}
                  {!pendienteRevision && progreso?.completada && <span>Completada</span>}
                  {!pendienteRevision && progreso && !progreso.completada && <span>En curso</span>}</div>
                <h2>{leccion.titulo}</h2><p>{leccion.resumen}</p>
                <button className="primario" type="button" onClick={() => acciones().navegarAprendizaje(leccion.id)}>
                  {pendienteRevision ? 'Revisar lección' : progreso ? 'Continuar lección' : 'Empezar lección'}
                </button>
                {registro?.proyectoNombre && <button type="button" onClick={() => acciones().continuarPracticaAprendizaje(leccion.id)}>Continuar práctica</button>}
              </article>
            );
          })}
        </div></section>
      </>
    );
  }

  const leccion = leccionPorId(ruta.leccion);
  if (!leccion) {
    return <div className="aprendizaje-pagina"><h1 ref={encabezado} tabIndex={-1}>Lección no encontrada</h1><button onClick={() => acciones().navegarAprendizaje()}>Volver a Aprender</button></div>;
  }
  const indice = Math.max(0, leccion.pasos.findIndex(paso => paso.id === ruta.paso));
  const paso = leccion.pasos[indice];
  if (!paso) return <div className="aprendizaje-pagina"><h1 ref={encabezado} tabIndex={-1}>Esta lección todavía no tiene pasos.</h1></div>;
  const anterior = leccion.pasos[indice - 1];
  const siguiente = leccion.pasos[indice + 1];
  const practica = leccion.practica;
  return (
    <div className="aprendizaje-pagina aprendizaje-leccion">
      <header className="aprendizaje-cabecera">
        <button type="button" onClick={() => acciones().navegarAprendizaje()}>‹ Todas las lecciones</button>
        <p>{leccion.nivel === 'inicial' ? 'INICIAL' : leccion.nivel.toUpperCase()} · {leccion.duracionMinutos} MIN</p>
        <h1 ref={encabezado} tabIndex={-1}>{leccion.titulo}</h1><p>{leccion.resumen}</p>
      </header>
      <div className="aprendizaje-cuerpo">
        <nav aria-label="Pasos de la lección" className="aprendizaje-pasos">
          {leccion.pasos.map((item, i) => (
            <button key={item.id} type="button" aria-current={i === indice ? 'step' : undefined}
              onClick={() => acciones().navegarAprendizaje(leccion.id, item.id)}>
              <span>{i + 1}</span>{item.titulo}
            </button>
          ))}
        </nav>
        <article className="aprendizaje-contenido">
          <p className="aprendizaje-progreso">Paso {indice + 1} de {leccion.pasos.length}</p>
          <h2 ref={tituloPaso} tabIndex={-1}>{paso.titulo}</h2>
          {paso.bloques.map((bloque, i) => <Bloque key={`${paso.id}-${i}`} bloque={bloque} />)}
          {paso.resultadoEsperado && <aside className="aprendizaje-resultado"><b>Qué observar</b><p>{paso.resultadoEsperado}</p></aside>}
          {siguiente === undefined && practica && (
            <aside className="aprendizaje-practica">
              <h3>Probalo en el emulador</h3>
              <p>Creá un proyecto independiente con el circuito de esta lección.</p>
              <button className="primario" type="button" disabled={creandoPractica} onClick={() => acciones().crearPracticaAprendizaje(practica.templateId)}>
                {creandoPractica ? 'Creando práctica…' : 'Abrir práctica'}
              </button>
            </aside>
          )}
          <footer>
            <button type="button" disabled={!anterior} onClick={() => anterior && acciones().navegarAprendizaje(leccion.id, anterior.id)}>Anterior</button>
            {siguiente
              ? <button className="primario" type="button" onClick={() => acciones().navegarAprendizaje(leccion.id, siguiente.id)}>Siguiente</button>
              : <button className="primario" type="button" onClick={() => acciones().completarAprendizaje(leccion.id, leccion.revision, paso.id)}>Terminar lección</button>}
          </footer>
        </article>
      </div>
    </div>
  );
}
