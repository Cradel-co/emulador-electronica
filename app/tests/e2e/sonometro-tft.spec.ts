import { expect, test, type Page } from '@playwright/test';
async function pantalla(page: Page): Promise<{ puntos: [number, number][] }> {
  return page.locator('#lienzo .modulo[data-id="tft1"] image.pantalla-chip').evaluate(async el => {
    const im = new Image(); im.src = el.getAttribute('href') ?? ''; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const g = c.getContext('2d'); if (!g) throw new Error('No hay canvas');
    g.drawImage(im, 0, 0);
    const datos = g.getImageData(0, 0, im.width, im.height).data, puntos: [number, number][] = [];
    for (let y = 46; y <= 130; y++) for (let x = 28; x <= 126; x++) {
      const i = (y * im.width + x) * 4;
      if ((datos[i + 1] ?? 0) > 180 && (datos[i] ?? 255) < 50 && (datos[i + 2] ?? 255) < 50) puntos.push([x, y]);
    }
    return { puntos };
  });
}
test('la plantilla de sonómetro incluye la TFT, driver y firmware sin dependencias externas', async ({ page, request }) => {
  const name = `e2e-sonometro-tft-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, template: 'sonometro-que-se-lee' } })).ok()).toBe(true);
  const { project } = await (await request.get(`/api/projects/${name}`)).json();
  expect(project.modules.some((m: { type: string }) => m.type === 'tft-st7735-128x160')).toBe(true);
  expect(project.wires).toContainEqual({ from: 'tft1.SCK', to: 'board.GPIO12' });
  expect((await (await request.get(`/api/projects/${name}/files/main.py`)).json()).content).toContain('class HistorialNivel');
  expect((await (await request.get(`/api/projects/${name}/files/st7735.py`)).json()).content).toContain('class ST7735');
  await page.goto(`/#${name}`);
  await expect(page.locator('#lienzo .modulo[data-id="tft1"]')).toBeVisible();
});
test('MicroPython dibuja la lectura ADC por SPI y retira niveles de hace más de diez segundos', async ({ page, request }) => {
  test.skip(!process.env.E2E_EMU, 'requiere esp-emu: correr con E2E_EMU=1');
  test.setTimeout(180000);
  const name = `e2e-sonometro-tft-vivo-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, template: 'sonometro-que-se-lee' } })).ok()).toBe(true);
  await page.goto(`/#${name}`); await expect(page.locator('#proyecto')).toHaveValue(name);
  try {
    await page.locator('#ejecutar').click();
    await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge', { timeout: 120000 });
    await page.getByRole('button', { name: 'Emulador', exact: true }).click();
    await expect(page.locator('#consola')).toContainText(/50\.[0-4] dBA/, { timeout: 30000 });
    await expect.poll(async () => (await pantalla(page).catch(() => ({ puntos: [] }))).puntos.some(([x, y]) => x >= 124 && Math.abs(y - 114) <= 2), { timeout: 30000 }).toBe(true);
    await page.locator('#lienzo .modulo[data-id="mic1"] .etiqueta-modulo').click();
    await page.locator('input[data-prop="dbA"]').fill('130');
    await expect.poll(async () => (await pantalla(page)).puntos.some(([x, y]) => x >= 124 && y <= 48), { timeout: 30000 }).toBe(true);
    await page.locator('input[data-prop="dbA"]').fill('30');
    await expect.poll(async () => (await pantalla(page)).puntos.some(([x, y]) => x >= 124 && y >= 128), { timeout: 30000 }).toBe(true);
    await expect.poll(async () => {
      const { puntos } = await pantalla(page);
      return puntos.length > 5 && puntos.every(([, y]) => y >= 128);
    }, { timeout: 60000, intervals: [500, 1000] }).toBe(true);
    await page.screenshot({ path: '/tmp/sonometro-tft-diez-segundos.png' });
  } finally {
    await page.screenshot({ path: '/tmp/sonometro-tft-final.png' });
    const href = await page.locator('#lienzo .modulo[data-id="tft1"] image.pantalla-chip').getAttribute('href').catch(() => null);
    if (href?.startsWith('data:image/png;base64,')) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile('/tmp/sonometro-tft-expiracion.png', Buffer.from(href.split(',')[1] ?? '', 'base64'));
    }
    await request.post('/api/emulator/stop');
  }
});
