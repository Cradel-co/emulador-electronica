import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Project } from '@emu/shared';
import type { ControladorMicrofono } from '../microfono.js';
import { acciones, estado } from './puente.js';
import { useVersion } from './estado.js';

function Captura({ control }: { control: ControladorMicrofono }) {
  const s = useSyncExternalStore(control.suscribir, control.leer, control.leer);
  const [dispositivo, elegirDispositivo] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ocultar = () => { if (document.visibilityState === 'hidden') void control.detener('La captura se detuvo al ocultar esta pestaña.'); };
    const salir = () => { void control.detener(); };
    document.addEventListener('visibilitychange', ocultar); window.addEventListener('pagehide', salir);
    return () => { document.removeEventListener('visibilitychange', ocultar); window.removeEventListener('pagehide', salir); void control.detener(); };
  }, [control]);
  useEffect(() => {
    const c = canvas.current, ctx = c?.getContext('2d'); if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#738293'; ctx.beginPath(); ctx.moveTo(0, 50); ctx.lineTo(c.width, 50); ctx.stroke();
    if (!s.ventana) return;
    ctx.strokeStyle = '#67c1ff'; ctx.beginPath();
    s.ventana.envolvente.forEach((b, i, bins) => {
      const x = (i + .5) * c.width / bins.length;
      ctx.moveTo(x, 50 - b.max * 45); ctx.lineTo(x, 50 - b.min * 45);
    }); ctx.stroke();
  }, [s.ventana]);
  return <section className="microfono-panel" aria-label="Micrófono del computador">
    <div className="microfono-controles">
      <label htmlFor="microfono-dispositivo">Micrófono</label><select id="microfono-dispositivo" value={dispositivo} disabled={s.fase !== 'inactivo'} onChange={e => elegirDispositivo(e.target.value)}>
        <option value="">Predeterminado del computador</option>{s.dispositivos.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
      </select>
      <button disabled={s.fase !== 'inactivo'} onClick={() => { void control.activar(dispositivo || undefined); }}>Conectar micrófono</button>
      <button disabled={s.fase === 'inactivo'} onClick={() => { void control.detener(); }}>Detener micrófono</button>
      <span role="status">{s.fase === 'activo' ? 'Micrófono conectado' : s.fase === 'iniciando' ? 'Esperando permiso de micrófono…' : 'Entrada manual'}</span>
    </div>
    {s.error && <p role="alert">{s.error}</p>}
    <div className="microfono-controles">
      <label>Referencia digital (dBFS) <input type="number" min="-120" max="0" step="0.1" value={s.referencia.dbfs} onChange={e => control.referencia({ ...s.referencia, dbfs: e.target.valueAsNumber })} /></label>
      <label>Nivel de simulación en esa referencia <input type="number" min="0" max="180" step="0.1" value={s.referencia.nivel} onChange={e => control.referencia({ ...s.referencia, nivel: e.target.valueAsNumber })} /></label>
    </div>
    <p>Referencia de simulación: no mide dBA físicos ni aplica ponderación A. El sensor conserva sus límites eléctricos.</p>
    {s.ventana && <p className="microfono-lectura">{s.ventana.dbfs === null ? 'Silencio digital' : `${s.ventana.dbfs.toFixed(1)} dBFS`} · Estímulo: {control.nivelEstimado()?.toFixed(1)} dB estimados{s.ventana.saturada ? ' · Captura saturada' : ''}</p>}
    <figure><figcaption>Onda de audio relativa · envolvente mín/máx de la última ventana</figcaption>
      <canvas ref={canvas} width="512" height="100" aria-label="Envolvente de audio del micrófono" role="img" />
      {s.frecuenciaHz > 0 && <small>{s.frecuenciaHz} muestras/s · ventana de {(2048 / s.frecuenciaHz * 1000).toFixed(1)} ms · reloj de audio {s.tiempoAudioS.toFixed(2)} s.</small>}
    </figure>
    {s.fase === 'activo' && <small>Procesamiento concedido por el navegador: ganancia automática {String(s.ajustes.autoGainControl ?? 'no informado')}, cancelación de eco {String(s.ajustes.echoCancellation ?? 'no informado')}, reducción de ruido {String(s.ajustes.noiseSuppression ?? 'no informado')}.</small>}
  </section>;
}
export function MicrofonoPanel() {
  useVersion();
  const e = estado() as { proyecto: Project | null; diagrama: { modules: Project['modules'] } };
  const modulos = e.diagrama.modules.filter(m => m.type === 'sonometro-sen0232');
  const [seleccion, elegir] = useState('');
  const id = modulos.some(m => m.id === seleccion) ? seleccion : modulos[0]?.id ?? '';
  const proyecto = e.proyecto?.name ?? '';
  const control = useMemo(() => proyecto && id ? acciones().crearMicrofono(proyecto, id) : null, [proyecto, id]);
  if (!control) return null;
  return <div className="microfono-entrada">
    <label>Sonómetro de destino <select value={id} onChange={ev => elegir(ev.target.value)}>{modulos.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</select></label>
    <Captura key={`${proyecto}/${id}`} control={control} />
  </div>;
}
