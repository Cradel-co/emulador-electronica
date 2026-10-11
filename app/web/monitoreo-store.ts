import { historialVacio, registrarObservacion, type HistorialMonitor } from './monitoreo.js';
const oyentes = new Set<() => void>();
let historial = historialVacio();
export const leerMonitoreo = (): HistorialMonitor => historial;
export function suscribirMonitoreo(oyente: () => void): () => void {
  oyentes.add(oyente); return () => { oyentes.delete(oyente); };
}
function publicar(valor: HistorialMonitor): void {
  if (valor === historial) return;
  historial = valor; for (const oyente of oyentes) oyente();
}
export function reiniciarMonitoreo(proyecto = ''): void { publicar(historialVacio(proyecto, performance.now())); }
export function observarMonitoreo(...args: Parameters<typeof registrarObservacion> extends [unknown, ...infer R] ? R : never): void {
  publicar(registrarObservacion(historial, ...args));
}
