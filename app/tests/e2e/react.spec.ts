import { test, expect } from '@playwright/test';
import { abrirProyectoNuevo, modulo } from './helpers.js';

/**
 * Paso 1 de la migración a React (#9): la cadena Vite → React → navegador está armada y React
 * monta de verdad, sin que la UI actual cambie en nada.
 */
test('React monta y la UI de siempre sigue funcionando', async ({ page, request }) => {
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

  await abrirProyectoNuevo(page, request);

  // React montó en su raíz.
  await expect(page.locator('#react-root #react-listo')).toBeAttached();

  // Y la UI vieja sigue en pie: el dibujo, el editor y los paneles.
  await expect(modulo(page, 'board')).toBeVisible();
  await expect(modulo(page, 'led1')).toBeVisible();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#lienzo .cable')).not.toHaveCount(0);

  expect(errores, 'la consola del navegador no debe tener errores').toEqual([]);
});
