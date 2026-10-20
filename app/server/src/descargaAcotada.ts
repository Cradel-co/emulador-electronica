import type { ReadableStreamReadResult } from 'node:stream/web';
/** Presupuesto de bytes reales (incluida descompresión HTTP) y tiempo para todo el cuerpo. */
export async function descargarAcotado(url: string, limite: number, timeoutMs: number, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const direccion = new URL(url);
  if (direccion.protocol !== 'https:') throw new Error('solo se aceptan URLs https://');
  const control = new AbortController();
  const signal = AbortSignal.any([control.signal, AbortSignal.timeout(timeoutMs)]);
  const res = await fetcher(direccion, { signal, redirect: 'follow' });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completo = false;
  try {
    if (res.url && new URL(res.url).protocol !== 'https:') throw new Error('la descarga redirigió a una URL que no es https');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > limite) throw new Error(`el archivo es demasiado grande (máx. ${limite} bytes)`);
    if (!res.body) return new Uint8Array();
    reader = res.body.getReader();
    const partes: Uint8Array[] = [];
    let total = 0;
    while (true) {
      signal.throwIfAborted();
      const lector = reader;
      const bloque = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abortar = () => reject(signal.reason);
        signal.addEventListener('abort', abortar, { once: true });
        void lector.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abortar));
      });
      if (bloque.done) { completo = true; break; }
      total += bloque.value.byteLength;
      if (total > limite) throw new Error(`el archivo es demasiado grande (máx. ${limite} bytes)`);
      partes.push(bloque.value);
    }
    const datos = new Uint8Array(total);
    let offset = 0;
    for (const parte of partes) { datos.set(parte, offset); offset += parte.byteLength; }
    return datos;
  } finally {
    if (!completo) {
      control.abort();
      const cancelacion = reader ? reader.cancel() : res.body?.cancel();
      await cancelacion?.catch(() => {});
    }
    reader?.releaseLock();
  }
}
