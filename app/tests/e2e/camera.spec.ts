import { expect, test } from '@playwright/test';
import { abrirProyectoNuevo, seleccionarModulo } from './helpers';

test.beforeEach(async ({ page }) => {
  // Fuente de video determinista que atraviesa el controlador de producción.
  await page.addInitScript(() => {
    const tracks: MediaStreamTrack[] = [];
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      if (String(url).endsWith('/captures') && init?.body instanceof Blob) {
        (window as unknown as { cameraBytes: number[] }).cameraBytes = [...new Uint8Array(await init.body.arrayBuffer())];
      }
      return fetchOriginal(url, init);
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 320, 240);
      const stream = canvas.captureStream(10); tracks.push(...stream.getTracks());
      (window as unknown as { cameraTracks: MediaStreamTrack[]; cameraCanvas: HTMLCanvasElement }).cameraTracks = tracks;
      (window as unknown as { cameraCanvas: HTMLCanvasElement }).cameraCanvas = canvas;
      return stream;
    }, configurable: true });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [] });
  });
});
async function agregar(page: Parameters<typeof abrirProyectoNuevo>[0]) {
  await page.locator('.modulo-card[data-type="camara-computador"]').click();
  const id = await page.locator('#lienzo .modulo[data-type="camara-computador"]').getAttribute('data-id');
  expect(id).toBeTruthy();
  await seleccionarModulo(page, id!);
  return id!;
}

test('captura, recupera los bytes del backend y libera las pistas', async ({ page, request }) => {
  const project = await abrirProyectoNuevo(page, request), instance = await agregar(page);
  const panel = page.getByRole('region', { name: 'Cámara virtual' });
  await panel.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Capturar', exact: true })).toBeEnabled();
  const envio = page.waitForRequest(r => r.url().endsWith('/captures'));
  await panel.getByRole('button', { name: 'Capturar', exact: true }).click();
  await envio;
  const enviado = Buffer.from(await page.evaluate(() => (window as unknown as { cameraBytes: number[] }).cameraBytes));
  const image = panel.getByAltText('Fotografía recuperada del servidor');
  await expect(image).toBeVisible();
  const base = `/api/projects/${project}/cameras/${instance}`;
  const res = await request.get(base + '/capture');
  expect(await res.body()).toEqual(enviado);
  expect(await image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(320);
  // El visor pinta los bytes recuperados (incluido el contenido rojo), no una imagen local.
  const color = await image.evaluate((el: HTMLImageElement) => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(el, 0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data];
  });
  expect(color[0]).toBeGreaterThan(240); expect(color[1]).toBeLessThan(10);
  await expect(panel).toContainText('Captura 1');
  await page.evaluate(async () => {
    const canvas = (window as unknown as { cameraCanvas: HTMLCanvasElement }).cameraCanvas;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const v = document.querySelector('video')!;
    await new Promise<void>(resolve => v.requestVideoFrameCallback(() => resolve()));
  });
  await panel.getByRole('button', { name: 'Capturar', exact: true }).click();
  await expect(panel).toContainText('Captura 2');
  const segundo = await request.get(base + '/capture');
  expect(await segundo.body()).not.toEqual(enviado);
  await panel.getByRole('button', { name: 'Detener', exact: true }).click();
  await expect.poll(async () => (await (await request.get(base + '/status')).json()).active).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { cameraTracks: MediaStreamTrack[] }).cameraTracks.every(t => t.readyState === 'ended'))).toBe(true);
  await page.reload(); await seleccionarModulo(page, instance);
  await expect(page.getByRole('status').filter({ hasText: 'Cámara desactivada' })).toBeVisible();
  await expect(page.getByAltText('Fotografía recuperada del servidor')).toBeVisible();
});

test('permiso denegado se informa sin abrir sesión', async ({ page, request }) => {
  const project = await abrirProyectoNuevo(page, request);
  await page.evaluate(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new DOMException('Denegado', 'NotAllowedError'); } }));
  const instance = await agregar(page);
  await page.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Cámara virtual' }).getByRole('alert')).toContainText('Permiso de cámara denegado');
  expect((await (await request.get(`/api/projects/${project}/cameras/${instance}/status`)).json()).active).toBe(false);
});

test('otra pestaña no toma la sesión y seleccionar otro módulo detiene', async ({ page, context, request }) => {
  const project = await abrirProyectoNuevo(page, request), instance = await agregar(page);
  await page.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Capturar', exact: true })).toBeEnabled();
  const other = await context.newPage();
  await other.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const c = document.createElement('canvas'); c.width = 16; c.height = 16; return c.captureStream();
    } });
  });
  await other.goto('/#' + project); await seleccionarModulo(other, instance);
  await other.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(other.getByRole('region', { name: 'Cámara virtual' }).getByRole('alert')).toContainText('otra sesión');
  await seleccionarModulo(page, 'btn1');
  await expect.poll(async () => (await (await request.get(`/api/projects/${project}/cameras/${instance}/status`)).json()).active).toBe(false);
});

test('eliminar la instancia limpia fotografía y sesión del backend', async ({ page, request }) => {
  const project = await abrirProyectoNuevo(page, request), instance = await agregar(page);
  await page.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Capturar', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Capturar', exact: true }).click();
  await expect(page.getByAltText('Fotografía recuperada del servidor')).toBeVisible();
  const proyecto = (await (await request.get(`/api/projects/${project}`)).json()).project;
  const original = proyecto.modules;
  const cambio = await request.put(`/api/projects/${project}/diagram`, { data: { modules: original.filter((m: { id: string }) => m.id !== instance), wires: proyecto.wires } });
  expect(cambio.ok()).toBe(true);
  const base = `/api/projects/${project}/cameras/${instance}`;
  expect((await request.get(base + '/capture')).status()).toBe(404);
  await request.put(`/api/projects/${project}/diagram`, { data: { modules: original, wires: proyecto.wires } });
  expect((await (await request.get(base + '/status')).json()).capture).toBeNull();
  expect((await (await request.get(base + '/status')).json()).active).toBe(false);
});
