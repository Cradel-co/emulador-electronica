import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import type { ResultadoBancoComponentes } from '@emu/shared';
import { registrarRutasBancoComponentes } from '../../../../server/src/componentes/rutasDemo.js';
const payload = { hastaMs: 0, representacion: 'separada', cambios: [{ instanteMs: 0, alimentacion: true, reset: false }] };
const resultado: ResultadoBancoComponentes = { motor: 'componentes-propios', muestras: [{ instanteMs: 0, alimentacion: true, reset: false, estado: 'alto', fuenteV: 3.3, salidaV: 3.2, ledV: 1.9, corrienteMa: 4, ledEncendido: true }], instancias: [{ ruta: [], tipo: 'compuesto', dominios: ['electrico', 'funcional'] }], avisos: [] };
describe('ruta única del banco de componentes', () => {
  it('valida la solicitud y publica el resultado del servicio', async () => {
    const app = Fastify(), ejecutar = vi.fn().mockResolvedValue(resultado);
    registrarRutasBancoComponentes(app, ejecutar);
    try {
      expect((await app.inject({ method: 'POST', url: '/api/componentes/banco-led', payload: {} })).statusCode).toBe(400);
      expect(ejecutar).not.toHaveBeenCalled();
      const r = await app.inject({ method: 'POST', url: '/api/componentes/banco-led', payload });
      expect(r.statusCode).toBe(200); expect(r.json()).toEqual(resultado);
    } finally { await app.close(); }
  });
  it('conserva el fallo del motor y permite reintentar sin medidas viejas', async () => {
    const app = Fastify(), ejecutar = vi.fn().mockRejectedValueOnce(new Error('Sin solución')).mockResolvedValue(resultado);
    registrarRutasBancoComponentes(app, ejecutar);
    try {
      const r = await app.inject({ method: 'POST', url: '/api/componentes/banco-led', payload });
      expect(r.statusCode).toBe(422); expect(r.json()).toEqual({ error: 'Sin solución' });
      expect((await app.inject({ method: 'POST', url: '/api/componentes/banco-led', payload })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it('no publica éxito si el servicio devuelve medidas vacías', async () => {
    const app = Fastify();
    registrarRutasBancoComponentes(app, vi.fn().mockResolvedValue({ ...resultado, muestras: [] }));
    try {
      const r = await app.inject({ method: 'POST', url: '/api/componentes/banco-led', payload });
      expect(r.statusCode).toBe(422); expect(r.json()).toHaveProperty('error');
      expect(r.json()).not.toHaveProperty('muestras');
    } finally { await app.close(); }
  });
  it('limita a una consulta concurrente sin dejar el banco bloqueado', async () => {
    const app = Fastify(); let liberar: (r: ResultadoBancoComponentes) => void = () => {};
    const pendiente = new Promise<ResultadoBancoComponentes>(resolve => { liberar = resolve; });
    const ejecutar = vi.fn(() => pendiente); registrarRutasBancoComponentes(app, ejecutar);
    try {
      const primera = app.inject({ method: 'POST', url: '/api/componentes/banco-led', payload });
      await vi.waitFor(() => expect(ejecutar).toHaveBeenCalledOnce());
      expect((await app.inject({ method: 'POST', url: '/api/componentes/banco-led', payload })).statusCode).toBe(429);
      liberar(resultado); expect((await primera).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/componentes/banco-led', payload })).statusCode).toBe(200);
    } finally { liberar(resultado); await app.close(); }
  });
});
