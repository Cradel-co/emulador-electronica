import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { HistorialMonitor } from '../../web/monitoreo.js';
async function descarga(page: Page): Promise<HistorialMonitor> {
  const espera = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar muestras', exact: true }).click();
  const archivo = await (await espera).path();
  if (!archivo) throw new Error('No se obtuvo el archivo de muestras');
  return JSON.parse(await readFile(archivo, 'utf8')) as HistorialMonitor;
}
test('grafica nivel y voltaje, pausa solo la vista y exporta muestras con huecos', async ({ page, request }) => {
  const name = `e2e-monitor-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, template: 'sonometro-que-se-lee' } })).ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await expect(page.locator('#proyecto')).toHaveValue(name);
  await page.locator('[data-tab="debug"]').click();
  if (!await page.locator('#monitor-detalles').evaluate(el => (el as HTMLDetailsElement).open)) await page.locator('#monitor-detalles > summary').click();
  const panel = page.getByRole('region', { name: 'Monitoreo de señales' });
  await expect(panel).toContainText('50.00 dBA');
  await expect(panel).toContainText(/1\.00 V/);
  await page.getByRole('button', { name: 'Pausar vista', exact: true }).click();
  const antes = await descarga(page);
  await page.locator('#lienzo .modulo[data-id="mic1"] .etiqueta-modulo').click();
  await page.locator('input[data-prop="dbA"]').fill('80');
  await expect.poll(async () => (await (await request.get(`/api/projects/${name}/pins`)).json()).electrico.tensiones['mic1.OUT']).toBeCloseTo(1.6, 2);
  expect((await descarga(page)).muestras).toEqual(antes.muestras);
  await page.getByRole('button', { name: 'Reanudar vista', exact: true }).click();
  await expect(panel).toContainText('80.00 dBA');
  await expect(panel).toContainText(/1\.60 V/);
  const despues = await descarga(page);
  expect(despues.proyecto).toBe(name);
  expect(despues.muestras.some(m => m.valores['mic1.nivel'] === 50)).toBe(true);
  expect(despues.muestras.some(m => m.valores['mic1.nivel'] === 80)).toBe(true);
  // Un cálculo inválido tiene que retirar la lectura y cortar la gráfica.
  await page.route(`**/api/projects/${name}/pins`, async route => {
    const r = await route.fetch(); const body = await r.json();
    body.electrico.resuelto = false; body.electrico.estado = 'no-resuelta';
    await route.fulfill({ response: r, json: body });
  });
  await expect(panel).toContainText('Sin lectura válida');
  const invalido = await descarga(page);
  expect(invalido.muestras.at(-1)?.valores['mic1.salida']).toBeNull();
  await page.unroute(`**/api/projects/${name}/pins`);
  await expect(panel).toContainText(/1\.60 V/);
  await panel.getByLabel('Señal', { exact: true }).selectOption('mic1.salida');
  await expect(panel.getByRole('img', { name: /Historial de/ })).toHaveCount(1);
  await page.screenshot({ path: '/tmp/monitoreo-ui.png' });
  const otro = `e2e-monitor-otro-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name: otro, language: 'micropython' } })).ok()).toBeTruthy();
  await page.goto(`/#${otro}`);
  await expect(page.locator('#proyecto')).toHaveValue(otro);
  await page.locator('[data-tab="debug"]').click();
  if (!await page.locator('#monitor-detalles').evaluate(el => (el as HTMLDetailsElement).open)) await page.locator('#monitor-detalles > summary').click();
  await expect(page.getByRole('region', { name: 'Monitoreo de señales' })).toContainText('Agregá un sonómetro');
});
