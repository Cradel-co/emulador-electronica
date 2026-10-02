import { test, expect } from '@playwright/test';
import { abrirProyectoNuevo } from './helpers.js';

/**
 * La paleta de comandos ("Buscar en todo"). No tenía ningún e2e: se escribió antes de migrarla a
 * React (#9) y contra el código imperativo, para que la migración tenga red.
 */
test.describe('paleta de comandos', () => {
  test('se abre con el botón y con Ctrl+Shift+P, con el foco en la entrada', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    const dlg = page.locator('#dlg-buscar');
    await page.locator('#buscar-todo').click();
    await expect(dlg).toBeVisible();
    await expect(page.locator('#pc-entrada')).toBeFocused();
    await expect(page.locator('#pc-lista li[role="option"]').first()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();

    await page.keyboard.press('Control+Shift+P');
    await expect(dlg).toBeVisible();
    // Se abre vacía aunque la vez anterior se hubiera escrito algo.
    await expect(page.locator('#pc-entrada')).toHaveValue('');
  });

  test('filtra mientras se escribe, resalta lo que coincide y avisa si no hay nada', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('#buscar-todo').click();
    const lista = page.locator('#pc-lista');

    await page.locator('#pc-entrada').fill('agregar led');
    const primero = lista.locator('li[role="option"]').first();
    await expect(primero.locator('.pc-titulo')).toContainText('Agregar LED');
    await expect(primero.locator('.pc-tipo')).toHaveText('Módulo');
    // Las palabras buscadas quedan marcadas.
    await expect(primero.locator('mark')).toHaveText(['Agregar', 'LED']);

    await page.locator('#pc-entrada').fill('zzzz-nada');
    await expect(lista.locator('.pc-vacio')).toHaveText('Nada coincide.');
  });

  test('las flechas mueven la selección y Enter ejecuta y cierra', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('#buscar-todo').click();
    const opciones = page.locator('#pc-lista li[role="option"]');

    await expect(opciones.nth(0)).toHaveClass(/sel/);
    await page.keyboard.press('ArrowDown');
    await expect(opciones.nth(1)).toHaveClass(/sel/);
    await expect(opciones.nth(0)).not.toHaveClass(/sel/);
    await page.keyboard.press('ArrowUp');
    await expect(opciones.nth(0)).toHaveClass(/sel/);
    // Desde el primero, arriba da la vuelta al último.
    await page.keyboard.press('ArrowUp');
    await expect(opciones.last()).toHaveClass(/sel/);

    // Enter ejecuta: agregar una resistencia suma un módulo al circuito.
    const antes = await page.locator('#lienzo .modulo').count();
    await page.locator('#pc-entrada').fill('agregar resistencia');
    await page.keyboard.press('Enter');
    await expect(page.locator('#dlg-buscar')).toBeHidden();
    await expect(page.locator('#lienzo .modulo')).toHaveCount(antes + 1);
  });

  test('un click en una opción la ejecuta; un click en el fondo cierra', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('#buscar-todo').click();
    await page.locator('#pc-entrada').fill('atajos y acerca');
    await page.locator('#pc-lista li[role="option"]').first().click();
    await expect(page.locator('#dlg-buscar')).toBeHidden();
    await expect(page.locator('#dlg-acerca')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.locator('#buscar-todo').click();
    await expect(page.locator('#dlg-buscar')).toBeVisible();
    // El fondo del <dialog> es el propio elemento, fuera de su caja de contenido.
    await page.mouse.click(5, 5);
    await expect(page.locator('#dlg-buscar')).toBeHidden();
  });
});
