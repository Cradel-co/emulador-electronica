/**
 * Preguntas sobre el dibujo: qué hay cableado a un pin, qué le falta a un módulo para funcionar,
 * cómo se lee una punta de cable. Todo acá es cálculo puro sobre el diagrama y el catálogo — no
 * toca el DOM ni lee ningún estado global — así que se puede probar sin navegador y lo pueden usar
 * tanto `app.ts` como los componentes de React sin pasar por el puente.
 *
 * Mismo criterio que `geometria.ts`: la lógica sale de `app.ts`, que se queda con los efectos
 * (pedirle cosas al server, guardar, pintar).
 */

/** Id fijo de la placa dentro del dibujo: los cables la referencian como "board.GPIO6". */
export const BOARD_ID = 'board';

/** Cómo se lee el tipo de un pin en la tabla del panel. */
export const NOMBRE_KIND: Record<string, string> = {
  'digital-in': 'entrada', 'digital-out': 'salida', 'digital-io': 'E/S',
  power: 'alimentación', ground: 'tierra', 'analog-in': 'analógica', other: '—',
};

export interface Cable { from: string; to: string }
export interface Instancia { id: string; type: string; rotation?: number; props?: Record<string, unknown> }
export interface Pin { name: string; kind: string }
export interface Def { name?: string; pins?: Pin[] }

/** Parte `"btn1.OUT"` en el id del módulo y el nombre del pin. */
export function partirRef(ref: string): { id: string; pin: string } | null {
  const punto = ref.indexOf('.');
  if (punto <= 0) return null;
  return { id: ref.slice(0, punto), pin: ref.slice(punto + 1) };
}

/** Los cables que llegan a una punta (`"led1.IN"`). */
export function cablesDe(ref: string, wires: readonly Cable[]): Cable[] {
  return wires.filter((w) => w.from === ref || w.to === ref);
}

/**
 * Los pines de alimentación o masa del módulo que quedaron al aire. Sin ellos no funciona en la
 * simulación, igual que en la mesa: es el aviso de "conectá también GND".
 */
export function pinesSinAlimentar(inst: Instancia, def: Def, wires: readonly Cable[]): string[] {
  return (def.pins ?? [])
    .filter((p) => p.kind === 'ground' || p.kind === 'power')
    .filter((p) => cablesDe(`${inst.id}.${p.name}`, wires).length === 0)
    .map((p) => p.name);
}

/** ¿Esta punta es un pin de alimentación de un módulo (no de la placa) que quedó sin cablear? */
export function esPinSinAlimentar(
  ref: string,
  modules: readonly Instancia[],
  buscarDef: (type: string) => Def | undefined,
  wires: readonly Cable[],
): boolean {
  const partes = partirRef(ref);
  if (!partes || partes.id === BOARD_ID || cablesDe(ref, wires).length > 0) return false;
  const inst = modules.find((m) => m.id === partes.id);
  const def = inst && buscarDef(inst.type);
  const pin = def?.pins?.find((p) => p.name === partes.pin);
  return pin?.kind === 'ground' || pin?.kind === 'power';
}

/**
 * Cómo se lee una punta de cable para una persona: `"btn1.OUT"` → `"Pulsador btn1 · OUT"`, y en
 * la placa `"board.GPIO6"` → `"ESP32-S3 · GPIO6"`.
 *
 * El sufijo `_N` de los pines repetidos (`GND_2`) no se muestra: es para que el nombre sea único
 * en el module.json, no para leerlo.
 */
export function nombreRef(
  ref: string,
  modules: readonly Instancia[],
  buscarDef: (type: string) => Def | undefined,
  nombrePlaca: string,
): string {
  const partes = partirRef(ref);
  if (!partes) return ref;
  const limpio = partes.pin.replace(/_\d+$/, '');
  if (partes.id === BOARD_ID) return `${nombrePlaca} · ${limpio}`;
  const inst = modules.find((m) => m.id === partes.id);
  const def = inst && buscarDef(inst.type);
  return `${def?.name ?? partes.id} ${partes.id} · ${limpio}`;
}
