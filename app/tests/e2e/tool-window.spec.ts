import { expect, test, type Page } from '@playwright/test';
import { abrirProyectoNuevo } from './helpers.js';
import { arrastrarVentana, grupoVentana } from './docking-helpers.js';

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
  await expect(page.locator('#ventana-explorador h2, #ventana-componentes h2, .window-code-header')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Detalle', exact: true })).toHaveCount(0);
  await expect(page.locator('#importar-modulo')).toBeVisible();
  await expect(componentes).toBeVisible();
  await expect(explorador).toBeVisible();
  await expect(componentes.locator('#lista-modulos')).toBeVisible();
  await expect(componentes.locator('#buscar-modulos')).toBeVisible();
  await icono(page, 'tw-catalogo', true);
  await icono(page, 'tw-explorador', true);

  await expect(explorador).toBeVisible();
  await expect(componentes).toBeVisible();
  await expect(explorador.locator('#explorador-archivos')).toContainText('main.yaml');
  await expect(explorador.locator('#lista-modulos, #buscar-modulos')).toHaveCount(0);
  await expect(componentes.locator('#explorador-archivos')).toHaveCount(0);
  await icono(page, 'tw-explorador', true);
  await icono(page, 'tw-catalogo', true);

  await grupoVentana(page, 'explorador').getByRole('button', { name: 'Ocultar Explorador', exact: true }).click();
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

test('todas las ventanas se abren por defecto y se cierran con cruz y reabren desde Menú → Ver', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  await expect(page.locator('#tw-circuito, #act-mover, #act-proyectos, #act-codigo')).toHaveCount(0);
  await page.locator('#buscar-modulos').fill('433');
  const count = await page.locator('#lista-modulos .modulo-card').count();
  const windows = [
    { id: 'explorador', title: 'Explorador', menu: 'Explorador de archivos' },
    { id: 'componentes', title: 'Componentes', menu: 'Componentes' },
    { id: 'circuito', title: 'Circuito', menu: 'Circuito' },
    { id: 'codigo', title: 'Código', menu: 'Código' },
    { id: 'detalle', title: 'Detalle', menu: 'Detalle' },
    { id: 'consola', title: 'Consola', menu: 'Consola' },
  ];
  for (const item of windows) {
    const pane = page.locator(`#ventana-${item.id}`);
    await expect(pane).toBeVisible();
    const close = grupoVentana(page, item.id).getByRole('button', { name: `Ocultar ${item.title}`, exact: true });
    await expect(close).toHaveText('×');
    await close.click();
    await expect(pane).toBeHidden();
    for (const other of windows.filter(other => other.id !== item.id)) {
      await expect(page.locator(`#ventana-${other.id}`)).toBeVisible();
    }
    await page.locator('#menu-principal').click();
    await page.locator('#menu > .menu-item').filter({ hasText: /^Ver/ }).hover();
    await page.getByRole('menuitem', { name: new RegExp(`^${item.menu}`) }).click();
    await expect(pane).toBeVisible();
  }
  await expect(page.locator('#buscar-modulos')).toHaveValue('433');
  await expect(page.locator('#lista-modulos .modulo-card')).toHaveCount(count);
  await expect(page.locator('#editor')).toHaveValue(/name:/);
  await page.screenshot({ path: '/tmp/emulador-ventanas-predeterminadas.png' });
});

test('sin placa se ven las herramientas y Código no está disponible en Ver', async ({ page, request }) => {
  const name = `sin-placa-ventanas-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name, board: null, language: null } });
  await page.goto(`/#${name}`);
  for (const id of ['explorador', 'componentes', 'circuito', 'detalle', 'consola']) await expect(page.locator(`#ventana-${id}`)).toBeVisible();
  await expect(page.locator('#ventana-codigo')).toBeHidden();
  await page.locator('#menu-principal').click();
  await page.locator('#menu > .menu-item').filter({ hasText: /^Ver/ }).hover();
  await expect(page.getByRole('menuitem', { name: /^Código/ })).toBeDisabled();
});

test('agrupar Componentes con Circuito conserva filtro al cerrar, reabrir y recargar', async ({ page, request }) => {
  const name = await abrirProyectoNuevo(page, request);
  await page.locator('#buscar-modulos').fill('433');
  const count = await page.locator('#lista-modulos .modulo-card').count();
  await arrastrarVentana(page, 'Componentes', 'circuito', 'center');
  const grouped = grupoVentana(page, 'componentes');
  await expect(grouped.getByRole('tab', { name: 'Circuito', exact: true })).toBeVisible();
  await expect(grouped.getByRole('tab', { name: 'Componentes', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#buscar-modulos')).toHaveValue('433');
  await expect(page.locator('#lista-modulos .modulo-card')).toHaveCount(count);
  await grupoVentana(page, 'componentes').getByRole('button', { name: 'Ocultar Componentes', exact: true }).click();
  await icono(page, 'tw-catalogo', false);
  await expect(page.locator('#ventana-circuito')).toBeVisible();
  await page.locator('#tw-catalogo').click();
  await icono(page, 'tw-catalogo', true);
  await expect(page.locator('#buscar-modulos')).toHaveValue('433');
  await expect(page.locator('#lista-modulos .modulo-card')).toHaveCount(count);
  await page.reload();
  await expect(page.locator('#proyecto')).toHaveValue(name);
  await expect(grouped.getByRole('tab', { name: 'Componentes', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#buscar-modulos')).toHaveValue('433');
  await expect(page.locator('#lista-modulos .modulo-card')).toHaveCount(count);
});
