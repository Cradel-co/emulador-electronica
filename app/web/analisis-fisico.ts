import { firmaDiagramaElectrico, type Project, type RespuestaVistaTransitorio } from '@emu/shared';

/** Sólo datos del proyecto: ninguna dependencia del estado global ni del reloj de firmware. */
export function firmaVistaAnalisis(proyecto: Project | null, diagrama: Pick<Project, 'modules' | 'wires'>): string {
  return JSON.stringify({ nombre: proyecto?.name, board: proyecto?.board, boards: proyecto?.boards,
    sim: proyecto?.sim, dibujo: firmaDiagramaElectrico(diagrama) });
}
export interface SerieVistaFisica { id: string; nombre: string; unidad: 'V' | 'A' | 'W' | '°C'; valores: number[] }
export function seriesFisicas(r: RespuestaVistaTransitorio): SerieVistaFisica[] {
  return [
    ...Object.entries(r.termica ?? {}).map(([id, t]) => ({ id: `temperatura:${id}`, nombre: `${id} · temperatura`, unidad: '°C' as const, valores: t.temperaturaC })),
    ...Object.entries(r.pines).map(([id, valores]) => ({ id: `pin:${id}`, nombre: `${id} respecto a tierra`, unidad: 'V' as const, valores })),
    ...Object.entries(r.elementos).flatMap(([id, e]) => ([
      { id: `v:${id}`, nombre: `${id} · tensión`, unidad: 'V' as const, valores: e.v },
      { id: `i:${id}`, nombre: `${id} · corriente`, unidad: 'A' as const, valores: e.i },
      { id: `p:${id}`, nombre: `${id} · potencia`, unidad: 'W' as const, valores: e.p },
    ])),
  ];
}
/** Reduce por bloques manteniendo extremos y huecos; el archivo exportado no se reduce. */
export function trazaFisica(t: readonly number[], valores: readonly (number | null)[], ancho = 600): {
  path: string; min: number; max: number; inicio: number; fin: number;
} {
  const validos = valores.filter((v): v is number => v !== null && Number.isFinite(v));
  let min = validos.length ? Math.min(...validos) : 0;
  let max = validos.length ? Math.max(...validos) : 1;
  if (min === max) { const margen = Math.max(Math.abs(min) * 0.05, 0.001); min -= margen; max += margen; }
  const inicio = t[0] ?? 0, fin = t[t.length - 1] ?? inicio;
  const bloque = Math.max(1, Math.ceil(t.length / Math.max(1, ancho)));
  const indices = new Set<number>();
  for (let a = 0; a < t.length; a += bloque) {
    const b = Math.min(t.length, a + bloque); indices.add(a); indices.add(b - 1);
    let lo = a, hi = a;
    for (let i = a; i < b; i++) {
      const v = valores[i];
      if (v == null || !Number.isFinite(v)) { indices.add(i); if (i > a) indices.add(i - 1); if (i + 1 < b) indices.add(i + 1); continue; }
      if (valores[lo] == null || v < (valores[lo] ?? Infinity)) lo = i;
      if (valores[hi] == null || v > (valores[hi] ?? -Infinity)) hi = i;
    }
    indices.add(lo); indices.add(hi);
  }
  let path = '', separado = true;
  for (const i of [...indices].sort((a, b) => a - b)) {
    const v = valores[i], tiempo = t[i];
    if (v == null || tiempo === undefined || !Number.isFinite(v) || !Number.isFinite(tiempo)) { separado = true; continue; }
    const x = 95 + (tiempo - inicio) / (fin - inicio || 1) * 525;
    const y = 220 - (v - min) / (max - min) * 190;
    path += `${separado ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)} `; separado = false;
  }
  return { path, min, max, inicio, fin };
}
