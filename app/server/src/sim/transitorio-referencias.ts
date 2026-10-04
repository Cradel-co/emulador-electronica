import type { ElementoArmado } from './netlist.js';

/**
 * Referencia absoluta durante todo el transitorio de topología fija. C/L relacionan sus
 * terminales mediante el modelo y la inicialización elegida, que valida el netlist.
 * El corte de 100 MΩ conserva el criterio de alta impedancia DC y excluye rshunt/1 TΩ.
 * I y controles REG/SV no unen potenciales; D/X tampoco se presuponen conductores durante
 * todo el barrido. Si no hay otro camino verificable, se conserva sólo la medida relativa.
 */
export function nodosReferenciadosTransitorio(elementos: readonly ElementoArmado[], referencias: readonly string[]): ReadonlySet<string> {
  const vecinos = new Map<string, Set<string>>();
  for (const el of elementos) {
    const resistivo = (el.tipo === 'R' || el.tipo === 'S') && el.ohms !== undefined && el.ohms > 0 && el.ohms < 1e8;
    if (!resistivo && el.tipo !== 'C' && el.tipo !== 'L' && el.tipo !== 'V') continue;
    for (const [a, b] of [[el.a, el.b], [el.b, el.a]] as const) {
      const cercanos = vecinos.get(a) ?? new Set<string>();
      cercanos.add(b);
      vecinos.set(a, cercanos);
    }
  }
  const visitados = new Set(referencias);
  const pendientes = [...referencias];
  for (let k = 0; k < pendientes.length; k++) {
    const nodo = pendientes[k];
    if (nodo === undefined) continue;
    for (const vecino of vecinos.get(nodo) ?? []) if (!visitados.has(vecino)) {
      visitados.add(vecino);
      pendientes.push(vecino);
    }
  }
  return visitados;
}
