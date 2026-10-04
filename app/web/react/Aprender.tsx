import { useState, type CSSProperties } from 'react';
import { temasAprendizaje, rutasAprendizaje, type RutaAprendizaje } from '../aprendizaje-catalogo.js';
import { useEstado } from './estado.js';
import { aprendizaje } from './aprendizaje-estado.js';

function Icono({ tipo = 'placa' }: { tipo?: string }) {
  return <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {tipo === 'codigo' ? <><rect x="8" y="12" width="48" height="40" rx="6" /><path d="m24 25-8 7 8 7m16-14 8 7-8 7m-5-15-6 16" /></> : tipo === 'circuito' ? <><path d="M8 32h12m24 0h12M32 8v12m0 24v12" /><path d="m20 32 4-8 8 16 8-16 4 8" /><circle cx="32" cy="8" r="3" /><circle cx="32" cy="56" r="3" /><circle cx="8" cy="32" r="3" /><circle cx="56" cy="32" r="3" /></> : <><rect x="14" y="14" width="36" height="36" rx="6" /><rect x="24" y="24" width="16" height="16" rx="2" /><path d="M24 6v8m16-8v8M24 50v8m16-8v8M6 24h8m-8 16h8m36-16h8m-8 16h8" /></>}
  </svg>;
}

const acentos = ['var(--acento)', 'var(--verde)', 'var(--amarillo)', 'var(--link)'];
function color(index: number): CSSProperties {
  return { '--aprendizaje-acento': acentos[index % acentos.length] } as CSSProperties;
}

export function AprenderNav() {
  const route = useEstado(() => aprendizaje.route);
  return <nav className="aprender-nav" aria-label="Navegación de aprendizaje">
    <span className="aprender-nav-label">TU APRENDIZAJE</span>
    {([['', 'Explorar'], ['temas', 'Temas'], ['rutas', 'Rutas de aprendizaje']] as const).map(([section, label]) => <a key={section} href={`#/aprender${section ? `/${section}` : ''}`} aria-current={(route.learning ?? '') === section ? 'page' : undefined}><span aria-hidden="true">{section === 'temas' ? '▦' : section === 'rutas' ? '◇' : '⌂'}</span>{label}</a>)}
    <div className="aprender-nav-nota"><Icono tipo="circuito" /><strong>Aprendé experimentando</strong><p>Circuitos, código y simulación en un mismo lugar.</p></div>
  </nav>;
}

