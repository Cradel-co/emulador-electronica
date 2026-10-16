import { expect, test } from '@playwright/test';
import { modulo, seleccionarModulo } from './helpers';

/**
 * Lo que cada módulo dice de sí mismo (parte, esquemático, nivel) se ve en su panel; y su banco
 * de pruebas se puede correr por la API (lo mismo que hace el importador antes de instalar).
 */

test('el panel muestra la pieza real: número de parte según sus props, hoja de datos y nivel', async ({ page, request }) => {
  const name = `e2e-mod-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, language: 'arduino', board: 'arduino-uno' } })).ok()).toBeTruthy();
  const { project } = await (await request.get(`/api/projects/${name}`)).json();
  const modules = [
    ...project.modules,
    { id: 'rx47', type: 'resistor', x: 700, y: 80, props: { ohms: 4700 } },
    { id: 'ledazul', type: 'led', x: 700, y: 200, props: { color: 'blue' } },
    { id: 'bmex', type: 'bme280-adafruit', x: 760, y: 300, props: {} },
  ];
  expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules, wires: project.wires } })).ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await expect(modulo(page, 'rx47')).toBeVisible();

  const panel = page.locator('#panel-modulo');
  await seleccionarModulo(page, 'rx47');
  await expect(panel).toContainText('Pieza real');
  await expect(panel).toContainText('CFR-25JB-52-4K7'); // el número de parte sale de la prop (4,7 kΩ)
  await expect(panel.locator('.insp-nivel')).toHaveAttribute('data-nivel', 'fabricable');

  await seleccionarModulo(page, 'ledazul');
  await expect(panel).toContainText('WP7113QBC/D'); // azul

  await seleccionarModulo(page, 'bmex');
  await expect(panel).toContainText('2652');
  await expect(panel.locator('a', { hasText: 'Hoja de datos' })).toHaveAttribute('href', /^https:\/\/www\.bosch-sensortec\.com\//);
  await panel.locator('h3', { hasText: 'Pieza real' }).scrollIntoViewIfNeeded();
  await panel.screenshot({ path: 'test-results/modulo-pieza-real.png' });
});

test('POST /api/modules/:tipo/probar corre su banco de pruebas con el motor real', async ({ request }) => {
  const r = await request.post('/api/modules/ds3231-zs042/probar');
  expect(r.ok()).toBeTruthy();
  const inf = await r.json();
  expect(inf.ok).toBe(true);
  expect(inf.nivel).toBe('fabricable');
  const cr2032 = inf.pruebas.find((p: { nombre: string }) => p.nombre.includes('CR2032') && p.nombre.startsWith('a 5 V'));
  expect(cr2032.medido['corrienteMa pila']).toBeGreaterThan(5);
  expect((await request.post('/api/modules/no-existe/probar')).status()).toBe(404);
});
