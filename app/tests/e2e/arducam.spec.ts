import { cpSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { seleccionarModulo } from './helpers';

test('ESP32-S3 MicroPython solicita webcam, lee FIFO y calcula la huella del backend', async ({ page, request }) => {
  test.skip(!process.env.E2E_EMU, 'requiere esp-emu y firmware MicroPython ESP32-S3');
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('canvas');
      ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 320, 240);
      (window as unknown as { fuenteArduCAM: HTMLCanvasElement }).fuenteArduCAM = canvas;
      return canvas.captureStream(10);
    } });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [] });
  });
  cpSync(path.resolve(import.meta.dirname, '../../../projects/_template/arducam-esp32-s3'), path.join(process.env.EMU_E2E_PROJECTS ?? '', '_template/arducam-esp32-s3'), { recursive: true });
  const name = `e2e-arducam-${Date.now().toString(36)}`;
  const creado = await request.post('/api/projects', { data: { name, template: 'arducam-esp32-s3' } });
  expect(creado.ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await seleccionarModulo(page, 'camara');
  const panel = page.getByRole('region', { name: 'ArduCAM', exact: true });
  await panel.getByRole('button', { name: 'Activar webcam', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Capturar', exact: true })).toBeEnabled();
  try {
    await page.locator('#ejecutar').click();
    await page.locator('.consola-tabs [data-tab="emu"]').click();
    const consola = page.locator('#consola');
    await expect(consola).toContainText('ArduCAM JPEG bytes=', { timeout: 75_000 });
    await expect(panel).toContainText('Solicitada por el firmware');
    const base = `/api/projects/${name}/cameras/camara`;
    const captura = await request.get(base + '/capture');
    const bytes = await captura.body(), hash = createHash('sha256').update(bytes).digest('hex');
    await expect(consola).toContainText(`bytes=${bytes.length} sha256=${hash}`);
    await expect(panel).toContainText(hash);
    const image = panel.getByAltText('Fotografía recuperada del servidor');
    await expect(image).toBeVisible();
    expect(await image.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual([320,240]);
    await page.evaluate(async () => {
      const canvas = (window as unknown as { fuenteArduCAM: HTMLCanvasElement }).fuenteArduCAM;
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('canvas');
      ctx.fillStyle = 'blue'; ctx.fillRect(0, 0, 320, 240);
      const video = document.querySelector('video');
      if (video) await new Promise<void>(resolve => video.requestVideoFrameCallback(() => resolve()));
    });
    await expect.poll(async () => (await (await request.get(base + '/status')).json()).capture?.sha256, { timeout: 20_000 }).not.toBe(hash);
    const next = await request.get(base + '/capture'), second = await next.body();
    const nextHash = createHash('sha256').update(second).digest('hex');
    await expect(consola).toContainText(`bytes=${second.length} sha256=${nextHash}`, { timeout: 20_000 });
    // Retener una respuesta real del navegador, cortar VCC y comprobar su rechazo tardío.
    let liberar: (() => void) | undefined;
    let avisar: (() => void) | undefined;
    const pendiente = new Promise<void>(resolve => { avisar = resolve; });
    const retenida = new Promise<void>(resolve => { liberar = resolve; });
    await page.route('**/captures?requestId=*', async route => { avisar?.(); await retenida; await route.continue(); });
    await pendiente;
    const full = (await (await request.get(`/api/projects/${name}`)).json()).project;
    const cambio = await request.put(`/api/projects/${name}/diagram`, { data: { modules: full.modules, wires: full.wires.filter((w: { from: string }) => w.from !== 'camara.VCC') } });
    expect(cambio.ok()).toBeTruthy();
    liberar?.();
    await expect.poll(async () => (await (await request.get(base + '/status')).json()).active).toBe(false);
    expect((await (await request.get(base + '/status')).json()).capture.sha256).toBe(nextHash);
    await expect(panel.getByRole('alert')).toBeVisible();
    await page.unroute('**/captures?requestId=*');
    expect((await (await request.get(base + '/status')).json()).active).toBe(false);
  } finally { await page.locator('#parar').click(); }
});
