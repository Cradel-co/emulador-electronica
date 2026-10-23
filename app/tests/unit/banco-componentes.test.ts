import { describe, it, expect, vi } from 'vitest';
import { consultarBancoComponentes } from '../../web/banco-componentes.js';
const solicitud = { hastaMs: 0, representacion: 'separada' as const, cambios: [{ instanteMs: 0, alimentacion: true, reset: false }] };
describe('cliente del banco de componentes', () => {
  it('usa la ruta propia y propaga la señal de cancelación', async () => {
    const datos = { motor: 'componentes-propios', muestras: [{ instanteMs: 0, alimentacion: true, reset: false, estado: 'alto', fuenteV: 3.3, salidaV: 3.2, ledV: 1.9, corrienteMa: 4, ledEncendido: true }], instancias: [{ ruta: [], tipo: 'compuesto', dominios: ['electrico', 'funcional'] }], avisos: [] };
    const pedir = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(datos)));
    const control = new AbortController();
    expect(await consultarBancoComponentes(solicitud, control.signal, pedir)).toEqual(datos);
    expect(pedir).toHaveBeenCalledWith('/api/componentes/banco-led', expect.objectContaining({ method: 'POST', signal: control.signal, body: JSON.stringify(solicitud) }));
  });
  it('propaga el diagnóstico del servidor y rechaza respuestas inválidas', async () => {
    const pedir = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'No converge' }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ motor: 'esp-emu' })));
    await expect(consultarBancoComponentes(solicitud, new AbortController().signal, pedir)).rejects.toThrow(/No converge/);
    await expect(consultarBancoComponentes(solicitud, new AbortController().signal, pedir)).rejects.toThrow();
  });
});
