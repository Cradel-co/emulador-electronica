import { expect, it } from 'vitest';
import { descargarAcotado } from './descargaAcotada.js';

it('cuenta bytes recibidos sin Content-Length y acepta el límite exacto', async () => {
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(c) {
    c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close();
  } }));
  expect(await descargarAcotado('https://x.test/a', 3, 1000, fetcher)).toEqual(new Uint8Array([1, 2, 3]));
});
it('cancela el cuerpo sin leer cuando Content-Length excede el límite', async () => {
  let cancelado = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelado = true; } }), { headers: { 'content-length': '4' } });
  await expect(descargarAcotado('https://x.test/a', 3, 1000, fetcher)).rejects.toThrow('demasiado grande');
  expect(cancelado).toBe(true);
});
it('no confía en un Content-Length menor al tamaño real', async () => {
  let cancelado = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4)); }, cancel() { cancelado = true; } }), { headers: { 'content-length': '1' } });
  await expect(descargarAcotado('https://x.test/a', 3, 1000, fetcher)).rejects.toThrow('demasiado grande');
  expect(cancelado).toBe(true);
});
it('el timeout abarca un cuerpo que deja de enviar bytes y cancela su lectura', async () => {
  let cancelado = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelado = true; } }));
  await expect(descargarAcotado('https://x.test/a', 3, 30, fetcher)).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(cancelado).toBe(true);
});
it('cancela un cuerpo de error HTTP y rechaza protocolos ajenos', async () => {
  let cancelado = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelado = true; } }), { status: 502 });
  await expect(descargarAcotado('https://x.test/a', 3, 1000, fetcher)).rejects.toThrow('HTTP 502');
  expect(cancelado).toBe(true);
  await expect(descargarAcotado('http://x.test/a', 3, 1000, fetcher)).rejects.toThrow('https');
});
