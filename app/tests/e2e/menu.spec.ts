import { test, expect } from '@playwright/test';
import { abrirProyectoNuevo } from './helpers.js';

/**
 * El menú principal (hamburguesa). No tenía ningún e2e: se escribió antes de migrarlo a React
 * (#9) y contra el código imperativo, para que la migración tenga red.
 */
test.describe('menú principal', () => {
  test('abre con los seis grupos y se cierra al hacer click afuera', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    const menu = page.locator('#menu');
    await expect(menu).toBeHidden();

    await page.locator('#menu-principal').click();
    await expect(menu).toBeVisible();
    await expect(page.locator('#menu-principal')).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.locator(':scope > .menu-item.sub')).toHaveText(
      ['Archivo', 'Editar', 'Ver', 'Simulación', 'Depurar', 'Ayuda'].map((g) => new RegExp(`^${g}`)),
    );

    // Click afuera lo cierra.
    await page.mouse.click(5, 900);
    await expect(menu).toBeHidden();
    await expect(page.locator('#menu-principal')).toHaveAttribute('aria-expanded', 'false');

    // Y el mismo botón lo abre y lo cierra.
    await page.locator('#menu-principal').click();
    await expect(menu).toBeVisible();
    await page.locator('#menu-principal').click();
    await expect(menu).toBeHidden();
  });

  test('al pasar por un grupo se abre su submenú, con los atajos a la derecha', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('#menu-principal').click();
    const ver = page.locator('#menu > .menu-item.sub', { hasText: /^Ver/ });
    await ver.hover();
    await expect(ver).toHaveClass(/abierto/);
    const items = ver.locator('.submenu .menu-item');
    await expect(items.filter({ hasText: 'Componentes' })).toBeVisible();
    await expect(items.filter({ hasText: 'Componentes' }).locator('.atajo')).toHaveText('Alt+1');

    // Abrir otro grupo cierra el anterior.
    const editar = page.locator('#menu > .menu-item.sub', { hasText: /^Editar/ });
    await editar.hover();
    await expect(editar).toHaveClass(/abierto/);
    await expect(ver).not.toHaveClass(/abierto/);
  });

  test('una acción se ejecuta y cierra el menú; las no disponibles están deshabilitadas', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('#menu-principal').click();

    // "Parar" sin simulación corriendo no tiene sentido: deshabilitado.
    const sim = page.locator('#menu > .menu-item.sub', { hasText: /^Simulación/ });
    await sim.hover();
    await expect(sim.locator('.submenu .menu-item', { hasText: /^Parar/ })).toBeDisabled();

    // "Atajos y acerca de" abre su diálogo y cierra el menú.
    const ayuda = page.locator('#menu > .menu-item.sub', { hasText: /^Ayuda/ });
    await ayuda.hover();
    await ayuda.locator('.submenu .menu-item', { hasText: 'Atajos y acerca de' }).click();
    await expect(page.locator('#dlg-acerca')).toBeVisible();
    await expect(page.locator('#menu')).toBeHidden();
  });

  test('se maneja con el teclado: flechas entre grupos y derecha para entrar', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('#menu-principal').click();
    // Al abrirse, el foco va al primer grupo.
    await expect(page.locator('#menu > .menu-item.sub').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#menu > .menu-item.sub', { hasText: /^Editar/ })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    // Entra al submenú: el foco queda en su primer item habilitado.
    const enfocado = page.locator('#menu .submenu .menu-item:focus');
    await expect(enfocado).toHaveCount(1);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#menu > .menu-item.sub', { hasText: /^Editar/ })).toBeFocused();
  });
});
