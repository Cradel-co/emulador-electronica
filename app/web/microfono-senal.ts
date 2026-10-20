export interface VentanaAudio {
  dbfs: number | null; rms: number; pico: number; saturada: boolean;
  envolvente: { min: number; max: number }[];
}
/** RMS digital y envolvente de la ventana recibida; no equivale a presión acústica ni ponderación A. */
export function analizarAudio(muestras: Float32Array): VentanaAudio {
  if (!muestras.length || muestras.length > 32768) throw new Error('Ventana de audio inválida');
  let suma = 0, pico = 0;
  for (const m of muestras) {
    if (!Number.isFinite(m) || Math.abs(m) > 1.01) throw new Error('El micrófono entregó muestras inválidas');
    suma += m * m; pico = Math.max(pico, Math.abs(m));
  }
  const rms = Math.sqrt(suma / muestras.length);
  const dbfs = rms <= 1e-8 ? null : Math.min(0, Math.max(-160, 20 * Math.log10(rms)));
  const paso = Math.ceil(muestras.length / 128), envolvente: VentanaAudio['envolvente'] = [];
  for (let i = 0; i < muestras.length; i += paso) {
    let min = 1, max = -1;
    for (let j = i; j < Math.min(i + paso, muestras.length); j++) {
      const m = muestras[j]; if (m === undefined) continue;
      min = Math.min(min, m); max = Math.max(max, m);
    }
    envolvente.push({ min, max });
  }
  return { rms, pico, dbfs, saturada: pico >= .98, envolvente };
}
