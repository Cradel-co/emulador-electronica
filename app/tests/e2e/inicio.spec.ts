import { expect, test } from '@playwright/test';
import { abrirProyectoNuevo } from './helpers';

const cardDe = (page, nombre: string) => page.locator('.proyecto-card', { has: page.locator('.nombre', { hasText: nombre }) });

test.describe('pantalla de inicio', () => {
  test('una visita nueva (sin proyecto en la URL) muestra la lista, no abre ninguno solo', async ({ page, request }) => {
    // Un proyecto ya creado de antes: si la app abriera "el primero" solo, esto lo detectaría.
    await abrirProyectoNuevo(page, request);
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/inicio/);
    await expect(page.locator('#pantalla-inicio')).toBeVisible();
    await expect(page.locator('main')).toBeHidden();
    await expect(page.locator('.simbar')).toBeHidden();
    await expect(page.locator('#proyecto')).toHaveValue(''); // nada seleccionado
  });

  test('un link directo (#proyecto) sigue abriendo el proyecto derecho, sin pasar por la lista', async ({ page, request }) => {
    const nombre = await abrirProyectoNuevo(page, request); // ya navega a /#nombre
    await expect(page.locator('body')).not.toHaveClass(/inicio/);
    await expect(page.locator('#pantalla-inicio')).toBeHidden();
    await expect(page.locator('#proyecto')).toHaveValue(nombre);
  });

  test('la tarjeta de un proyecto muestra su lenguaje y cuántos módulos tiene, y lo abre al tocarla', async ({ page, request }) => {
    const nombre = await abrirProyectoNuevo(page, request);
    await page.locator('.modulo-card[data-type="led"]').click(); // ahora tiene 4 módulos: board, btn1, led1, led2
    await page.waitForResponse((r) => r.url().includes('/diagram') && r.ok());

    await page.locator('#ir-inicio').click();
    await expect(page.locator('body')).toHaveClass(/inicio/);
    const card = cardDe(page, nombre);
    await expect(card.locator('.lenguaje')).toHaveText('esphome');
    await expect(card.locator('.detalle')).toContainText('4 módulo');

    await card.locator('.proyecto-abrir').click();
    await expect(page.locator('body')).not.toHaveClass(/inicio/);
    await expect(page.locator('#proyecto')).toHaveValue(nombre);
  });

  test('"+ Nuevo proyecto" desde la lista crea y abre el proyecto', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('#ir-inicio').click();
    const nombre = `e2e-inicio-${Date.now().toString(36)}`;
    await page.locator('#nuevo-inicio').click();
    await page.locator('#dlg-nuevo input[name="name"]').fill(nombre);
    await page.locator('#dlg-nuevo button[value="crear"]').click();
    await expect(page.locator('body')).not.toHaveClass(/inicio/);
    await expect(page.locator('#proyecto')).toHaveValue(nombre);
  });

  test('eliminar un proyecto desde su tarjeta lo saca de la lista y del selector', async ({ page, request }) => {
    const nombre = await abrirProyectoNuevo(page, request);
    await page.locator('#ir-inicio').click();
    const card = cardDe(page, nombre);
    await expect(card).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await card.hover();
    await card.locator('.quitar').click();
    await expect(cardDe(page, nombre)).toHaveCount(0);
    await expect(page.locator(`#proyecto option[value="${nombre}"]`)).toHaveCount(0);
  });

  test('"atrás" del navegador desde un proyecto vuelve a la lista', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.goto('/');
    await abrirProyectoNuevo(page, request);
    await page.goBack();
    await expect(page.locator('body')).toHaveClass(/inicio/);
  });
});
