import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { ServicioCamara } from './servicio.js';

const jpeg = () => sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } }).jpeg().toBuffer();
describe('Cámara virtual', () => {
  it('excluye sesiones, renueva y vence con reloj controlado', () => {
    let t = 0;
    const s = new ServicioCamara(() => {}, () => t);
    const a = s.abrir('p', 'c');
    expect(() => s.abrir('p', 'c')).toThrow();
    t = 30_000; s.renovar('p', 'c', a.id);
    t = 60_000; expect(s.estado('p', 'c').active).toBe(true);
    t = 76_000; expect(s.estado('p', 'c').active).toBe(false);
    expect(() => s.renovar('p', 'c', a.id)).toThrow();
    s.cerrar('p', 'c', a.id); s.cerrar('p', 'c', a.id);
  });
  it('recupera exactamente los bytes y conserva la captura tras detener', async () => {
    const s = new ServicioCamara(() => {});
    const a = s.abrir('p', 'c'), bytes = await jpeg();
    const m = await s.capturar('p', 'c', a.id, bytes);
    expect(m).toMatchObject({ width: 32, height: 24, number: 1 });
    expect(m.timings?.backendValidateMs).toBeGreaterThanOrEqual(0);
    expect(m.timings?.backendNormalizeMs).toBe(0);
    expect(s.imagen('p', 'c', m.id).bytes).toEqual(bytes);
    s.cerrar('p', 'c', a.id);
    expect(s.imagen('p', 'c').meta.id).toBe(m.id);
    const b = s.abrir('p', 'c');
    await s.capturar('p', 'c', b.id, bytes);
    expect(() => s.imagen('p', 'c', m.id)).toThrow();
    s.reconciliar('p', []);
    expect(() => s.imagen('p', 'c')).toThrow();
  });
  it('rechaza JPEG corrupto, dimensiones excesivas y sesión ajena', async () => {
    const s = new ServicioCamara(() => {}), a = s.abrir('p', 'c');
    await expect(s.capturar('p', 'c', a.id, Buffer.from('malo'))).rejects.toThrow();
    const grande = await sharp({ create: { width: 641, height: 1, channels: 3, background: 'red' } }).jpeg().toBuffer();
    await expect(s.capturar('p', 'c', a.id, grande)).rejects.toThrow();
    await expect(s.capturar('p', 'c', 'ajena', await jpeg())).rejects.toThrow();
    await expect(s.capturar('p', 'c', a.id, Buffer.alloc(1024 * 1024 + 1))).rejects.toThrow();
  });
  it('descarta capturas antiguas al superar el presupuesto', async () => {
    const bytes = await jpeg();
    const s = new ServicioCamara(() => {}, Date.now, bytes.length);
    const a = s.abrir('p', 'a'), b = s.abrir('p', 'b');
    await s.capturar('p', 'a', a.id, bytes);
    await s.capturar('p', 'b', b.id, bytes);
    expect(() => s.imagen('p', 'a')).toThrow();
    expect(s.imagen('p', 'b').bytes).toEqual(bytes);
  });
});

it('descarta la decodificación tardía si se cierra o elimina la sesión', async () => {
  const bytes = await jpeg();
  const s = new ServicioCamara(() => {}), a = s.abrir('p', 'c');
  const captura = s.capturar('p', 'c', a.id, bytes);
  s.cerrar('p', 'c', a.id);
  await expect(captura).rejects.toThrow();
  expect(() => s.imagen('p', 'c')).toThrow();
  const b = s.abrir('p', 'c');
  const otra = s.capturar('p', 'c', b.id, bytes);
  s.reconciliar('p', []);
  await expect(otra).rejects.toThrow();
});

it('no permite cierre ajeno ni filtración del identificador en eventos', () => {
  const events: unknown[] = [], s = new ServicioCamara(e => events.push(e));
  const a = s.abrir('p', 'c'); s.cerrar('p', 'c', 'ajena');
  expect(s.estado('p', 'c').active).toBe(true);
  expect(JSON.stringify(events)).not.toContain(a.id);
});
