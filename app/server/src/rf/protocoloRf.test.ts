import { describe, expect, it, vi } from 'vitest';
import { ClientEventSchema, ServerEventSchema } from '@emu/shared';
import { enlaceRfDePrueba } from './canalRf.fixture.js';
import { transmitirPorCanalRf } from './canalRf.js';

describe('canal RF recibido desde WebSocket', () => {
  it.each([null, {}, { ...enlaceRfDePrueba(), distanciaM: 1e8 }])('preserva un perfil rechazado y evita convertirlo en transmisión ideal', async canalRf => {
    const evento = ClientEventSchema.parse({ type: 'rf.send', bits: '1010', protocol: 1, canalRf });
    if (evento.type !== 'rf.send') throw new Error('Evento inesperado');
    expect(evento.canalRf).toEqual(canalRf);
    const inyectar = vi.fn(() => true);
    const r = await transmitirPorCanalRf(evento.bits, evento.protocol, evento.canalRf, inyectar);
    expect(r.entregado).toBe(false);
    expect(inyectar).not.toHaveBeenCalled();
  });

  it('conserva modo funcional para mensajes históricos y comprueba disponibilidad del puente', async () => {
    const evento = ClientEventSchema.parse({ type: 'rf.send', bits: '1010', protocol: 1 });
    if (evento.type !== 'rf.send') throw new Error('Evento inesperado');
    const r = await transmitirPorCanalRf(evento.bits, evento.protocol, evento.canalRf, () => false);
    expect(r.evaluacion.modo).toBe('funcional');
    expect(r.entregado).toBe(false);
  });
  it('conserva modo, parámetros y margen en la respuesta de una entrega aceptada', async () => {
    const canal = enlaceRfDePrueba();
    const r = await transmitirPorCanalRf('1010', 1, canal, () => true);
    const respuesta = ServerEventSchema.parse({ type: 'rf.result', boardId: 'board', bits: '1010', protocol: 1, ...r });
    expect(respuesta).toMatchObject({ type: 'rf.result', entregado: true,
      evaluacion: { modo: 'friis-espacio-libre', parametros: canal } });
    if (respuesta.type !== 'rf.result') throw new Error('Respuesta incorrecta');
    expect(respuesta.evaluacion.margenDb).toBeTypeOf('number');
  });
});
