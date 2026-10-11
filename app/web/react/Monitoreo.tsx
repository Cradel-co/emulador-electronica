import { MicrofonoPanel } from './Microfono.js';
import { useState, useSyncExternalStore } from 'react';
import { leerMonitoreo, suscribirMonitoreo } from '../monitoreo-store.js';
import { segmentosSerie, type HistorialMonitor, type SerieMonitor } from '../monitoreo.js';

function Grafica({ historial, serie }: { historial: HistorialMonitor; serie: SerieMonitor }) {
  const segmentos = segmentosSerie(historial.muestras, serie.id);
  const puntos = segmentos.flat();
  const desde = historial.muestras[0]?.tiempoMs ?? 0;
  const hasta = historial.muestras.at(-1)?.tiempoMs ?? desde;
  const min = Math.min(0, ...puntos.map(p => p.valor));
  const max = Math.max(serie.unidad === 'V' ? 3 : 130, ...puntos.map(p => p.valor));
  const x = (t: number) => 42 + (t - desde) / Math.max(1, hasta - desde) * 490;
  const y = (v: number) => 98 - (v - min) / Math.max(1, max - min) * 80;
  const ultimo = historial.muestras.at(-1)?.valores[serie.id];
  return <figure className="monitor-serie">
    <figcaption>{serie.nombre}: <strong>{typeof ultimo === 'number' ? `${ultimo.toFixed(2)} ${serie.unidad}` : 'Sin lectura válida'}</strong></figcaption>
    <svg viewBox="0 0 550 125" role="img" aria-label={`Historial de ${serie.nombre} en ${serie.unidad}`}>
      <path d="M42 18V98H532" fill="none" stroke="currentColor" opacity="0.4" />
      <text x="2" y="22">{max.toFixed(1)}</text><text x="2" y="100">{min.toFixed(1)}</text>
      <text x="42" y="119">{(desde / 1000).toFixed(1)} s</text><text x="470" y="119">{(hasta / 1000).toFixed(1)} s</text>
      {segmentos.map((tramo, i) => <g key={i}><polyline points={tramo.map(p => `${x(p.t)},${y(p.valor)}`).join(' ')} fill="none" stroke="var(--monitor-color, #67c1ff)" strokeWidth="2" />
        {tramo.map((p, j) => <circle key={j} cx={x(p.t)} cy={y(p.valor)} r="2" fill="var(--monitor-color, #67c1ff)" />)}</g>)}
    </svg>
  </figure>;
}
function descargar(historial: HistorialMonitor): void {
  const contenido = { ...historial, reloj: 'recepcion-navegador', dominio: 'historial-instantaneas-dc', version: 1 };
  const url = URL.createObjectURL(new Blob([JSON.stringify(contenido, null, 2)], { type: 'application/json' }));
  const enlace = document.createElement('a'); enlace.href = url; enlace.download = `${historial.proyecto}-monitoreo.json`;
  enlace.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function Monitoreo() {
  const vivo = useSyncExternalStore(suscribirMonitoreo, leerMonitoreo, leerMonitoreo);
  const [congelado, congelar] = useState<HistorialMonitor | null>(null);
  const [seleccion, seleccionar] = useState<string>('todas');
  // Una pausa de otra corrida jamás conserva datos en pantalla al cambiar el contexto.
  const pausa = congelado?.proyecto === vivo.proyecto && congelado.corrida === vivo.corrida && congelado.inicioMs === vivo.inicioMs ? congelado : null;
  const historial = pausa ?? vivo;
  const series = historial.series.filter(s => seleccion === 'todas' || !historial.series.some(serie => serie.id === seleccion) || s.id === seleccion);
  return <details id="monitor-detalles"><summary>Monitoreo de señales</summary><section className="monitor-panel" aria-label="Monitoreo de señales">
    <header><h4>Monitoreo</h4><label htmlFor="monitor-senal">Señal</label><select id="monitor-senal" value={historial.series.some(s => s.id === seleccion) ? seleccion : 'todas'} onChange={e => seleccionar(e.target.value)}>
      <option value="todas">Todas</option>{historial.series.map(s => <option key={s.id} value={s.id}>{s.nombre} ({s.unidad})</option>)}
    </select><button onClick={() => congelar(pausa ? null : vivo)} disabled={!historial.muestras.length}>{pausa ? 'Reanudar vista' : 'Pausar vista'}</button>
      <button onClick={() => descargar(historial)} disabled={!historial.series.length}>Descargar muestras</button></header>
    <MicrofonoPanel />
    <p>Instantáneas eléctricas · tiempo de recepción en el navegador. {pausa ? 'Vista pausada; la captura continúa.' : 'Vista en vivo.'}</p>
    {!historial.series.length && <p>Agregá un sonómetro SEN0232 para observar su nivel y su salida.</p>}
    {series.map(serie => <Grafica key={serie.id} historial={historial} serie={serie} />)}
    <small>{historial.muestras.length} muestras retenidas · {historial.descartadas} descartadas · Corrida {historial.corrida ?? 'sin lectura'}. Los huecos indican datos ausentes o inválidos.</small>
  </section></details>;
}
