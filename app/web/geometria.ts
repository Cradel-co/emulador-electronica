// Geometría del circuito: dónde cae cada pin en el mundo, hacia dónde sale su cable y
// con qué curva se dibuja. Todo acá es cálculo puro — no toca el DOM ni guarda estado —
// así que se puede probar sin navegador (tests/unit/geometria.test.ts) y sirve igual si
// algún día el dibujo se hace con Canvas2D o WebGL en vez de SVG: lo único que cambiaría
// es quién pinta, no dónde van las cosas.
//
// Lo que sigue en canvas.ts es lo que sí depende del navegador: la vista (zoom y paneo),
// los eventos del mouse y la emisión de nodos.

/** @typedef {{ id: string, type: string, x: number, y: number, rotation?: number, props?: Record<string, any> }} Instancia */

/** Ángulo del módulo normalizado a 0..359 (acepta negativos y vueltas de más). */
export const rotacionDe = (inst) => (((inst?.rotation ?? 0) % 360) + 360) % 360;

/** Gira el vector (x, y) `grados` en sentido horario (el eje y del SVG apunta abajo). */
export function girar(x, y, grados) {
  const r = (grados * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

/**
 * Punto en coordenadas del dibujo del módulo (sin rotar) → coordenadas del mundo.
 * Cada módulo gira alrededor del centro de su dibujo, así los pines quedan en el lugar
 * correcto a cualquier ángulo.
 */
export function aMundoModulo(inst, def, lx, ly) {
  const cx = def.width / 2;
  const cy = def.height / 2;
  const [dx, dy] = girar(lx - cx, ly - cy, rotacionDe(inst));
  return { x: inst.x + cx + dx, y: inst.y + cy + dy };
}

/** Medio ancho y medio alto de la caja que ocupa el módulo ya rotado. */
export function semiCaja(def, grados) {
  const r = (grados * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return [(def.width / 2) * c + (def.height / 2) * s, (def.width / 2) * s + (def.height / 2) * c];
}

/**
 * `"btn1.OUT"` → la instancia, su definición, el pin y dónde cae en el mundo.
 * Recibe los módulos y el buscador de definiciones en vez de leerlos de un estado global:
 * así la misma función sirve para el render, para los tests y para un hit-test futuro.
 */
export function resolverPin(ref, modules, def) {
  const punto = ref.indexOf('.');
  if (punto <= 0) return null;
  const id = ref.slice(0, punto);
  const nombre = ref.slice(punto + 1);
  const inst = modules.find((m) => m.id === id);
  if (!inst) return null;
  const d = def(inst.type);
  const pin = d?.pins.find((p) => p.name === nombre);
  if (!pin) return null;
  const m = aMundoModulo(inst, d, pin.x, pin.y);
  return { inst, def: d, pin, x: m.x, y: m.y };
}

/** Dirección hacia la que "sale" el cable de un pin, para curvarlo: el borde donde está, ya rotado. */
export function salida(r) {
  const { pin, def, inst } = r;
  const d = pin.x <= 0 ? [-1, 0] : pin.x >= def.width ? [1, 0] : pin.y <= 0 ? [0, -1] : [0, 1];
  return girar(d[0], d[1], rotacionDe(inst));
}

/**
 * El `d` de la curva Bézier entre dos pines. Los puntos de control salen en la dirección
 * de cada pin, con una distancia proporcional al largo del cable (mínimo 40) para que los
 * cables cortos no queden con un rulo.
 */
export function curva(x1, y1, d1, x2, y2, d2) {
  const k = Math.max(40, Math.hypot(x2 - x1, y2 - y1) * 0.4);
  return `M${x1} ${y1} C${x1 + d1[0] * k} ${y1 + d1[1] * k} ${x2 + d2[0] * k} ${y2 + d2[1] * k} ${x2} ${y2}`;
}

/** Con qué color se dibuja un cable: manda la masa, después la alimentación, el resto es señal. */
export function tipoCable(a, b) {
  const kinds = [a.pin.kind, b.pin.kind];
  if (kinds.includes('ground')) return 'ground';
  if (kinds.includes('power')) return 'power';
  return 'signal';
}

/** Un punto de la Bézier cúbica definida por P0..P3 en el parámetro `t`. */
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Punto a mitad del **recorrido** de la curva de un cable, sin pedírselo al DOM
 * (`getPointAtLength` fuerza un layout sincrónico).
 *
 * No alcanza con evaluar la curva en t = 0,5: en una Bézier asimétrica el parámetro no avanza
 * parejo con la distancia, y el punto se corre bastante del medio visual (medido: 32 px de
 * promedio y hasta 148 px, un 17 % del largo del cable). Así que se recorre la curva en tramos
 * y se devuelve donde se acumuló la mitad del largo, que es lo que hacía el DOM.
 *
 * 48 tramos dejan el error por debajo del píxel, y esto corre solo en los cables en corto.
 */
export function medioDeCurva(x1, y1, d1, x2, y2, d2) {
  const k = Math.max(40, Math.hypot(x2 - x1, y2 - y1) * 0.4);
  const c1x = x1 + d1[0] * k;
  const c1y = y1 + d1[1] * k;
  const c2x = x2 + d2[0] * k;
  const c2y = y2 + d2[1] * k;
  const TRAMOS = 48;
  const xs = [x1];
  const ys = [y1];
  const largos = [0];
  let total = 0;
  for (let i = 1; i <= TRAMOS; i++) {
    const t = i / TRAMOS;
    const x = bezier(x1, c1x, c2x, x2, t);
    const y = bezier(y1, c1y, c2y, y2, t);
    total += Math.hypot(x - xs[i - 1], y - ys[i - 1]);
    xs.push(x);
    ys.push(y);
    largos.push(total);
  }
  const mitad = total / 2;
  let i = 1;
  while (i < TRAMOS && largos[i] < mitad) i++;
  // Interpolación lineal dentro del tramo donde se cruza la mitad.
  const previo = largos[i - 1];
  const tramo = largos[i] - previo;
  const f = tramo > 0 ? (mitad - previo) / tramo : 0;
  return { x: xs[i - 1] + (xs[i] - xs[i - 1]) * f, y: ys[i - 1] + (ys[i] - ys[i - 1]) * f };
}
