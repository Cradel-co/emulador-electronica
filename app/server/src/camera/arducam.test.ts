import { it, expect } from 'vitest';
import sharp from 'sharp';
import { ServicioCamara } from './servicio.js';
import type { ServerEvent } from '@emu/shared';

it('solicita una foto nueva y entrega los mismos bytes normalizados que conserva', async () => {
  const events: ServerEvent[] = [], s = new ServicioCamara(e => events.push(e));
  const session = s.abrir('p', 'a');
  let fifo: Buffer | undefined;
  const requestId = s.solicitar('p', 'a', (bytes) => { fifo = bytes; }, () => {});
  expect(events.at(-1)).toMatchObject({ type: 'camera.capture.request', project: 'p', instance: 'a', requestId });
  expect(JSON.stringify(events)).not.toContain(session.id);
  expect(() => s.solicitar('p', 'a', () => {}, () => {})).toThrow();
  const input = await sharp({ create: { width: 120, height: 240, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const meta = await s.capturar('p', 'a', session.id, input, undefined, requestId);
  expect(meta).toMatchObject({ width: 320, height: 240, requestId });
  expect(meta.timings?.backendValidateMs).toBeGreaterThanOrEqual(0);
  expect(meta.timings?.backendNormalizeMs).toBeGreaterThanOrEqual(0);
  expect(fifo).toEqual(s.imagen('p', 'a').bytes);
  const pixels = await sharp(s.imagen('p','a').bytes).raw().toBuffer();
  expect(pixels[0]).toBeLessThan(10);
  expect(pixels[(120 * 320 + 160) * 3]).toBeGreaterThan(240);
  expect(pixels[(120 * 320 + 160) * 3 + 1]).toBeLessThan(10);
});
it('vence y cancela solicitudes; rechaza respuestas tardías de otra ejecución', async () => {
  let t = 0; const errores: string[] = [];
  const s = new ServicioCamara(() => {}, () => t), session = s.abrir('p', 'a');
  const id = s.solicitar('p', 'a', () => { throw new Error('no completar'); }, e => errores.push(e));
  t = 10_001; s.vencer(); expect(errores).toHaveLength(1);
  const next = s.solicitar('p', 'a', () => {}, e => errores.push(e));
  await expect(s.capturar('p', 'a', session.id, Buffer.from('invalid'), undefined, id)).rejects.toThrow();
  s.cancelar('p', 'a', 'reinicio');
  await expect(s.capturar('p', 'a', session.id, Buffer.from('invalid'), undefined, next)).rejects.toThrow();
  expect(errores).toHaveLength(2);
});

it.each(['cierre', 'eliminacion', 'error', 'vencimiento'])('cancela la solicitud por %s', (motivo) => {
  let t = 0; const errores: string[] = [];
  const s = new ServicioCamara(() => {}, () => t), a = s.abrir('p','a');
  const id = s.solicitar('p','a', () => { throw new Error('no completar'); }, e => errores.push(e));
  if (motivo === 'cierre') s.cerrar('p','a', a.id);
  if (motivo === 'eliminacion') s.reconciliar('p', []);
  if (motivo === 'error') {
    expect(() => s.errorSolicitud('p','a','ajena',id)).toThrow();
    expect(() => s.errorSolicitud('p','a',a.id,'ajena')).toThrow();
    s.errorSolicitud('p','a',a.id,id);
  }
  if (motivo === 'vencimiento') { t = 46_000; s.vencer(); }
  expect(errores).toHaveLength(1);
});
it('no reemplaza la última foto con una respuesta cancelada durante la decodificación', async () => {
  const s = new ServicioCamara(() => {}), a = s.abrir('p','a');
  const bytes = await sharp({ create: { width:320, height:240, channels:3, background:'red' } }).jpeg().toBuffer();
  const anterior = await s.capturar('p','a',a.id,bytes);
  const id = s.solicitar('p','a', () => { throw new Error('no completar'); }, () => {});
  await expect(s.capturar('p','a',a.id,bytes)).rejects.toThrow();
  const subiendo = s.capturar('p','a',a.id,bytes,undefined,id);
  s.cancelar('p','a','reinicio');
  await expect(subiendo).rejects.toThrow();
  expect(s.imagen('p','a').meta.id).toBe(anterior.id);
});
