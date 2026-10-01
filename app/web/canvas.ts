// Canvas del circuito (sección 11.2): módulos arrastrables, cables pin a pin,
// zoom con la rueda y paneo arrastrando el fondo. No guarda nada: avisa los
// cambios por callbacks y el que lo usa (app.ts) decide qué persistir.
import { el, dibujarModulo, defDesconocido } from './modulos.js';

const COLOR_CABLE = { power: '#e2554b', ground: '#8a96a3', signal: '#56c271' };

/**
 * @typedef {{ id: string, type: string, x: number, y: number, rotation?: number, props?: Record<string, any> }} Instancia
 * @typedef {{ from: string, to: string }} Cable
 * @typedef {{ tipo: 'modulo', id: string } | { tipo: 'cable', indice: number } | null} Seleccion
 * @typedef {{
 *   diagrama: () => { modules: Instancia[], wires: Cable[] },
 *   def: (type: string) => any,
 *   seleccion: () => Seleccion,
 *   vivo: (inst: Instancia) => any,
 *   clasePin: (ref: string) => string,
 *   descripcionPin: (ref: string) => string,
 *   enCorto: (ref: string) => boolean,
 *   cortoExplotando: (ref: string) => boolean,
 *   seleccionar: (sel: Seleccion) => void,
 *   moverModulo: (id: string, x: number, y: number, fin: boolean) => void,
 *   rotarModulo: (id: string, grados: number, fin: boolean) => void,
 *   conectar: (a: string, b: string) => void,
 *   puedeEmpezarCable: (ref: string) => boolean,
 *   control: (inst: Instancia, control: string, indice: number, evento: 'down' | 'up') => void,
 *   soltarModulo: (type: string, x: number, y: number) => void,
 * }} Contexto
 */

/**
 * @param {SVGSVGElement} svg @param {Contexto} ctx
 */
