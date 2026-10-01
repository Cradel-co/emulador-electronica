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
export function el(tag: string, attrs: Record<string, string | number> = {}, padre?: Element) {
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
    const d = (v as any);
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
 * @typedef {{ on?: boolean, presionado?: boolean, activo?: boolean, flash?: boolean, sonando?: boolean, boton?: number, pantalla?: any }} Vivo
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
 * Muestra u oculta las partes del dibujo marcadas con `data-si` según el estado del módulo
 * (`on`, `presionado`, `flash`, `boton3`...), poniendo y quitando el atributo `display`.
 *
 * Está separada de `dibujarModulo` porque es lo único que cambia cuando cambia un nivel de
 * pin: el canvas la vuelve a aplicar sobre los nodos que ya están, en vez de rearmar el SVG
 * entero en cada frame.
 *
 * @param {Element} raiz @param {Vivo} vivo
 */
export function aplicarEstadoVivo(raiz, vivo) {
  const e = estados(vivo ?? {});
  for (const nodo of raiz.querySelectorAll('[data-si]')) {
    const cond = nodo.getAttribute('data-si').trim();
    const negado = cond.startsWith('!');
    const mostrar = Boolean(e[negado ? cond.slice(1) : cond]) !== negado;
    // Importante poner *y* quitar: al redibujar el nodo nace limpio, pero acá se reusa.
    // Y solo si cambió: escribir el mismo valor invalida el estilo del nodo al por nada.
    const oculto = nodo.getAttribute('display') === 'none';
    if (mostrar && oculto) nodo.removeAttribute('display');
    else if (!mostrar && !oculto) nodo.setAttribute('display', 'none');
  }
}

/**
 * Dibuja el cuerpo del módulo (sin pines) dentro de `g`.
 * @param {SVGElement} g @param {any} def @param {{ props?: Record<string, any> }} inst @param {Vivo} [vivo]
 */
export function dibujarModulo(g, def, inst, vivo: { pantalla?: any; [k: string]: any } = {}) {
  const nodos = def.svgMarkup ? plantilla(def, inst.props ?? {}) : null;
  if (!nodos) return dibujarGenerico(g, def);
  const cuerpo = el('g', { class: 'cuerpo' }, g);
  for (const n of nodos) cuerpo.append(document.importNode(n, true));
  aplicarEstadoVivo(cuerpo, vivo);
  for (const nodo of cuerpo.querySelectorAll('[data-ctrl]')) {
    nodo.classList.add('ctrl');
    nodo.setAttribute('data-control', nodo.getAttribute('data-ctrl'));
  }
  // Pantallas: la imagen que publica el chip va sobre la parte marcada con data-pantalla. La pone
  // la app (no el SVG del módulo, que no puede traer imágenes): es un PNG que arma ella misma.
  for (const vidrio of cuerpo.querySelectorAll('[data-pantalla]')) {
    const img = el('image', {
      class: 'pantalla-chip', 'data-pantalla-de': inst.id ?? '',
      x: vidrio.getAttribute('x') ?? 0, y: vidrio.getAttribute('y') ?? 0,
      width: vidrio.getAttribute('width') ?? 0, height: vidrio.getAttribute('height') ?? 0,
      preserveAspectRatio: 'none',
    });
    vidrio.after(img);
    ponerImagenPantalla(img, vivo.pantalla, String(inst.props?.color ?? def.props?.color?.default ?? 'blanco'));
  }
}

/** Colores de los OLED comunes: blanco, azul, y el bicolor (las 16 líneas de arriba en amarillo). */
const COLORES_OLED = { blanco: [235, 242, 255], azul: [70, 170, 255], amarillo: [255, 214, 60] };
const urlsPantalla = new Map<string, string>();

/** PNG de lo que muestra una pantalla de chip (cacheado: el mismo cuadro no se vuelve a armar). */
export function urlPantalla(p: { ancho: number; alto: number; encendida: boolean; brillo: number; filas?: string[]; formato?: string; rgb565?: string }, color: string): string {
  const clave = p.formato === 'rgb565' ? `rgb565|${p.rgb565}` : `${color}|${p.encendida}|${p.brillo}|${(p.filas ?? []).join('')}`;
  const hecha = urlsPantalla.get(clave);
  if (hecha) return hecha;
  const c = document.createElement('canvas');
  c.width = p.ancho;
  c.height = p.alto;
  const ctx = c.getContext('2d');
  const datos = ctx.createImageData(p.ancho, p.alto);
  if (p.formato === 'rgb565') {
    // Pantalla a color (TFT): dos bytes por píxel, RRRRRGGG GGGBBBBB.
    const bin = atob(p.rgb565 ?? '');
    for (let k = 0, i = 0; k + 1 < bin.length && i < datos.data.length; k += 2, i += 4) {
      const v = (bin.charCodeAt(k) << 8) | bin.charCodeAt(k + 1);
      datos.data[i] = ((v >> 11) & 0x1f) * 255 / 31;
      datos.data[i + 1] = ((v >> 5) & 0x3f) * 255 / 63;
      datos.data[i + 2] = (v & 0x1f) * 255 / 31;
      datos.data[i + 3] = 255;
    }
    ctx.putImageData(datos, 0, 0);
    const u = c.toDataURL('image/png');
    if (urlsPantalla.size > 200) urlsPantalla.clear();
    urlsPantalla.set(clave, u);
    return u;
  }
  // Con contraste 0 un OLED igual se ve (tenue): el brillo va de 35 % a 100 %.
  const k = p.encendida ? 0.35 + 0.65 * Math.max(0, Math.min(1, p.brillo)) : 0;
  for (let y = 0; y < p.alto; y++) {
    const fila = p.filas?.[y] ?? '';
    const base = color === 'amarillo-azul' ? (y < 16 ? COLORES_OLED.amarillo : COLORES_OLED.azul) : (COLORES_OLED[color] ?? COLORES_OLED.blanco);
    for (let x = 0; x < p.ancho; x++) {
      const on = (parseInt(fila.slice((x >> 3) * 2, (x >> 3) * 2 + 2), 16) >> (7 - (x & 7))) & 1;
      const i = (y * p.ancho + x) * 4;
      datos.data[i] = on ? base[0] * k : 6;
      datos.data[i + 1] = on ? base[1] * k : 8;
      datos.data[i + 2] = on ? base[2] * k : 12;
      datos.data[i + 3] = 255;
    }
  }
  ctx.putImageData(datos, 0, 0);
  const url = c.toDataURL('image/png');
  if (urlsPantalla.size > 200) urlsPantalla.clear();
  urlsPantalla.set(clave, url);
  return url;
}

/** Pone (o saca) la imagen de una pantalla. Sin cuadro todavía, se ve el vidrio apagado. */
export function ponerImagenPantalla(img: Element, p, color: string): void {
  if (p && (Array.isArray(p.filas) || p.formato === 'rgb565')) img.setAttribute('href', urlPantalla(p, color));
  else img.removeAttribute('href');
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
  for (const [k, p] of Object.entries(def.props ?? {})) props[k] = (p as any).default;
  const svg = ((el('svg', {
    viewBox: `-10 -4 ${def.width + 20} ${def.height + 8}`, class: 'miniatura', 'aria-hidden': 'true',
  }) as unknown) as SVGSVGElement);
  const g = el('g', {}, svg);
  dibujarModulo(g, def, { props }, def.bridge?.role === 'output' ? { on: true } : {});
  for (const p of def.pins) {
    if (!def.programmable) el('circle', { cx: p.x, cy: p.y, r: 3, class: `pin-punto ${p.kind}` }, g);
  }
  return svg;
}
