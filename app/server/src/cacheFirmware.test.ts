import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { obtenerFirmware, LIMITE_FIRMWARE } from './cacheFirmware.js';
let root: string, target: string;
const url = 'https://x.test/firmware.bin';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const respuesta = (s: string): typeof fetch => async () => new Response(s);
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'emu-cache-')); target = path.join(root, 'firmware.bin'); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('fija la primera referencia y reutiliza sin red sólo después de verificarla', async () => {
  await obtenerFirmware(target, url, () => {}, respuesta('firmware'));
  expect(await fs.readFile(target, 'utf8')).toBe('firmware');
  expect(await fs.readFile(target + '.sha256', 'utf8')).toBe(`${digest('firmware')}  firmware.bin\n`);
  const fetcher = vi.fn<typeof fetch>();
  expect(await obtenerFirmware(target, url, () => {}, fetcher)).toBe(target);
  expect(fetcher).not.toHaveBeenCalled();
});
it('conserva una referencia aunque falte el binario y rechaza una descarga distinta', async () => {
  const ref = `${digest('original')}  firmware.bin\n`;
  await fs.writeFile(target + '.sha256', ref);
  await expect(obtenerFirmware(target, url, () => {}, respuesta('otro'))).rejects.toThrow('integridad');
  expect(await fs.readFile(target + '.sha256', 'utf8')).toBe(ref);
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  await obtenerFirmware(target, url, () => {}, respuesta('original'));
  expect(await fs.readFile(target, 'utf8')).toBe('original');
});
it('no publica un binario ni huella cuando el stream falla', async () => {
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.error(new Error('interrumpida')); } }));
  await expect(obtenerFirmware(target, url, () => {}, fetcher)).rejects.toThrow('interrumpida');
  expect(await fs.readdir(root)).toEqual([]);
  await obtenerFirmware(target, url, () => {}, respuesta('reintento'));
  expect(await fs.readFile(target, 'utf8')).toBe('reintento');
});
it('rechaza referencia malformada sin recalcularla desde el binario', async () => {
  await fs.writeFile(target, 'contenido'); await fs.writeFile(target + '.sha256', 'invalida');
  const fetcher = vi.fn<typeof fetch>();
  await expect(obtenerFirmware(target, url, () => {}, fetcher)).rejects.toThrow('Huella');
  expect(await fs.readFile(target + '.sha256', 'utf8')).toBe('invalida');
  expect(fetcher).not.toHaveBeenCalled();
});
it('rechaza firmware vacío y una descarga excesiva sin publicar archivos', async () => {
  await expect(obtenerFirmware(target, url, () => {}, respuesta(''))).rejects.toThrow('vacío');
  let cancelado = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(LIMITE_FIRMWARE + 1)); }, cancel() { cancelado = true; } }));
  await expect(obtenerFirmware(target, url, () => {}, fetcher)).rejects.toThrow('demasiado grande');
  expect(cancelado).toBe(true); expect(await fs.readdir(root)).toEqual([]);
});