export function crearLienzo(svg, ctx) {
  const vista = { x: 0, y: 0, z: 1 };
  /**
   * La vista está como la dejó "Ajustar" (nadie paneó ni hizo zoom a mano). Mientras siga así,
   * si el lienzo cambia de tamaño (aparecen avisos, se abre un panel, cambia la ventana) se
   * vuelve a encuadrar solo: si no, lo de abajo queda tapado y no se puede tocar.
   */
  let vistaAutomatica = true;
  /** @type {null | { desde: string, x: number, y: number, arrastrando: boolean, movido: boolean, sx: number, sy: number }} */
  let cable = null;
  /** @type {null | { tipo: 'modulo', id: string, dx: number, dy: number, sx: number, sy: number, movido: boolean } | { tipo: 'pan', sx: number, sy: number, vx: number, vy: number, movido: boolean } | { tipo: 'rotar', id: string, cx: number, cy: number, base: number, sx: number, sy: number, movido: boolean }} */
  let arrastre = null;
  /** @type {null | { inst: Instancia, control: string, indice: number }} */
  let controlActivo = null;
  let hover = (null as string | null);

  // --- Geometría -------------------------------------------------------------

  // --- Rotación ----------------------------------------------------------------
  // Cada módulo gira alrededor del centro de su dibujo. Los pines se calculan ya rotados,
  // así los cables salen del lugar y en la dirección correctos a cualquier ángulo.

  /** @param {Instancia} inst */
  const rotacionDe = (inst) => (((inst.rotation ?? 0) % 360) + 360) % 360;

  /** Gira el vector (x, y) `grados` en sentido horario (el eje y del SVG apunta abajo). */
  function girar(x, y, grados) {
    const r = (grados * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [x * c - y * s, x * s + y * c];
  }

  /** Punto en coordenadas del dibujo del módulo (sin rotar) → coordenadas del mundo. */
  function aMundoModulo(inst, def, lx, ly) {
    const cx = def.width / 2;
    const cy = def.height / 2;
    const [dx, dy] = girar(lx - cx, ly - cy, rotacionDe(inst));
    return { x: inst.x + cx + dx, y: inst.y + cy + dy };
  }

  /** Medio ancho y medio alto de la caja que ocupa el módulo ya rotado. */
  function semiCaja(def, grados) {
    const r = (grados * Math.PI) / 180;
    const c = Math.abs(Math.cos(r));
    const s = Math.abs(Math.sin(r));
    return [(def.width / 2) * c + (def.height / 2) * s, (def.width / 2) * s + (def.height / 2) * c];
  }

  /** @param {string} ref "btn1.OUT" → instancia, def y pin */
  function resolver(ref) {
    const punto = ref.indexOf('.');
    if (punto <= 0) return null;
    const id = ref.slice(0, punto);
    const nombre = ref.slice(punto + 1);
    const inst = ctx.diagrama().modules.find((m) => m.id === id);
    if (!inst) return null;
    const def = ctx.def(inst.type);
    const pin = def?.pins.find((p) => p.name === nombre);
    if (!pin) return null;
    const m = aMundoModulo(inst, def, pin.x, pin.y);
    return { inst, def, pin, x: m.x, y: m.y };
  }

  /** Dirección hacia la que "sale" el cable de un pin, para curvarlo. */
  function salida(r) {
    const { pin, def, inst } = r;
    const d = pin.x <= 0 ? [-1, 0] : pin.x >= def.width ? [1, 0] : pin.y <= 0 ? [0, -1] : [0, 1];
    return girar(d[0], d[1], rotacionDe(inst));
  }

  function curva(x1, y1, d1, x2, y2, d2) {
    const k = Math.max(40, Math.hypot(x2 - x1, y2 - y1) * 0.4);
    return `M${x1} ${y1} C${x1 + d1[0] * k} ${y1 + d1[1] * k} ${x2 + d2[0] * k} ${y2 + d2[1] * k} ${x2} ${y2}`;
  }

  function tipoCable(a, b) {
    const kinds = [a.pin.kind, b.pin.kind];
    if (kinds.includes('ground')) return 'ground';
    if (kinds.includes('power')) return 'power';
    return 'signal';
  }

  /** Coordenadas de pantalla → mundo. */
  function aMundo(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return { x: (clientX - r.left - vista.x) / vista.z, y: (clientY - r.top - vista.y) / vista.z };
  }

  // --- Render ----------------------------------------------------------------

  let capa = (null as SVGElement | null);

  function aplicarVista() {
    capa?.setAttribute('transform', `translate(${vista.x} ${vista.y}) scale(${vista.z})`);
  }

  /** Render pendiente para el próximo frame (ver pedirRender). */
  let frame = 0;

  /**
   * Redibuja en el próximo frame: para lo que llega en ráfagas (niveles de pines de un
   * firmware que parpadea rápido), así se rearma el SVG una vez por frame y no por mensaje.
   */
  function pedirRender() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function render() {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    const { modules, wires } = ctx.diagrama();
    const sel = ctx.seleccion();
    svg.textContent = '';
    svg.classList.toggle('conectando', cable !== null);

    const defs = el('defs', {}, svg);
    const patron = el('pattern', { id: 'grilla', width: 20, height: 20, patternUnits: 'userSpaceOnUse' }, defs);
    el('circle', { cx: 1, cy: 1, r: 1, fill: '#2c2e33' }, patron);

    capa = el('g', { class: 'capa' }, svg);
    aplicarVista();
    el('rect', { x: -5000, y: -5000, width: 10000, height: 10000, fill: 'url(#grilla)', class: 'fondo' }, capa);

    // Cables debajo de los módulos
    const gc = el('g', { class: 'cables' }, capa);
    wires.forEach((w, i) => {
      const a = resolver(w.from);
      const b = resolver(w.to);
      if (!a || !b) return;
      const d = curva(a.x, a.y, salida(a), b.x, b.y, salida(b));
      // Las dos puntas cableadas directo entre sí son exactamente el cortocircuito.
      const enCorto = ctx.enCorto(w.from) && ctx.enCorto(w.to);
      const g = el('g', {
        class: `cable${sel?.tipo === 'cable' && sel.indice === i ? ' seleccionado' : ''}${enCorto ? ' en-corto' : ''}`,
        'data-indice': i, 'data-from': w.from, 'data-to': w.to,
      }, gc);
      el('path', { d, class: 'cable-hit' }, g);
      const linea = el('path', { d, class: 'cable-linea', stroke: COLOR_CABLE[tipoCable(a, b)] }, g) as SVGPathElement;
      if (enCorto) {
        // El medio de la curva, no de la recta entre las puntas (el cable puede ir muy arqueado).
        const m = linea.getPointAtLength(linea.getTotalLength() / 2);
        humear(g, m.x, m.y);
        chisporrotear(g, m.x, m.y);
        if (ctx.cortoExplotando(w.from) || ctx.cortoExplotando(w.to)) explotar(g, m.x, m.y);
      }
    });

    // Módulos
    const gm = el('g', { class: 'modulos' }, capa);
    for (const inst of modules) {
      // Si el módulo ya no está en el catálogo (se quitó), se ve igual para poder borrarlo.
      const def = ctx.def(inst.type) ?? defDesconocido(inst.type);
      const seleccionado = sel?.tipo === 'modulo' && sel.id === inst.id;
      const rot = rotacionDe(inst);
      const g = el('g', {
        class: `modulo${seleccionado ? ' seleccionado' : ''}${def.programmable ? ' programable' : ''}`,
        transform: `translate(${inst.x} ${inst.y})`, 'data-id': inst.id, 'data-type': inst.type,
      }, gm);
      // Lo que gira (dibujo, pines, marco) va en su propio grupo; la etiqueta queda derecha.
      const gr = el('g', { class: 'rotado', transform: `rotate(${rot} ${def.width / 2} ${def.height / 2})` }, g);
      el('rect', { x: -8, y: -8, width: def.width + 16, height: def.height + 16, rx: 8, class: 'marco-seleccion' }, gr);
      const vivo = ctx.vivo(inst);
      dibujarModulo(gr, def, inst, vivo);
      if (vivo.quemado) dibujarQuemadura(g, gr, inst, def, vivo.explotando);

      for (const p of def.pins) {
        const ref = `${inst.id}.${p.name}`;
        const gp = el('g', { class: `pin ${p.kind} ${ctx.clasePin(ref)}`, 'data-ref': ref }, gr);
        el('circle', { cx: p.x, cy: p.y, r: 9, class: 'pin-hit' }, gp);
        el('circle', { cx: p.x, cy: p.y, r: 4.5, class: 'pin-punto' }, gp);
        const t = el('title', {}, gp);
        const extra = ctx.descripcionPin(ref);
        t.textContent = `${def.name} · ${p.name.replace(/_\d+$/, '')}${extra ? ` — ${extra}` : ''}`;
        if (!def.programmable) {
          // Rótulo hacia adentro del módulo según el borde donde está el pin.
          const izq = p.x <= 0;
          const der = p.x >= def.width;
          const tx = izq ? p.x + 7 : der ? p.x - 7 : p.x + 3;
          const ty = izq || der ? p.y + 3 : p.y - 5;
          const txt = el('text', {
            x: tx, y: ty,
            'text-anchor': der ? 'end' : 'start',
            class: 'txt-pin-mod',
            // El nombre del pin se lee siempre derecho, gire como gire el módulo.
            ...(rot ? { transform: `rotate(${-rot} ${tx} ${ty - 3})` } : {}),
          }, gp);
          txt.textContent = p.name;
        }
      }

      // Los módulos tienen los pines abajo: la etiqueta va arriba para que no la crucen los cables.
      // Se ubica según la caja ya rotada, así no queda encima del dibujo.
      const [, semiAlto] = semiCaja(def, rot);
      const yEtiqueta = def.programmable ? def.height / 2 + semiAlto + 22 : def.height / 2 - semiAlto - 14;
      const etiqueta = el('text', { x: def.width / 2, y: yEtiqueta, class: 'etiqueta-modulo', 'text-anchor': 'middle' }, g);
      etiqueta.textContent = def.programmable ? def.name : `${inst.props?.label || def.name} · ${inst.id}`;

      // Asa para girar (esquina de arriba a la derecha, gira con el módulo), como en los editores de diseño.
      if (seleccionado) {
        const asa = el('g', { class: 'asa-rotar', 'data-id': inst.id }, gr);
        el('line', { x1: def.width + 4, y1: -4, x2: def.width + 13, y2: -13 }, asa);
        el('circle', { cx: def.width + 17, cy: -17, r: 7 }, asa);
        el('path', { d: `M${def.width + 13.5} ${-17}a3.5 3.5 0 1 1 1.2 2.6`, class: 'asa-flecha' }, asa);
        el('title', {}, asa).textContent = 'Arrastrá para girar (de a 15°; con Shift, libre) · R gira 90°';
      }
    }

    actualizarTemporal();
  }

  /**
   * Una animación SMIL (sigue al elemento aunque el módulo esté rotado; no necesita CSS).
   * Arranca ahora (+ `retraso` s): en SMIL el `begin` se mide desde que cargó la página, no
   * desde que se insertó el elemento — con `begin: 0` una animación de una sola vez agregada
   * a los minutos de abrir la página ya "terminó" y se ve directo en su estado final.
   */
  function animar(padre, atributo, desde, hasta, dur, extra = {}, retraso = 0) {
    const begin = `${(svg.getCurrentTime() + retraso).toFixed(3)}s`;
    el('animate', { attributeName: atributo, from: desde, to: hasta, dur, fill: 'freeze', ...extra, begin }, padre);
  }

  /** Tres bocanadas de humo que suben desde (cx, cy), en loop. */
  function humear(padre, cx, cy) {
    const humo = el('g', { class: 'humo' }, padre);
    for (let i = 0; i < 3; i++) {
      // Invisible hasta que le toca arrancar (las bocanadas van desfasadas).
      const c = el('circle', { cx: cx + (i - 1) * 4, cy, r: 3, opacity: 0 }, humo);
      const rep = { repeatCount: 'indefinite', fill: 'remove' };
      animar(c, 'cy', cy, cy - 46, '2.1s', rep, i * 0.7);
      animar(c, 'r', 3, 11, '2.1s', rep, i * 0.7);
      animar(c, 'opacity', 0.55, 0, '2.1s', rep, i * 0.7);
    }
  }

  /**
   * Cortocircuito sostenido: resplandor de fuego que titila y chispas cortas que saltan
   * sin parar desde (cx, cy), mientras el cable siga en corto.
   */
  function chisporrotear(padre, cx, cy) {
    const g = el('g', { class: 'chisporroteo' }, padre);
    const fuego = el('circle', { cx, cy, r: 9, class: 'fuego' }, g);
    animar(fuego, 'r', 7, 13, '0.18s', { repeatCount: 'indefinite', fill: 'remove' });
    animar(fuego, 'opacity', 0.95, 0.45, '0.23s', { repeatCount: 'indefinite', fill: 'remove' });
    for (let i = 0; i < 7; i++) {
      const a = i * 2.4; // ángulo áureo aprox.: repartidas sin patrón visible
      const [ux, uy] = [Math.cos(a), Math.sin(a)];
      const chispa = el('line', { x1: cx, y1: cy, x2: cx, y2: cy, class: 'chispa', opacity: 0 }, g);
      const rep = { repeatCount: 'indefinite', fill: 'remove' };
      const retraso = i * 0.11;
      animar(chispa, 'x1', cx + ux * 3, cx + ux * 14, '0.4s', rep, retraso);
      animar(chispa, 'y1', cy + uy * 3, cy + uy * 14 + 4, '0.4s', rep, retraso);
      animar(chispa, 'x2', cx + ux * 7, cx + ux * 22, '0.4s', rep, retraso);
      animar(chispa, 'y2', cy + uy * 7, cy + uy * 22 + 8, '0.4s', rep, retraso);
      animar(chispa, 'opacity', 1, 0, '0.4s', rep, retraso);
    }
  }

  /** Destello + 10 chispas radiales centradas en (cx, cy): la explosión, reusada por cualquier daño. */
  function explotar(padre, cx, cy) {
    const boom = el('g', { class: 'explosion' }, padre);
    const destello = el('circle', { cx, cy, r: 2, class: 'destello' }, boom);
    animar(destello, 'r', 2, 34, '0.45s');
    animar(destello, 'opacity', 1, 0, '0.6s');
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3;
      const [ux, uy] = [Math.cos(a), Math.sin(a)];
      const chispa = el('line', { x1: cx, y1: cy, x2: cx, y2: cy, class: 'chispa' }, boom);
      animar(chispa, 'x1', cx + ux * 4, cx + ux * 26, '0.55s');
      animar(chispa, 'y1', cy + uy * 4, cy + uy * 26 + 8, '0.55s');
      animar(chispa, 'x2', cx + ux * 10, cx + ux * 40, '0.55s');
      animar(chispa, 'y2', cy + uy * 10, cy + uy * 40 + 14, '0.55s');
      animar(chispa, 'opacity', 1, 0, '0.7s');
    }
  }

  /**
   * LED quemado: mancha oscura sobre la cápsula y humo que sube; recién quemado, además,
   * destello y chispas. El humo va fuera del grupo rotado para que suba derecho.
   */
  function dibujarQuemadura(g, gr, inst, def, explotando) {
    g.classList.add('quemado');
    const bx = def.width / 2;
    const by = def.height * 0.3;
    el('ellipse', { cx: bx, cy: by, rx: def.width * 0.28, ry: def.height * 0.16, class: 'chamuscado' }, gr);
    const [dx, dy] = girar(bx - def.width / 2, by - def.height / 2, rotacionDe(inst));
    const cx = def.width / 2 + dx;
    const cy = def.height / 2 + dy;
    humear(g, cx, cy);
    if (explotando) explotar(g, cx, cy);
  }

  /**
   * Mueve un módulo que se está arrastrando: solo su transform y los cables que lo tocan,
   * sin rearmar el resto del dibujo (con muchos módulos, rearmar todo en cada mousemove se nota).
   * @param {string} id
   */
  function moverVisual(id) {
    const inst = ctx.diagrama().modules.find((m) => m.id === id);
    const g = capa?.querySelector(`.modulo[data-id="${CSS.escape(id)}"]`);
    if (!inst || !g) return render();
    g.setAttribute('transform', `translate(${inst.x} ${inst.y})`);
    const def = ctx.def(inst.type);
    const gr = g.querySelector(':scope > .rotado');
    if (def && gr) gr.setAttribute('transform', `rotate(${rotacionDe(inst)} ${def.width / 2} ${def.height / 2})`);
    const prefijo = `${id}.`;
    for (const c of capa.querySelectorAll('.cable')) {
      const from = c.getAttribute('data-from') ?? '';
      const to = c.getAttribute('data-to') ?? '';
      if (!from.startsWith(prefijo) && !to.startsWith(prefijo)) continue;
      const a = resolver(from);
      const b = resolver(to);
      if (!a || !b) continue;
      const d = curva(a.x, a.y, salida(a), b.x, b.y, salida(b));
      for (const path of c.querySelectorAll('path')) path.setAttribute('d', d);
    }
  }

  /**
   * Solo la línea del cable en curso: se llama en cada movimiento del mouse, así
   * que no redibuja el resto (los pines bajo el mouse tienen que seguir siendo los mismos).
   */
  function actualizarTemporal() {
    if (!capa) return;
    let path = capa.querySelector('.cable-temporal');
    const a = cable ? resolver(cable.desde) : null;
    if (!a) {
      path?.remove();
      return;
    }
    const b = hover && hover !== cable.desde ? resolver(hover) : null;
    const d = b
      ? curva(a.x, a.y, salida(a), b.x, b.y, salida(b))
      : curva(a.x, a.y, salida(a), cable.x, cable.y, [0, 0]);
    if (!path) path = el('path', { class: 'cable-temporal' }, capa);
    path.setAttribute('d', d);
  }

  // --- Interacción -------------------------------------------------------------

  /** @param {EventTarget | null} t @param {string} sel */
  const cerca = (t, sel) => (t instanceof Element ? t.closest(sel) : null as Element | null);

  function terminarCable(destino) {
    const desde = cable.desde;
    cable = null;
    hover = null;
    if (destino && destino !== desde) ctx.conectar(desde, destino);
    render();
  }

  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const m = aMundo(e.clientX, e.clientY);
    const pin = cerca(e.target, '.pin');
    if (pin) {
      e.preventDefault();
      const ref = pin.getAttribute('data-ref');
      if (cable) return terminarCable(ref);
      if (!ctx.puedeEmpezarCable(ref)) return;
      cable = { desde: ref, x: m.x, y: m.y, arrastrando: true, movido: false, sx: e.clientX, sy: e.clientY };
      render();
      return;
    }
    if (cable) {
      // Click fuera de un pin: se cancela el cable.
      cable = null;
      hover = null;
      render();
      return;
    }
    const asa = cerca(e.target, '.asa-rotar');
    if (asa) {
      e.preventDefault();
      const inst = ctx.diagrama().modules.find((x) => x.id === asa.getAttribute('data-id'));
      const def = inst ? ctx.def(inst.type) : null;
      if (!inst || !def) return;
      const cx = inst.x + def.width / 2;
      const cy = inst.y + def.height / 2;
      // base: ángulo del mouse menos la rotación actual, así el giro sigue al mouse sin saltar.
      const base = (Math.atan2(m.y - cy, m.x - cx) * 180) / Math.PI - rotacionDe(inst);
      arrastre = { tipo: 'rotar', id: inst.id, cx, cy, base, sx: e.clientX, sy: e.clientY, movido: false };
      return;
    }
    const ctrl = cerca(e.target, '.ctrl');
    const mod = cerca(e.target, '.modulo');
    if (ctrl && mod) {
      e.preventDefault();
      const inst = ctx.diagrama().modules.find((x) => x.id === mod.getAttribute('data-id'));
      if (inst) {
        controlActivo = { inst, control: ctrl.getAttribute('data-control'), indice: Number(ctrl.getAttribute('data-indice') ?? 0) };
        ctx.control(inst, controlActivo.control, controlActivo.indice, 'down');
      }
      return;
    }
    const cab = cerca(e.target, '.cable');
    if (cab) {
      ctx.seleccionar({ tipo: 'cable', indice: Number(cab.getAttribute('data-indice')) });
      return;
    }
    if (mod) {
      e.preventDefault();
      const inst = ctx.diagrama().modules.find((x) => x.id === mod.getAttribute('data-id'));
      if (!inst) return;
      arrastre = { tipo: 'modulo', id: inst.id, dx: m.x - inst.x, dy: m.y - inst.y, sx: e.clientX, sy: e.clientY, movido: false };
      return;
    }
    e.preventDefault();
    arrastre = { tipo: 'pan', sx: e.clientX, sy: e.clientY, vx: vista.x, vy: vista.y, movido: false };
    svg.classList.add('paneando');
  });

  window.addEventListener('mousemove', (e) => {
    if (cable) {
      const m = aMundo(e.clientX, e.clientY);
      cable.x = m.x;
      cable.y = m.y;
      if (Math.hypot(e.clientX - cable.sx, e.clientY - cable.sy) > 4) cable.movido = true;
      const pin = cerca(e.target, '.pin');
      hover = pin ? pin.getAttribute('data-ref') : null;
      actualizarTemporal();
      return;
    }
    if (!arrastre) return;
    if (Math.hypot(e.clientX - arrastre.sx, e.clientY - arrastre.sy) > 3) arrastre.movido = true;
    if (!arrastre.movido) return;
    if (arrastre.tipo === 'pan') {
      vistaAutomatica = false;
      vista.x = arrastre.vx + (e.clientX - arrastre.sx);
      vista.y = arrastre.vy + (e.clientY - arrastre.sy);
      aplicarVista();
    } else if (arrastre.tipo === 'rotar') {
      const m = aMundo(e.clientX, e.clientY);
      const angulo = (Math.atan2(m.y - arrastre.cy, m.x - arrastre.cx) * 180) / Math.PI - arrastre.base;
      const paso = e.shiftKey ? 1 : 15;
      ctx.rotarModulo(arrastre.id, (((Math.round(angulo / paso) * paso) % 360) + 360) % 360, false);
    } else {
      const m = aMundo(e.clientX, e.clientY);
      ctx.moverModulo(arrastre.id, Math.round(m.x - arrastre.dx), Math.round(m.y - arrastre.dy), false);
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (controlActivo) {
      ctx.control(controlActivo.inst, controlActivo.control, controlActivo.indice, 'up');
      controlActivo = null;
    }
    if (cable?.arrastrando) {
      const pin = cerca(e.target, '.pin');
      const destino = pin?.getAttribute('data-ref');
      if (cable.movido && destino && destino !== cable.desde) return terminarCable(destino);
      if (cable.movido) {
        // Soltó el cable en el aire: se cancela.
        cable = null;
        hover = null;
        render();
        return;
      }
      // Fue un click: el cable sigue al mouse hasta el próximo click en un pin.
      cable.arrastrando = false;
      return;
    }
    if (!arrastre) return;
    const a = arrastre;
    arrastre = null;
    svg.classList.remove('paneando');
    if (a.tipo === 'rotar') {
      const inst = ctx.diagrama().modules.find((x) => x.id === a.id);
      if (inst && a.movido) ctx.rotarModulo(a.id, rotacionDe(inst), true);
    } else if (a.tipo === 'modulo') {
      if (a.movido) {
        const inst = ctx.diagrama().modules.find((x) => x.id === a.id);
        if (inst) ctx.moverModulo(a.id, inst.x, inst.y, true);
      } else {
        ctx.seleccionar({ tipo: 'modulo', id: a.id });
      }
    } else if (!a.movido) {
      ctx.seleccionar(null);
    }
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomEn(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  }, { passive: false });

  svg.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('text/x-modulo')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  svg.addEventListener('drop', (e) => {
    const type = e.dataTransfer?.getData('text/x-modulo');
    if (!type) return;
    e.preventDefault();
    const m = aMundo(e.clientX, e.clientY);
    ctx.soltarModulo(type, m.x, m.y);
  });

  // --- Vista ---------------------------------------------------------------------

  function zoomEn(factor: number, clientX?: number, clientY?: number) {
    const r = svg.getBoundingClientRect();
    const mx = (clientX ?? r.left + r.width / 2) - r.left;
    const my = (clientY ?? r.top + r.height / 2) - r.top;
    vistaAutomatica = false;
    const z = Math.min(3, Math.max(0.25, vista.z * factor));
    vista.x = mx - (mx - vista.x) * (z / vista.z);
    vista.y = my - (my - vista.y) * (z / vista.z);
    vista.z = z;
    aplicarVista();
  }

  /** Encuadra todos los módulos. */
  function ajustar() {
    const { modules } = ctx.diagrama();
    const r = svg.getBoundingClientRect();
    if (modules.length === 0 || r.width === 0) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const m of modules) {
      const d = ctx.def(m.type) ?? defDesconocido(m.type);
      const [sw, sh] = semiCaja(d, rotacionDe(m));
      const cx = m.x + d.width / 2;
      const cy = m.y + d.height / 2;
      x0 = Math.min(x0, cx - sw - 20);
      y0 = Math.min(y0, cy - sh - 34);
      x1 = Math.max(x1, cx + sw + 20);
      y1 = Math.max(y1, cy + sh + 34);
    }
    const margen = 40;
    vista.z = Math.min(1.4, (r.width - margen * 2) / (x1 - x0), (r.height - margen * 2) / (y1 - y0));
    vista.x = (r.width - (x1 - x0) * vista.z) / 2 - x0 * vista.z;
    vista.y = (r.height - (y1 - y0) * vista.z) / 2 - y0 * vista.z;
    aplicarVista();
    vistaAutomatica = true;
  }

  // Reencuadre automático al cambiar el tamaño (ver vistaAutomatica), una vez por frame.
  let frameTamano = 0;
  new ResizeObserver(() => {
    if (!vistaAutomatica || frameTamano) return;
    frameTamano = requestAnimationFrame(() => {
      frameTamano = 0;
      if (vistaAutomatica) ajustar();
    });
  }).observe(svg);

  /** Centro de lo que se ve, en coordenadas de mundo (para agregar módulos). */
  function centroVisible() {
    const r = svg.getBoundingClientRect();
    return aMundo(r.left + r.width / 2, r.top + r.height / 2);
  }

  function cancelarCable() {
    if (!cable) return false;
    cable = null;
    hover = null;
    render();
    return true;
  }

  return { render, pedirRender, moverVisual, ajustar, centroVisible, cancelarCable, zoom: (f) => zoomEn(f) };
}
