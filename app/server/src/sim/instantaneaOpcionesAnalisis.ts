import type { OpcionesAnalisis } from './analisis.js';

/** Una consulta DC conserva la misma entrada durante todas sus pasadas y observaciones. */
export function instantaneaOpcionesAnalisis(opciones: OpcionesAnalisis): OpcionesAnalisis {
  // Sólo datos del runtime: Map anidados, Set, direcciones y estados JSON; no copia el catálogo.
  return structuredClone(opciones);
}