export function Aprender() {
  const route = useEstado(() => aprendizaje.route);
  const [busqueda, setBusqueda] = useState('');
  const filtro = busqueda.trim().toLocaleLowerCase('es');
  const temas = temasAprendizaje.filter(tema => `${tema.titulo} ${tema.detalle}`.toLocaleLowerCase('es').includes(filtro));
  const rutas = rutasAprendizaje.filter(ruta => `${ruta.titulo} ${ruta.detalle} ${temasAprendizaje.find(tema => tema.id === ruta.tema)?.titulo ?? ''}`.toLocaleLowerCase('es').includes(filtro));
  const tema = temasAprendizaje.find(item => item.id === route.slug);
  const ruta = rutasAprendizaje.find(item => item.id === route.slug);
  const detalle = route.learning === 'temas' ? tema : ruta;
  const rutasTema = rutasAprendizaje.filter(item => item.tema === tema?.id);

  function tarjetasRutas(items: readonly RutaAprendizaje[]) {
    return <div className="aprender-rutas-grid">{items.map((item, index) => <a className="aprender-ruta-card" href={`#/aprender/rutas/${item.id}`} key={item.id} style={color(index)}>
      <div className="aprender-ruta-visual"><div className="aprender-hoja hoja-atras" /><div className="aprender-hoja hoja-medio" /><div className="aprender-hoja hoja-frente"><Icono tipo={item.icono} /><span>{item.nivel}</span></div><span className="aprender-ruta-etiqueta">RUTA DE APRENDIZAJE</span></div>
      <div className="aprender-card-info"><h3>{item.titulo}</h3><p>{item.detalle}</p><div className="aprender-card-pie"><span>Contenido en preparación</span><span aria-hidden="true">↗</span></div></div>
    </a>)}</div>;
  }

  return <>
    <header className="aprender-toolbar">
      <label className="aprender-buscador"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg><input aria-label="Buscar temas y rutas" placeholder="¿Qué querés aprender?" value={busqueda} onChange={event => setBusqueda(event.target.value)} /></label>
      <span className="aprender-toolbar-marca"><span className="aprender-punto" />Laboratorio de aprendizaje</span>
    </header>
    {route.slug ? <>
      <a className="aprender-volver" href={`#/aprender/${route.learning}`}>← Volver a {route.learning}</a>
      {detalle ? <>
        <div className="aprender-detalle-cabecera" style={color(0)}><div className="aprender-detalle-icono"><Icono tipo={detalle.icono} /></div><div><span className="aprender-eyebrow">{route.learning === 'temas' ? 'TEMA' : 'RUTA DE APRENDIZAJE'}</span><h1>{detalle.titulo}</h1><p>{detalle.detalle}</p></div></div>
        {route.learning === 'temas' ? <section className="aprender-seccion"><h2>Rutas de este tema</h2>{rutasTema.length ? tarjetasRutas(rutasTema) : <div className="aprender-vacio">Las rutas de este tema estarán disponibles próximamente.</div>}</section> : <div className="aprender-leccion-layout"><aside className="aprender-indice"><span className="aprender-eyebrow">CONTENIDO DE LA RUTA</span><h2>Tu recorrido</h2><p>Las lecciones aparecerán aquí.</p><div className="aprender-indice-linea" /><div className="aprender-indice-linea corta" /><span className="aprender-badge">En preparación</span></aside><article className="aprender-contenido"><Icono tipo="codigo" /><h2>Un espacio para aprender y practicar</h2><p>Acá encontrarás las lecciones, ejemplos de código y actividades de esta ruta.</p><span className="aprender-badge">Contenido próximamente</span></article></div>}
      </> : <div className="aprender-vacio"><h1>No encontramos esta página</h1><p>Explorá los temas y rutas disponibles desde el menú.</p></div>}
    </> : <>
      <div className="aprender-intro"><span className="aprender-eyebrow">EXPLORÁ · CONECTÁ · EXPERIMENTÁ</span><h1>{route.learning === 'temas' ? 'Todos los temas' : route.learning === 'rutas' ? 'Rutas de aprendizaje' : 'Aprender'}</h1><p>Construí tu camino en electrónica, programación y simulación.</p></div>
      {route.learning !== 'temas' && <section className="aprender-seccion" aria-labelledby="aprender-rutas-titulo"><div className="aprender-seccion-titulo"><h2 id="aprender-rutas-titulo">{route.learning === 'rutas' ? 'Elegí tu próximo recorrido' : 'Empezá con una ruta'}</h2>{!route.learning && <a href="#/aprender/rutas">Ver todas las rutas <span aria-hidden="true">→</span></a>}</div>{rutas.length ? (route.learning === 'rutas' ? temasAprendizaje.map(item => {
        const recorridos = rutas.filter(recorrido => recorrido.tema === item.id);
        return recorridos.length ? <section className="aprender-seccion" key={item.id} aria-label={item.titulo}><div className="aprender-seccion-titulo"><h3>{item.titulo}</h3><a href={`#/aprender/temas/${item.id}`}>Explorar tema →</a></div>{tarjetasRutas(recorridos)}</section> : null;
      }) : tarjetasRutas(filtro ? rutas : rutas.slice(0, 3))) : <div className="aprender-vacio">No hay rutas para esa búsqueda.</div>}</section>}
      {!route.learning && <section className="aprender-seccion" aria-labelledby="aprender-recomendados-titulo"><div className="aprender-seccion-titulo"><h2 id="aprender-recomendados-titulo">Explorá lo que podés crear</h2><span>Un tema, muchas posibilidades</span></div><div className="aprender-destacados-grid">{temas.slice(0, 4).map((item, index) => <a className="aprender-destacado" key={item.id} href={`#/aprender/temas/${item.id}`} style={color(index)}><span className="aprender-badge">Explorar tema</span><div className="aprender-destacado-arte"><div className="aprender-orbita" /><Icono tipo={item.icono} /></div><div><h3>{item.titulo}</h3><p>{item.detalle}</p><span className="aprender-destacado-link">Descubrir <span aria-hidden="true">→</span></span></div></a>)}</div></section>}
      {route.learning !== 'rutas' && <section className="aprender-seccion" aria-labelledby="aprender-temas-titulo"><div className="aprender-seccion-titulo"><h2 id="aprender-temas-titulo">Todos los temas</h2><span>Aprendé a tu ritmo</span></div><div className="aprender-temas-grid">{temas.map((item, index) => <a className="aprender-tema" href={`#/aprender/temas/${item.id}`} key={item.id} style={color(index)}><span className="aprender-tema-icono"><Icono tipo={item.icono} /></span><span><h3>{item.titulo}</h3><p>{item.detalle}</p></span><span className="aprender-tema-flecha" aria-hidden="true">↗</span></a>)}</div>{!temas.length && <div className="aprender-vacio">No hay temas para esa búsqueda.</div>}</section>}
    </>}
  </>;
}
