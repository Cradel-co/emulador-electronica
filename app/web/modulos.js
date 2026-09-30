// Dibujo de los módulos a partir de su module.svg (sección 12). El mismo código
// dibuja los de fábrica y los importados: no hay nada específico por tipo.
//
// Convenciones del SVG (ver modules/README.md):
//   data-si="on" / data-si="!on"   se ve solo si el estado vale (o no). Estados:
//                                  on, activo, presionado, flash, sonando, boton0..boton3
//   data-ctrl="momentary|toggle|boton" (+ data-indice)   parte que se puede tocar
//   {{props.x}} / {{vars.x}}        valores de las propiedades del módulo

export const NS = 'http://www.w3.org/2000/svg';

/**
 * Crea un elemento SVG con atributos y lo cuelga de `padre`.
 * @param {string} tag @param {Record<string, string | number>} attrs @param {Element} [padre]
 * @returns {SVGElement}
 */
export function el(tag, attrs = {}, padre) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (padre) padre.append(e);
  return e;
}

// --- Saneado ------------------------------------------------------------------

/** Misma lista que el server (moduleImporter.ts): el SVG de un módulo importado va al DOM. */
const PERMITIDOS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'title', 'desc', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern',
  'use', 'symbol',
]);

/** @param {Element} nodo */
function sanear(nodo) {
  for (const hijo of [...nodo.children]) {
    if (!PERMITIDOS.has(hijo.localName.toLowerCase()) || hijo.namespaceURI !== NS) {
      hijo.remove();
      continue;
    }
    for (const attr of [...hijo.attributes]) {
      const nombre = attr.name.toLowerCase();
      const valor = attr.value.toLowerCase();
      const peligroso =
        nombre.startsWith('on') ||
        ((nombre === 'href' || nombre === 'xlink:href') && !attr.value.trim().startsWith('#')) ||
        valor.includes('javascript:') ||
        /url\(\s*['"]?\s*[^#'"\s]/.test(valor) ||
        (nombre === 'style' && /@import|expression/.test(valor));
      if (peligroso) hijo.removeAttribute(attr.name);
    }
    sanear(hijo);
  }
}

const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Reemplaza {{props.x}} y {{vars.x}} por los valores de esta instancia. */
function sustituir(markup, def, props) {
  const vars = {};
  for (const [k, v] of Object.entries(def.vars ?? {})) {
    const d = /** @type {any} */ (v);
    vars[k] = d.map?.[String(props?.[d.prop])] ?? d.default;
  }
  return markup.replace(/\{\{\s*(props|vars)\.([A-Za-z0-9_]+)\s*\}\}/g, (_, tipo, k) =>
    escXml((tipo === 'vars' ? vars[k] : props?.[k] ?? def.props?.[k]?.default) ?? ''),
  );
}

/** Nodos ya parseados y saneados, por (tipo + SVG con valores): parsear cada render sería lento. */
const plantillas = new Map();

/** @returns {Element[] | null} */
function plantilla(def, props) {
  let markup = sustituir(def.svgMarkup, def, props);
  if (!/<svg[^>]*xmlns=/.test(markup)) markup = markup.replace(/<svg/, `<svg xmlns="${NS}"`);
  const clave = `${def.type}\u0000${markup}`;
  if (plantillas.has(clave)) return plantillas.get(clave);
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const raiz = doc.documentElement;
  let nodos = null;
  if (raiz.localName === 'svg' && !doc.querySelector('parsererror')) {
    sanear(raiz);
    nodos = [...raiz.children];
  }
  if (plantillas.size > 300) plantillas.clear();
  plantillas.set(clave, nodos);
  return nodos;
}

// --- Dibujo ---------------------------------------------------------------------

/**
 * Estado en vivo que cambia el dibujo durante la simulación.
 * @typedef {{ on?: boolean, presionado?: boolean, activo?: boolean, flash?: boolean, sonando?: boolean, boton?: number }} Vivo
 */

/** @param {Vivo} vivo */
function estados(vivo) {
  const e = {
    on: vivo.on, activo: vivo.activo, presionado: vivo.presionado, flash: vivo.flash, sonando: vivo.sonando,
  };
  for (let i = 0; i < 8; i++) e[`boton${i}`] = vivo.boton === i;
  return e;
}

/**
 * Dibuja el cuerpo del módulo (sin pines) dentro de `g`.
 * @param {SVGElement} g @param {any} def @param {{ props?: Record<string, any> }} inst @param {Vivo} [vivo]
 */
export function dibujarModulo(g, def, inst, vivo = {}) {
  const nodos = def.svgMarkup ? plantilla(def, inst.props ?? {}) : null;
  if (!nodos) return dibujarGenerico(g, def);
  const cuerpo = el('g', { class: 'cuerpo' }, g);
  for (const n of nodos) cuerpo.append(document.importNode(n, true));
  const e = estados(vivo);
  for (const nodo of cuerpo.querySelectorAll('[data-si]')) {
    const cond = nodo.getAttribute('data-si').trim();
    const negado = cond.startsWith('!');
    if (Boolean(e[negado ? cond.slice(1) : cond]) === negado) nodo.setAttribute('display', 'none');
  }
  for (const nodo of cuerpo.querySelectorAll('[data-ctrl]')) {
    nodo.classList.add('ctrl');
    nodo.setAttribute('data-control', nodo.getAttribute('data-ctrl'));
  }
}

/** Módulo sin dibujo (o no encontrado en el catálogo): una caja con su nombre. */
function dibujarGenerico(g, def) {
  const W = def.width;
  const H = def.height;
  const cuerpo = def.pins.some((p) => p.y >= H) ? H - 12 : H;
  for (const p of def.pins) {
    if (p.y >= H) el('line', { x1: p.x, y1: cuerpo, x2: p.x, y2: p.y, stroke: '#aab4be', 'stroke-width': 2 }, g);
  }
  el('rect', {
    x: 0, y: 0, width: W, height: cuerpo, rx: 4,
    fill: def.desconocido ? '#2a1414' : '#2b3440', stroke: def.desconocido ? '#e2554b' : '#3d4a58',
    'stroke-dasharray': def.desconocido ? '5 4' : 'none',
  }, g);
  const t = el('text', { x: W / 2, y: cuerpo / 2 + 4, class: 'txt-chico claro', 'text-anchor': 'middle' }, g);
  t.textContent = def.name;
}

/** Definición provisoria para un módulo del circuito que ya no está en el catálogo. */
export function defDesconocido(type) {
  return { type, name: `¿${type}?`, category: '', width: 110, height: 50, pins: [], props: {}, desconocido: true };
}

/**
 * Miniatura del módulo para el catálogo y el panel.
 * @param {any} def
 * @returns {SVGSVGElement}
 */
export function miniatura(def) {
  const props = {};
  for (const [k, p] of Object.entries(def.props ?? {})) props[k] = /** @type {any} */ (p).default;
  const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (el('svg', {
    viewBox: `-10 -4 ${def.width + 20} ${def.height + 8}`, class: 'miniatura', 'aria-hidden': 'true',
  })));
  const g = el('g', {}, svg);
  dibujarModulo(g, def, { props }, def.bridge?.role === 'output' ? { on: true } : {});
  for (const p of def.pins) {
    if (!def.programmable) el('circle', { cx: p.x, cy: p.y, r: 3, class: `pin-punto ${p.kind}` }, g);
  }
  return svg;
}
