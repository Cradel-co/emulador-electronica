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
  // Panel derecho
  eliminarModulo: (id: string) => void;
  eliminarCable: (indice: number) => void;
  desconectar: (indice: number) => void;
  girar: (inst: any, grados: number, fin: boolean) => void;
  cambiarProp: (inst: any, clave: string, valor: unknown) => void;
  controlModulo: (inst: any, control: string, indice: number) => void;
  presionarMomentario: (inst: any) => void;
  reemplazarQuemado: (id: string) => void;
  moverEntorno: (id: string, valores: Record<string, number>) => void;
  abrirArchivo: (ruta: string) => void;
  irALinea: (archivo: string | null, linea: number) => void;
  agregarPlaca: () => void;
  nuevoArchivo: () => void;
}

/**
 * Consultas que dependen del estado global de `app.ts` y son de presentación: cómo se llama la
 * placa, si el proyecto tiene una, qué decir mientras la simulación arranca. No son puras (las
 * puras están en `consultas.ts`), así que van por el puente como todo lo demás.
 */
export interface Vistas {
  nombrePlaca: () => string;
  sinPlaca: () => boolean;
  textoEsperaSimulacion: () => string;
}

let vis: Vistas | null = null;

export function registrarVistas(v: Vistas): void {
  vis = v;
}

export function vistas(): Vistas {
  if (!vis) throw new Error('un componente pidió una vista antes de que app.ts las registrara');
  return vis;
}

let acc: Acciones | null = null;

export function registrarAcciones(a: Acciones): void {
  acc = a;
}

export function acciones(): Acciones {
  if (!acc) throw new Error('un componente pidió una acción antes de que app.ts las registrara');
  return acc;
}

/** Una acción del registro único de `app.ts` (menú, paleta de comandos y atajos). */
export interface Accion {
  id: string;
  titulo: string;
  menu?: string;
  atajo?: string;
  hacer: () => void;
  habilitada?: () => boolean;
}

export interface Menu {
  grupos: string[];
  acciones: Accion[];
  cerrar: () => void;
}

let men: Menu | null = null;

export function registrarMenu(m: Menu): void {
  men = m;
}

export function menu(): Menu {
  if (!men) throw new Error('el menú se pintó antes de que app.ts lo registrara');
  return men;
}

export interface Paleta {
  /** Todo lo que se puede buscar ahora: acciones disponibles, proyectos, archivos, módulos. */
  candidatos: () => import('../paleta.js').Candidato[];
}

let pal: Paleta | null = null;

export function registrarPaleta(p: Paleta): void {
  pal = p;
}

export function paleta(): Paleta {
  if (!pal) throw new Error('la paleta se pintó antes de que app.ts la registrara');
  return pal;
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
