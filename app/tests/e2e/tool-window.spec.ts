import { expect, test, type Page } from '@playwright/test';
import { abrirProyectoNuevo, modulo, seleccionarModulo } from './helpers.js';

async function icono(page: Page, id: string, abierto: boolean) {
  const button = page.locator(`#${id}`);
  await expect(button).toHaveAttribute('aria-expanded', String(abierto));
  if (abierto) await expect(button).toHaveClass(/\bactiva\b/);
  else await expect(button).not.toHaveClass(/\bactiva\b/);
}

test('cada herramienta abre y cierra su propia ventana sin ocultar la otra', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  const componentes = page.locator('#ventana-componentes');
  const explorador = page.locator('#ventana-explorador');
  await expect(componentes).toBeVisible();
  await expect(explorador).toBeHidden();
  await expect(componentes.locator('#lista-modulos')).toBeVisible();
  await expect(componentes.locator('#buscar-modulos')).toBeVisible();
  await icono(page, 'tw-catalogo', true);
  await icono(page, 'tw-explorador', false);

  await page.locator('#tw-explorador').click();
  await expect(explorador).toBeVisible();
  await expect(componentes).toBeVisible();
  await expect(explorador.locator('#explorador-archivos')).toContainText('main.yaml');
  await expect(explorador.locator('#lista-modulos, #buscar-modulos')).toHaveCount(0);
  await expect(componentes.locator('#explorador-archivos')).toHaveCount(0);
  await icono(page, 'tw-explorador', true);
  await icono(page, 'tw-catalogo', true);

  await explorador.getByRole('button', { name: 'Ocultar Explorador', exact: true }).click();
  await expect(explorador).toBeHidden();
  await expect(componentes).toBeVisible();
  await icono(page, 'tw-explorador', false);
  await icono(page, 'tw-catalogo', true);
  await page.locator('#tw-explorador').click();
  await page.locator('#tw-catalogo').click();
  await expect(componentes).toBeHidden();
  await expect(explorador).toBeVisible();
  await icono(page, 'tw-catalogo', false);
  await icono(page, 'tw-explorador', true);
  await page.locator('#tw-catalogo').click();
  await expect(componentes).toBeVisible();
  await expect(explorador).toBeVisible();
});

test('mueve ambas herramientas entre laterales conservando filtro y selección', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  await page.locator('#buscar-modulos').fill('433');
  const filtered = await page.locator('#lista-modulos .modulo-card').count();
  expect(filtered).toBeGreaterThan(0);
  await seleccionarModulo(page, 'btn1');
  await expect(modulo(page, 'btn1')).toHaveClass(/\bseleccionado\b/);
  await page.locator('#tw-explorador').click();

  const explorador = page.locator('#ventana-explorador');
  await explorador.getByRole('button', { name: 'Mover Explorador al lateral derecho', exact: true }).click();
  await expect(page.locator('#dock-der > #ventana-explorador')).toBeVisible();
  await expect(page.locator('#dock-izq > #ventana-componentes')).toBeVisible();
  await expect(page.locator('#dock-izq > #ventana-explorador')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/ventanas-independientes.png' });
  await expect(modulo(page, 'btn1')).toHaveClass(/\bseleccionado\b/);
  await icono(page, 'tw-explorador', true);
  await icono(page, 'tw-catalogo', true);

  const componentes = page.locator('#ventana-componentes');
  await componentes.getByRole('button', { name: 'Mover Componentes al lateral derecho', exact: true }).click();
  await expect(page.locator('#dock-der > #ventana-componentes')).toBeVisible();
  await expect(page.locator('#buscar-modulos')).toHaveValue('433');
  await expect(page.locator('#lista-modulos .modulo-card')).toHaveCount(filtered);
  await expect(modulo(page, 'btn1')).toHaveClass(/\bseleccionado\b/);
  await componentes.getByRole('button', { name: 'Mover Componentes al lateral izquierdo', exact: true }).click();
  await explorador.getByRole('button', { name: 'Mover Explorador al lateral izquierdo', exact: true }).click();
  await expect(page.locator('#dock-izq > #ventana-componentes')).toBeVisible();
  await expect(page.locator('#dock-izq > #ventana-explorador')).toBeVisible();
  await expect(page.locator('#buscar-modulos')).toHaveValue('433');
  await expect(page.locator('#lista-modulos .modulo-card')).toHaveCount(filtered);
});

test('persiste lateral y apertura individual al recargar', async ({ page, request }) => {
  const name = await abrirProyectoNuevo(page, request);
  await page.locator('#tw-explorador').click();
  await page.locator('#ventana-explorador').getByRole('button', { name: 'Mover Explorador al lateral derecho', exact: true }).click();
  await page.locator('#ventana-componentes').getByRole('button', { name: 'Ocultar Componentes', exact: true }).click();
  await page.reload();
  await expect(page.locator('#proyecto')).toHaveValue(name);
  await expect(page.locator('#dock-der > #ventana-explorador')).toBeVisible();
  await expect(page.locator('#ventana-componentes')).toBeHidden();
  await icono(page, 'tw-explorador', true);
  await icono(page, 'tw-catalogo', false);
  await expect(page.locator('#explorador-archivos')).toContainText('main.yaml');
  await page.locator('#tw-catalogo').click();
  await expect(page.locator('#dock-izq > #ventana-componentes')).toBeVisible();
  await page.locator('#ventana-explorador').getByRole('button', { name: 'Ocultar Explorador', exact: true }).click();
  await page.reload();
  await expect(page.locator('#ventana-componentes')).toBeVisible();
  await expect(page.locator('#ventana-explorador')).toBeHidden();
  await icono(page, 'tw-catalogo', true);
  await icono(page, 'tw-explorador', false);
});
