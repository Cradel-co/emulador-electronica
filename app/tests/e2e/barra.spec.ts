import { test, expect } from '@playwright/test';
import { abrirProyectoNuevo, modulo } from './helpers.js';

/**
 * Pestañas de archivos, miga y notificaciones. No tenían e2e: se escribieron antes de migrarlos a
 * React (#9) y contra el código imperativo, para que la migración tenga red.
 */
test('las pestañas listan los archivos del proyecto y cambian el archivo abierto', async ({ page, request }) => {
  // Un proyecto ESPHome muestra un solo archivo (secrets.yaml y project.json se ocultan), así que
  // se le agrega otro por la API para tener entre qué cambiar.
  const name = `tabs-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name, language: 'esphome' } });
  await request.put(`/api/projects/${name}/files/extra.yaml`, { data: { content: '# otro archivo\n' } });
  await page.goto(`/#${name}`);
  await expect(page.locator('#editor')).toHaveValue(new RegExp(`name: ${name}`));

  const tabs = page.locator('#tabs-archivos button');
  await expect(tabs).toHaveCount(2);
  const nombres = await tabs.allTextContents();
  expect(nombres).toEqual(expect.arrayContaining(['main.yaml', 'extra.yaml']));
  // Los que se ocultan a propósito no aparecen.
  expect(nombres).not.toContain('secrets.yaml');

  // La abierta va marcada, y cada una dice de qué tipo es (para el ícono).
  await expect(page.locator('#tabs-archivos button.activa')).toHaveText('main.yaml');
  await expect(tabs.filter({ hasText: 'main.yaml' })).toHaveAttribute('data-tipo', 'yaml');

  // Tocar otra cambia el archivo del editor y cuál está marcada.
  await tabs.filter({ hasText: 'extra.yaml' }).click();
  await expect(page.locator('#tabs-archivos button.activa')).toHaveText('extra.yaml');
  await expect(page.locator('#editor')).toHaveValue('# otro archivo\n');
  // Y se puede volver.
  await tabs.filter({ hasText: 'main.yaml' }).click();
  await expect(page.locator('#editor')).toHaveValue(new RegExp(`name: ${name}`));
});

test('la miga muestra el proyecto y el archivo; en el inicio dice Bienvenida', async ({ page, request }) => {
  const name = await abrirProyectoNuevo(page, request, 'esphome');
  const miga = page.locator('#miga');
  await expect(miga).toContainText(name);
  await expect(miga).toContainText('main.yaml');
  await expect(miga.locator('.sep')).toHaveText('›');

  await page.goto('/');
  await expect(page.locator('#miga')).toHaveText('Bienvenida');
});

test('las notificaciones juntan los avisos con su hora y se suman en vivo', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  const lista = page.locator('#lista-notificaciones');

  // Vacía al principio.
  await page.locator('#tw-notificaciones').click();
  await expect(lista).toBeVisible();
  await expect(lista).toContainText('Sin notificaciones.');
  await page.locator('#tw-notificaciones').click();
  await expect(lista).toBeHidden();

  // Tocar un control sin la simulación corriendo deja un aviso.
  await modulo(page, 'btn1').locator('.ctrl').click();
  await expect(page.locator('#punto-notificaciones')).toBeVisible();

  await page.locator('#tw-notificaciones').click();
  const notifs = lista.locator('.notif');
  await expect(notifs).toHaveCount(1);
  await expect(notifs.first()).toContainText('Ejecutar');
  await expect(notifs.first().locator('time')).toHaveText(/\d{1,2}:\d{2}/);

  // Con la lista abierta, un aviso nuevo aparece en vivo y arriba. El botón del panel no la cierra
  // (el click afuera sí), así que se usa para generar otro aviso sin perderla.
  await page.locator('#tw-notificaciones').click();
  await expect(lista).toBeHidden();
  await modulo(page, 'btn1').locator('.etiqueta-modulo').click();
  await page.locator('#tw-notificaciones').click();
  await expect(lista).toBeVisible();
  await page.locator('#panel-modulo .btn-accionar').click();
  await expect(notifs).toHaveCount(2);
});
