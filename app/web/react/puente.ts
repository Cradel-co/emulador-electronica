/**
 * Punto de encuentro entre `app.ts` y el componente que monta el canvas, para que ninguno de los
 * dos tenga que importar al otro: así no hay ciclo de importación y `canvas.ts` sigue sin saber
 * que existe React.
 *
 * `app.ts` deja acá el contexto del lienzo (sus callbacks) y dice qué hacer cuando el lienzo esté
 * creado; `Lienzo.tsx` toma el contexto, crea el lienzo contra su propio `<svg>` y lo entrega.
 */

type Ctx = Record<string, unknown>;
type Lienzo = Record<string, unknown>;

let ctx: Ctx | null = null;
let est: Record<string, any> | null = null;
let alEntregar: ((l: Lienzo) => void) | null = null;

/**
 * Acciones de `app.ts` que los componentes necesitan disparar (agregar un módulo, quitarlo del
 * catálogo...). Van por acá y no importándolas, para no crear un ciclo: `app.ts` las registra al
 * arrancar y los componentes las piden cuando el usuario hace algo.
 */
export interface Acciones {
  agregarModulo: (type: string) => void;
  quitarDelCatalogo: (m: { type: string; name: string }) => void;
  filtrarModulos: (texto: string) => void;
  abrirProyecto: (nombre: string) => void;
  eliminarProyecto: (nombre: string) => void;
}

let acc: Acciones | null = null;

export function registrarAcciones(a: Acciones): void {
  acc = a;
}

export function acciones(): Acciones {
  if (!acc) throw new Error('un componente pidió una acción antes de que app.ts las registrara');
  return acc;
}

/** `app.ts`: su objeto de estado (ya envuelto en `observable`), para que lo lean los componentes. */
export function registrarEstado(e: Record<string, any>): void {
  est = e;
}

/** El estado de la app. Los componentes lo leen con `useEstado(() => estado().campo)`. */
export function estado(): Record<string, any> {
  if (!est) throw new Error('un componente leyó el estado antes de que app.ts lo registrara');
  return est;
}

/** `app.ts`: el contexto que `crearLienzo` necesita (diagrama, catálogo, callbacks de edición). */
export function registrarCtx(c: Ctx): void {
  ctx = c;
}

/** `app.ts`: qué hacer cuando el lienzo exista (guardárselo para usarlo en todo el archivo). */
export function alLienzoListo(cb: (l: Lienzo) => void): void {
  alEntregar = cb;
}

export function tomarCtx(): Ctx {
  if (!ctx) throw new Error('el lienzo se montó antes de que app.ts registrara su contexto');
  return ctx;
}

export function entregarLienzo(l: Lienzo): void {
  alEntregar?.(l);
}
