import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CameraDescriptor } from '@emu/shared';
import { acciones } from './puente.js';

export function SeccionCamara({ project, instance, camera }: { project: string; instance: string; camera: CameraDescriptor }) {
  const [control] = useState(() => acciones().crearCamara(project, instance, camera));
  const s = useSyncExternalStore(control.suscribir, control.leer, control.leer);
  const video = useRef<HTMLVideoElement>(null);
  const [device, setDevice] = useState('');
  const [listo, setListo] = useState(false);
  useEffect(() => {
    void control.dispositivos(); void control.cargarUltima(); void control.reanudarSiAutorizada();
  }, [control]);
  useEffect(() => {
    setListo(false);
    if (video.current) {
      video.current.srcObject = s.stream;
      if (s.stream) void video.current.play().catch(() => {});
    }
  }, [s.stream]);
  return <section className="camara-panel" aria-label={camera.hardware ? "ArduCAM" : "Cámara virtual"}>
    <h3>Cámara del computador</h3>
    <label>Dispositivo <select aria-label="Dispositivo de cámara" value={device} disabled={s.phase !== 'inactive'} onChange={e => setDevice(e.target.value)}>
      <option value="">Cámara predeterminada</option>
      {s.devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Cámara ${i + 1}`}</option>)}
    </select></label>
    <div className="insp-control">
      <button type="button" disabled={s.phase !== 'inactive'} onClick={() => void control.activar(device)}>{camera.hardware ? "Activar webcam" : "Activar"}</button>
      <button type="button" disabled={s.phase !== 'active' || s.pending || !listo} onClick={() => { if (video.current) void control.capturar(video.current); }}>Capturar</button>
      <button type="button" disabled={s.phase === 'inactive'} onClick={() => void control.detener(true)}>Detener</button>
    </div>
    <p className="hint">El navegador recuerda el permiso. Al volver a este módulo, la cámara se mantiene activa o se reanuda si ya la autorizaste.</p>
    {camera.hardware && <p className="hint">La TFT se refresca aproximadamente una vez por segundo con capturas nuevas del firmware; no es video continuo por SPI.</p>}
    <p role="status">{s.phase === 'starting' ? 'Esperando permiso y conexión…' : s.phase === 'active' ? s.pending ? 'Enviando captura…' : 'Cámara activa' : 'Cámara desactivada'}</p>
    {s.error && <p role="alert">{s.error}</p>}
    <video ref={video} autoPlay muted playsInline aria-label="Vista previa de cámara" hidden={!s.stream} onLoadedData={() => setListo(true)} />
    <h3>Última captura recibida</h3>
    {s.image && s.capture ? <>
      <img src={s.image} alt="Fotografía recuperada del servidor" />
      <p>{s.capture.requestId ? "Solicitada por el firmware · " : ""}Captura {s.capture.number} · {s.capture.width} × {s.capture.height} · {new Date(s.capture.receivedAt).toLocaleTimeString()}</p>
      {s.capture.sha256 && <p>SHA-256: <code>{s.capture.sha256}</code> · {s.capture.size} bytes</p>}
      {s.capture.timings && <p className="camara-tiempos">Tiempos ms: fotograma={s.capture.timings.frameMs?.toFixed(2) ?? '—'} JPEG navegador={s.capture.timings.browserJpegMs?.toFixed(2) ?? '—'} backend validar/decodificar={s.capture.timings.backendValidateMs?.toFixed(2) ?? '—'} backend normalizar (decodificar + codificar)={s.capture.timings.backendNormalizeMs?.toFixed(2) ?? '—'} red/otros≈{s.capture.timings.outsideSharpMs?.toFixed(2) ?? '—'} POST total={s.capture.timings.uploadRoundTripMs?.toFixed(2) ?? '—'}</p>}
    </> : <p>Todavía no hay una fotografía recibida.</p>}
  </section>;
}
