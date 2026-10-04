import { cpSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { modulo, seleccionarModulo } from './helpers';

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
    await expect(panel).toContainText('JPEG navegador=');
    await expect(panel).toContainText('backend validar/decodificar=');
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

test('la foto solicitada por MicroPython llega decodificada a la pantalla ST7735 del circuito', async ({ page, request }) => {
  test.skip(!process.env.E2E_EMU, 'requiere esp-emu y firmware MicroPython ESP32-S3');
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('canvas');
      ctx.fillStyle = '#ed2018'; ctx.fillRect(0, 0, 320, 240);
      for (let y = 0; y < 240; y += 3) for (let x = 0; x < 320; x += 3) {
        if ((x < 112 || x > 208 || y < 72 || y > 168) && ((x * 13 + y * 7) % 11 < 5)) {
          ctx.fillStyle = '#b92231'; ctx.fillRect(x, y, 3, 3);
        }
      }
      (window as unknown as { fuenteArduCAM: HTMLCanvasElement }).fuenteArduCAM = canvas;
      return canvas.captureStream(10);
    } });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [] });
  });
  cpSync(path.resolve(import.meta.dirname, '../../../projects/_template/arducam-tft-esp32-s3'), path.join(process.env.EMU_E2E_PROJECTS ?? '', '_template/arducam-tft-esp32-s3'), { recursive: true });
  const name = `e2e-arducam-tft-${Date.now().toString(36)}`;
  const creado = await request.post('/api/projects', { data: { name, template: 'arducam-tft-esp32-s3' } });
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
    await expect(consola).toContainText('ST7735 actualizada con la captura', { timeout: 75_000 });
    await expect(panel).toContainText('Solicitada por el firmware');
    const imagen = modulo(page, 'tft').locator('image.pantalla-chip');
    const leer = () => imagen.evaluate(async el => {
      const img = new Image(); img.src = el.getAttribute('href') ?? ''; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
      const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
      return { arriba: pixel(64, 10), foto: pixel(64, 80), abajo: pixel(64, 145) };
    }).catch(() => null);
    await expect.poll(async () => {
      const colores = await leer();
      return !!colores && colores.foto[0]! > 180 && colores.foto[1]! < 80 && colores.foto[2]! < 80
        && colores.arriba.every(c => c < 20) && colores.abajo.every(c => c < 20);
    }, { timeout: 20_000 }).toBe(true);
    const colores = (await leer())!;
    expect(colores.foto[0]).toBeGreaterThan(180);
    expect(colores.arriba).toEqual([0, 0, 0]);
    expect(colores.abajo).toEqual([0, 0, 0]);

    const base = `/api/projects/${name}/cameras/camara`;
    const primeraHuella = (await (await request.get(base + '/status')).json()).capture.sha256;
    await page.evaluate(async () => {
      const canvas = (window as unknown as { fuenteArduCAM: HTMLCanvasElement }).fuenteArduCAM;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'blue'; ctx.fillRect(0, 0, 320, 240);
      const video = document.querySelector('video');
      if (video) await new Promise<void>(resolve => video.requestVideoFrameCallback(() => resolve()));
    });
    await expect.poll(async () => (await (await request.get(base + '/status')).json()).capture.sha256, { timeout: 30_000 }).not.toBe(primeraHuella);
    await expect.poll(async () => {
      const pixeles = await leer();
      return !!pixeles && pixeles.foto[2]! > 180 && pixeles.foto[0]! < 80 && pixeles.foto[1]! < 80;
    }, { timeout: 60_000 }).toBe(true);
  } finally { await page.locator('#parar').click(); }
});
