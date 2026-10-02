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
