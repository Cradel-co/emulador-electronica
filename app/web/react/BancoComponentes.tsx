import { useEffect, useRef, useState } from 'react';
import type { SolicitudBancoComponentes, ResultadoBancoComponentes } from '@emu/shared';
import { acciones } from './puente.js';

const inicial = (representacion: SolicitudBancoComponentes['representacion']): SolicitudBancoComponentes => ({
  hastaMs: 0, representacion, cambios: [{ instanteMs: 0, alimentacion: true, reset: false }],
});
const numero = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 3 });
export function BancoComponentes() {
  const [solicitud, setSolicitud] = useState(() => inicial('separada'));
  const [resultado, setResultado] = useState<ResultadoBancoComponentes | null>(null);
  const [ocupado, setOcupado] = useState(false), [error, setError] = useState('');
  const panel = useRef<HTMLElement | null>(null), captura = useRef<AbortController | null>(null);
  useEffect(() => {
    const cancelar = () => { captura.current?.abort(); captura.current = null; setOcupado(false); };
    const dialogo = panel.current?.closest('dialog'); dialogo?.addEventListener('close', cancelar);
    return () => { cancelar(); dialogo?.removeEventListener('close', cancelar); };
  }, []);
  async function ejecutar(s: SolicitudBancoComponentes) {
    captura.current?.abort(); const c = new AbortController(); captura.current = c;
    setOcupado(true); setError(''); setResultado(null);
    try {
      const r = await acciones().consultarBancoComponentes(s, c.signal);
      if (!c.signal.aborted && captura.current === c) { setSolicitud(s); setResultado(r); }
    } catch (e) { if (!c.signal.aborted && captura.current === c) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (captura.current === c) { captura.current = null; setOcupado(false); } }
  }
  const ultima = resultado?.muestras.at(-1), control = solicitud.cambios.at(-1);
  function cambiar(campo: 'reset' | 'alimentacion') {
    if (!control) return;
    const instanteMs = solicitud.hastaMs + 1;
    void ejecutar({ ...solicitud, hastaMs: instanteMs, cambios: [...solicitud.cambios, { ...control, instanteMs, [campo]: !control[campo] }] });
  }
  return <section className="banco-componentes" ref={panel} aria-labelledby="banco-titulo">
    <header><h2 id="banco-titulo">Banco de componentes propios</h2><button type="button" aria-label="Cerrar banco" onClick={() => panel.current?.closest('dialog')?.close()}>×</button></header>
    <p>Fuente → driver resistivo → resistencia de 330 Ω → LED. El esquema y su lógica se ejecutan con nuestra agenda y ngspice, sin esp-emu.</p>
    <p className="banco-limite">Circuito de demostración independiente del proyecto abierto. Driver didáctico: 10 Ω cerrado y 10 MΩ abierto, con fuga. Reset lógico; no es un GPIO ESP32 ni ejecuta firmware. Puntos DC, sin transitorios.</p>
    <fieldset disabled={ocupado}><legend>Simulación</legend>
      <label>Representación <select aria-label="Representación del driver" value={solicitud.representacion} onChange={e => void ejecutar(inicial(e.target.value as SolicitudBancoComponentes['representacion']))}>
        <option value="separada">Eléctrica equivalente + lógica interna</option><option value="completa">Interior completo</option>
      </select></label>
      <div className="banco-controles">
        <button type="button" onClick={() => void ejecutar(inicial(solicitud.representacion))}>Iniciar / reiniciar</button>
        <button type="button" disabled={!resultado || solicitud.hastaMs > 4750} onClick={() => void ejecutar({ ...solicitud, hastaMs: solicitud.hastaMs + 250 })}>Avanzar 250 ms</button>
        <button type="button" disabled={!resultado || solicitud.hastaMs >= 5000 || solicitud.cambios.length >= 32} onClick={() => cambiar('reset')}>{control?.reset ? 'Liberar reset' : 'Mantener reset'}</button>
        <button type="button" disabled={!resultado || solicitud.hastaMs >= 5000 || solicitud.cambios.length >= 32} onClick={() => cambiar('alimentacion')}>{control?.alimentacion ? 'Cortar alimentación' : 'Restaurar alimentación'}</button>
      </div>
    </fieldset>
    {ocupado && <p role="status">Resolviendo el esquema…</p>}{error && <p role="alert">{error}</p>}
    {!resultado && !ocupado && !error && <p>Iniciá el banco para ver las medidas y avanzar el parpadeo de 250 ms por estado.</p>}
    {ultima && <>
      <p role="status"><strong>{numero(ultima.instanteMs)} ms · {ultima.estado}</strong> · LED {ultima.ledEncendido ? 'encendido' : 'apagado'} · {numero(ultima.corrienteMa)} mA</p>
      <svg viewBox="0 0 760 230" role="img" aria-label={`Esquema jerárquico con LED ${ultima.ledEncendido ? 'encendido' : 'apagado'}`}>
        <path d="M80 135 V75 H150 M285 75 H340 M420 75 H540 V110 M540 155 V195 H80 V135" fill="none" stroke="currentColor" strokeWidth="3"/>
        <circle cx="80" cy="120" r="25" fill="var(--panel, #222)" stroke="currentColor"/><text x="80" y="125" textAnchor="middle">±</text>
        <rect x="150" y="50" width="135" height="50" rx="8" fill="var(--panel, #222)" stroke="currentColor"/><text x="218" y="80" textAnchor="middle">Driver</text>
        <rect x="340" y="60" width="80" height="30" fill="none" stroke="currentColor"/><text x="380" y="45" textAnchor="middle">330 Ω</text>
        <circle cx="540" cy="133" r="24" fill={ultima.ledEncendido ? '#ff4d3d' : '#5a1f1a'} stroke="currentColor"/><text x="580" y="140">LED</text>
        <text x="15" y="35">{numero(ultima.fuenteV)} V</text><text x="295" y="125">Salida: {numero(ultima.salidaV)} V</text><text x="575" y="170">{numero(ultima.ledV)} V</text>
        <text x="80" y="220">Retorno común explícito</text>
      </svg>
      <details open><summary>Jerarquía y propietarios activos</summary><ul className="banco-jerarquia">{resultado.instancias.map(i => <li key={JSON.stringify(i.ruta)}><code>{i.ruta.join(' / ') || 'banco-led'}</code> · {i.tipo} · {i.dominios.join(' + ')}</li>)}</ul></details>
      <div className="informe-tabla"><table><caption>Historia calculada por el solver</caption><thead><tr><th>Tiempo (ms)</th><th>Driver</th><th>Salida (V)</th><th>LED (mA)</th></tr></thead>
        <tbody>{resultado.muestras.map(m => <tr key={m.instanteMs}><td>{m.instanteMs}</td><td>{m.estado}</td><td>{numero(m.salidaV)}</td><td>{numero(m.corrienteMa)}</td></tr>)}</tbody></table></div>
      {resultado.avisos.length > 0 && <ul>{resultado.avisos.map(a => <li key={a}>{a}</li>)}</ul>}
      <p>Hasta 5 s y 32 cambios por demostración. Reiniciar vuelve a 0 ms, alimentación activa y reset liberado.</p>
    </>}
  </section>;
}
