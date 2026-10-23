import { ResultadoBancoComponentesSchema, type SolicitudBancoComponentes, type ResultadoBancoComponentes } from '@emu/shared';

export async function consultarBancoComponentes(solicitud: SolicitudBancoComponentes, signal: AbortSignal, pedir: typeof fetch = fetch): Promise<ResultadoBancoComponentes> {
  const r = await pedir('/api/componentes/banco-led', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(solicitud), signal });
  const datos: unknown = await r.json();
  if (!r.ok) throw new Error(typeof datos === 'object' && datos !== null && 'error' in datos ? String(datos.error) : `Error HTTP ${r.status}`);
  return ResultadoBancoComponentesSchema.parse(datos);
}
