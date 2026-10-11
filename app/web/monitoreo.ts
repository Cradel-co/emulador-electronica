import type { ObservacionElectrica, Project } from '@emu/shared';

export interface SerieMonitor { id: string; nombre: string; unidad: string; origen: string }
export interface MuestraMonitor { tiempoMs: number; valores: Record<string, number | null>; revision: string | null }
export interface HistorialMonitor {
  proyecto: string; corrida: number | null; inicioMs: number; series: SerieMonitor[];
  muestras: MuestraMonitor[]; descartadas: number;
}
export const LIMITE_MUESTRAS = 600;
export function historialVacio(proyecto = '', tiempoMs = 0): HistorialMonitor {
  return { proyecto, corrida: null, inicioMs: tiempoMs, series: [], muestras: [], descartadas: 0 };
}
/** Solo publica voltajes de una observación validada por el consumidor. El reloj es el de recepción. */
export function registrarObservacion(historial: HistorialMonitor, proyecto: string,
  modulos: Project['modules'], observacion: ObservacionElectrica | null, tiempoMs: number): HistorialMonitor {
  if (!Number.isFinite(tiempoMs)) return historial;
  const contextoValido = observacion?.resuelto === true && observacion.estado === 'valida' && observacion.contexto.proyecto === proyecto;
  const corrida = contextoValido ? observacion.contexto.corrida : historial.corrida;
  const base = historial.proyecto !== proyecto || (contextoValido && historial.corrida !== null && corrida !== historial.corrida)
    ? historialVacio(proyecto, tiempoMs) : historial;
  const series: SerieMonitor[] = [];
  const valores: Record<string, number | null> = {};
  const finito = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
  for (const modulo of modulos.filter(m => m.type === 'sonometro-sen0232')) {
    const nivel = `${modulo.id}.nivel`, salida = `${modulo.id}.salida`;
    series.push({ id: nivel, nombre: `${modulo.id} · nivel declarado`, unidad: 'dBA', origen: 'manual' },
      { id: salida, nombre: `${modulo.id} · OUT respecto a GND`, unidad: 'V', origen: 'instantanea-electrica' });
    valores[nivel] = finito(modulo.props?.dbA ?? 50);
    const out = finito(observacion?.tensiones[`${modulo.id}.OUT`]);
    const gnd = finito(observacion?.tensiones[`${modulo.id}.GND`]);
    valores[salida] = contextoValido && out !== null && gnd !== null ? finito(out - gnd) : null;
  }
  const tiempo = Math.max(0, tiempoMs - base.inicioMs);
  if (base.muestras.length && tiempo <= (base.muestras.at(-1)?.tiempoMs ?? 0)) return base;
  const muestras = [...base.muestras, { tiempoMs: tiempo, valores, revision: contextoValido ? observacion.contexto.revision : null }];
  const exceso = Math.max(0, muestras.length - LIMITE_MUESTRAS);
  return { ...base, corrida, series, muestras: muestras.slice(exceso), descartadas: base.descartadas + exceso };
}
/** Segmentos separados por huecos. No interpola datos ausentes ni mezcla unidades. */
export function segmentosSerie(muestras: MuestraMonitor[], id: string): { t: number; valor: number }[][] {
  const segmentos: { t: number; valor: number }[][] = [];
  let tramo: { t: number; valor: number }[] = [];
  for (const muestra of muestras) {
    const valor = muestra.valores[id];
    if (typeof valor !== 'number' || !Number.isFinite(valor)) { if (tramo.length) segmentos.push(tramo); tramo = []; }
    else tramo.push({ t: muestra.tiempoMs, valor });
  }
  if (tramo.length) segmentos.push(tramo);
  return segmentos;
}
