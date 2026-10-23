import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SolicitudBancoComponentesSchema, type SolicitudBancoComponentes } from '@emu/shared';
import { ejecutarBancoComponentes, estadoBanco } from '../../../../server/src/componentes/demo.js';
import { precalentar } from '../../../../server/src/sim/spice.js';
// Cualquier intento de crear el motor externo desde el banco hace fallar la prueba.
vi.mock('../../../../server/src/emulator.js', () => { throw new Error('El banco no debe importar esp-emu'); });
const base: SolicitudBancoComponentes = { hastaMs: 1000, representacion: 'separada', cambios: [{ instanteMs: 0, alimentacion: true, reset: false }] };
beforeAll(precalentar, 60_000);

describe('banco visible de componentes propios', () => {
  it('parpadea con ngspice y un único propietario eléctrico del driver', async () => {
    const r = await ejecutarBancoComponentes(base);
    expect(r.motor).toBe('componentes-propios');
    expect(r.muestras.map(m => m.ledEncendido)).toEqual([true, false, true, false, true]);
    expect(r.muestras[0]?.corrienteMa).toBeGreaterThan(3);
    expect(r.muestras[0]?.corrienteMa).toBeLessThan(10);
    expect(r.muestras[1]?.corrienteMa).toBeLessThan(0.001);
    expect(r.instancias.filter(i => i.ruta[0] === 'driver' && i.tipo === 'hoja-legada' && i.dominios.includes('electrico'))).toHaveLength(1);
    expect(r.instancias.find(i => i.ruta.join('/') === 'driver/interior/resistencia')?.dominios).toEqual(['funcional']);
  });
  it('el interior completo y las representaciones separadas dan las mismas medidas', async () => {
    const a = await ejecutarBancoComponentes({ ...base, hastaMs: 500 });
    const b = await ejecutarBancoComponentes({ ...base, hastaMs: 500, representacion: 'completa' });
    expect(a.muestras).toEqual(b.muestras);
  });
  it('reset y pérdida de alimentación apagan el LED y la recuperación continúa el reloj', async () => {
    const r = await ejecutarBancoComponentes({ ...base, hastaMs: 1500, cambios: [
      ...base.cambios, { instanteMs: 100, alimentacion: true, reset: true },
      { instanteMs: 400, alimentacion: true, reset: false },
      { instanteMs: 600, alimentacion: false, reset: false },
      { instanteMs: 1000, alimentacion: true, reset: false },
    ] });
    const a = (t: number) => r.muestras.find(m => m.instanteMs === t);
    expect(a(100)).toMatchObject({ estado: 'reset', ledEncendido: false });
    expect(a(500)?.ledEncendido).toBe(true);
    expect(a(600)).toMatchObject({ estado: 'apagado', ledEncendido: false });
    // La fuente CV/CC solo entrega; a 0 V no fuerza un sumidero ideal sobre las fugas numéricas.
    expect(Math.abs(a(600)?.fuenteV ?? Infinity)).toBeLessThan(0.01);
    expect(a(1000)?.ledEncendido).toBe(true);
  });
  it('cada consulta empieza con estado nuevo y admite cancelar antes de resolver', async () => {
    await ejecutarBancoComponentes({ ...base, hastaMs: 0, cambios: [{ instanteMs: 0, alimentacion: false, reset: true }] });
    expect((await ejecutarBancoComponentes({ ...base, hastaMs: 0 })).muestras[0]?.ledEncendido).toBe(true);
    await expect(ejecutarBancoComponentes(base, AbortSignal.abort())).rejects.toThrow(/cancelada/);
  });
  it.each([
    { ...base, hastaMs: 5001 }, { ...base, cambios: [] },
    { ...base, cambios: [{ instanteMs: 1, alimentacion: true, reset: false }] },
    { ...base, cambios: [...base.cambios, ...base.cambios] },
    { ...base, cambios: [...base.cambios, { instanteMs: 1001, alimentacion: true, reset: false }] },
    { ...base, netlist: 'externa' },
  ])('rechaza historia inválida o parámetros ajenos: %j', entrada => expect(SolicitudBancoComponentesSchema.safeParse(entrada).success).toBe(false));
  it('el control didáctico distingue abierto, reset y falta de energía', () => {
    expect(estadoBanco(base, 250).estado).toBe('alta-impedancia');
    expect(estadoBanco({ ...base, cambios: [{ instanteMs: 0, alimentacion: true, reset: true }] }, 0).ohms).toBe(10_000_000);
  });
});
