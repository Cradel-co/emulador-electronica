import type { ElementoResuelto } from './netlist.js';

/**
 * Alcance DC de una entrada respecto de referencias físicas conocidas. Las fugas que SPICE
 * agrega para converger no son aristas. Una C abierta, una fuente de corriente ideal o una
 * resistencia que termina en otra isla no fijan el potencial de la entrada.
 *
 * El corte de 100 MΩ conserva el umbral de alta impedancia del modelo existente: no describe
 * inmunidad al ruido ni sustituye la impedancia incremental de un análisis de pequeña señal.
 */
export function nodosReferenciadosDc(elementos: readonly ElementoResuelto[], referencias: readonly string[]): ReadonlySet<string> {
  const vecinos = new Map<string, Set<string>>();
  for (const e of elementos) {
    // Los clamps del pad no proporcionan un pull en su región normal de operación.
    if (/^prot_(alto|bajo)_/.test(e.local)) continue;
    const resistivo = e.ohms !== undefined && e.ohms > 0 && e.ohms < 1e8;
    const conductorIdeal = e.tipo === 'L' || e.tipo === 'V';
    const semiconductorConduciendo = (e.tipo === 'D' || e.tipo === 'SV') && Math.abs(e.i) > 1e-8;
    if (!resistivo && !conductorIdeal && !semiconductorConduciendo) continue;
    for (const [a, b] of [[e.a, e.b], [e.b, e.a]] as const) {
      const v = vecinos.get(a) ?? new Set<string>();
      v.add(b);
      vecinos.set(a, v);
    }
  }
  const visitados = new Set(referencias);
  const pendientes = [...referencias];
  let procesados = 0;
  for (;;) {
    while (procesados < pendientes.length) {
      const n = pendientes[procesados++];
      if (n === undefined) continue;
      for (const vecino of vecinos.get(n) ?? []) if (!visitados.has(vecino)) {
        visitados.add(vecino);
        pendientes.push(vecino);
      }
    }
    let cambio = false;
    // La salida sólo es referencia si entrada y tierra ya están referenciadas y la
    // regulación está energizada. No se une el cobre de Vin con el de Vout.
    for (const e of elementos) if (e.regulador?.activo && visitados.has(e.a)
      && visitados.has(e.regulador.tierra) && !visitados.has(e.b)) {
      visitados.add(e.b);
      pendientes.push(e.b);
      cambio = true;
    }
    if (!cambio) break;
  }
  return visitados;
}
