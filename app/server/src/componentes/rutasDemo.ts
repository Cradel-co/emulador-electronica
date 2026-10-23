import type { FastifyInstance } from 'fastify';
import { ResultadoBancoComponentesSchema, SolicitudBancoComponentesSchema, type SolicitudBancoComponentes, type ResultadoBancoComponentes } from '@emu/shared';

/** Una consulta a la vez por servidor; el banco no comparte estado de proyectos ni emuladores. */
export function registrarRutasBancoComponentes(app: FastifyInstance, ejecutar: (s: SolicitudBancoComponentes, signal: AbortSignal) => Promise<ResultadoBancoComponentes>): void {
  let ocupado = false;
  app.post('/api/componentes/banco-led', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const s = SolicitudBancoComponentesSchema.safeParse(req.body);
    if (!s.success) return reply.code(400).send({ error: s.error.message });
    if (ocupado) return reply.code(429).send({ error: 'El banco está calculando. Reintentá al terminar.' });
    ocupado = true;
    const control = new AbortController();
    const cerrar = () => { if (!reply.raw.writableFinished) control.abort(); };
    reply.raw.on('close', cerrar);
    reply.header('Cache-Control', 'no-store');
    try { return ResultadoBancoComponentesSchema.parse(await ejecutar(s.data, control.signal)); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) }); }
    finally { ocupado = false; reply.raw.off('close', cerrar); }
  });
}
