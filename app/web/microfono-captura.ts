export interface CapturaMicrofono {
  leer(): { muestras: Float32Array; tiempoAudioS: number; frecuenciaHz: number };
  ajustes: MediaTrackSettings;
  cerrar(): Promise<void>;
}
/** Adaptador Web Audio de entrada: conserva solo la última ventana, sin reproducir ni enviar audio. */
export async function abrirCapturaMicrofono(deviceId: string | undefined, fin: (mensaje: string) => void): Promise<CapturaMicrofono> {
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext) throw new Error('El micrófono requiere un navegador compatible y localhost o HTTPS.');
  const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  } });
  let contexto: AudioContext | null = null, fuente: MediaStreamAudioSourceNode | null = null;
  let cerrado = false, listo = false;
  const terminado = () => fin('El micrófono se desconectó. Volvé a conectarlo o usá el nivel manual.');
  const cerrar = async () => {
    if (cerrado) return; cerrado = true;
    for (const pista of stream.getTracks()) { pista.removeEventListener('ended', terminado); pista.stop(); }
    fuente?.disconnect();
    if (contexto) { contexto.onstatechange = null; await contexto.close().catch(() => {}); }
  };
  try {
    contexto = new AudioContext();
    const analizador = contexto.createAnalyser(); analizador.fftSize = 2048;
    fuente = contexto.createMediaStreamSource(stream); fuente.connect(analizador);
    for (const pista of stream.getAudioTracks()) pista.addEventListener('ended', terminado);
    contexto.onstatechange = () => { if (listo && !cerrado && contexto?.state !== 'running') fin('La captura de audio se suspendió. Conectá nuevamente el micrófono.'); };
    await contexto.resume(); listo = true;
    if (contexto.state !== 'running') throw new Error('El navegador no pudo iniciar la captura de audio.');
    const ctx = contexto, muestras = new Float32Array(analizador.fftSize);
    return { ajustes: stream.getAudioTracks()[0]?.getSettings() ?? {}, cerrar,
      leer: () => { analizador.getFloatTimeDomainData(muestras); return { muestras, tiempoAudioS: ctx.currentTime, frecuenciaHz: ctx.sampleRate }; } };
  } catch (e) { await cerrar(); throw e; }
}
export async function dispositivosMicrofono(): Promise<{ deviceId: string; label: string }[]> {
  const dispositivos = await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [];
  return dispositivos.filter(d => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Micrófono ${i + 1}` }));
}
