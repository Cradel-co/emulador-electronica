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
 *
 * No es "todos los que falten": se reclaman **todas las tierras** sin cablear, pero de las
 * alimentaciones solo si **ninguna** está conectada. Un módulo puede tener varias (VCC y 3V3) y
 * alcanza con una; el 3VO de una placa con regulador es una salida, no hace falta cablearlo.
 * Mismo criterio que `diagramOps.pinesSinAlimentar` en el server.
 */
export function pinesSinAlimentar(inst: Instancia, def: Def, wires: readonly Cable[]): string[] {
  const pins = def.pins ?? [];
  const sinCable = (p: Pin) => cablesDe(`${inst.id}.${p.name}`, wires).length === 0;
  const tierras = pins.filter((p) => p.kind === 'ground' && sinCable(p)).map((p) => p.name);
  const alimentaciones = pins.filter((p) => p.kind === 'power');
  const faltaAlimentacion = alimentaciones.length > 0 && alimentaciones.every(sinCable);
  return pins
    .filter((p) => tierras.includes(p.name) || (faltaAlimentacion && p.kind === 'power'))
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

/** La parte del descriptor de placa necesaria para nombrar y resolver sus GPIO. */
export interface DescriptorGpio { pins?: Record<string, { gpio?: number }> }
/** Un componente de dos pines que permite seguir una señal digital (por ejemplo, resistencia). */
export interface DefPaso extends Def { passthrough?: boolean }

/** GPIO de un pin del dibujo de la placa; sin descriptor conserva el fallback ESP32-S3. */
export function gpioDeRef(ref: string, descriptor: DescriptorGpio | null): number | null {
  if (!ref.startsWith(`${BOARD_ID}.`)) return null;
  const pin = ref.slice(BOARD_ID.length + 1);
  if (descriptor?.pins) {
    const g = descriptor.pins[pin]?.gpio;
    return typeof g === 'number' ? g : null;
  }
  const m = /^GPIO(\d{1,2})$/.exec(pin);
  return m ? Number(m[1]) : null;
}

/** Primer nombre del descriptor para ese GPIO, o GPIO<n> si no tiene uno. */
export function nombrePinGpio(g: number, descriptor: DescriptorGpio | null): string {
  const nombre = descriptor?.pins && Object.keys(descriptor.pins).find((k) => descriptor.pins[k]?.gpio === g);
  return nombre ?? `GPIO${g}`;
}

/**
 * Sigue cables y componentes passthrough de dos pines hasta el primer GPIO alcanzable.
 * Mantiene el orden de los cables y corta ciclos. Es una consulta de conectividad digital;
 * las caídas de tensión y corrientes las calcula el motor eléctrico del servidor.
 */
export function gpioDe(
  id: string, pin: string,
  modules: readonly Instancia[], wires: readonly Cable[],
  buscarDef: (type: string) => DefPaso | undefined,
  descriptor: DescriptorGpio | null,
  visitados = new Set<string>(),
): number | null {
  const ref = `${id}.${pin}`;
  if (visitados.has(ref)) return null;
  visitados.add(ref);
  for (const w of cablesDe(ref, wires)) {
    const otro = w.from === ref ? w.to : w.from;
    const g = gpioDeRef(otro, descriptor);
    if (g !== null) return g;
    const punto = otro.indexOf('.');
    const otroId = otro.slice(0, punto);
    const otroInst = modules.find((m) => m.id === otroId);
    const otroDef = otroInst && buscarDef(otroInst.type);
    if (!otroDef?.passthrough || otroDef.pins.length !== 2) continue;
    const siguientePin = otroDef.pins.find((p) => p.name !== otro.slice(punto + 1));
    if (siguientePin) {
      const g2 = gpioDe(otroId, siguientePin.name, modules, wires, buscarDef, descriptor, visitados);
      if (g2 !== null) return g2;
    }
  }
  return null;
}
