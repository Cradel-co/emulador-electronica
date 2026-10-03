import { expect, test, type Page } from '@playwright/test';
import { abrirProyectoNuevo } from './helpers.js';

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

test('cerrar y reabrir cada ventana actualiza únicamente su icono y conserva el contenido', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  await page.locator('#buscar-modulos').fill('433');
  const count = await page.locator('#lista-modulos .modulo-card').count();
  await page.locator('#tw-explorador').click();
  const windows = [
    { id: 'explorador', title: 'Explorador', icon: 'tw-explorador' },
    { id: 'componentes', title: 'Componentes', icon: 'tw-catalogo' },
    { id: 'circuito', title: 'Circuito', icon: 'tw-circuito' },
    { id: 'codigo', title: 'Código', icon: 'act-codigo' },
    { id: 'consola', title: 'Consola', icon: 'tw-build' },
  ];
  for (const item of windows) {
    const pane = page.locator(`#ventana-${item.id}`);
    await pane.getByRole('button', { name: `Ocultar ${item.title}`, exact: true }).click();
    await expect(pane).toBeHidden();
    await expect(page.locator(`#${item.icon}`)).not.toHaveClass(/\bactiva\b/);
    for (const other of windows.filter(other => other.id !== item.id)) {
      await expect(page.locator(`#${other.icon}`)).toHaveClass(/\bactiva\b/);
      await expect(page.locator(`#ventana-${other.id}`)).toBeVisible();
    }
    await page.locator(`#${item.icon}`).click();
    await expect(pane).toBeVisible();
    await expect(page.locator(`#${item.icon}`)).toHaveClass(/\bactiva\b/);
  }
  await expect(page.locator('#buscar-modulos')).toHaveValue('433');
  await expect(page.locator('#lista-modulos .modulo-card')).toHaveCount(count);
  await expect(page.locator('#explorador-archivos')).toContainText('main.yaml');
  await expect(page.locator('#editor')).toHaveValue(/name:/);
});

test('agrupar Componentes con Circuito conserva filtro al cerrar, reabrir y recargar', async ({ page, request }) => {
  const name = await abrirProyectoNuevo(page, request);
  await page.locator('#buscar-modulos').fill('433');
  const count = await page.locator('#lista-modulos .modulo-card').count();
  const handle = page.locator('[data-window-drag="componentes"]');
  const circuitGroup = page.locator('#dock-layout [data-dock-group]').filter({ has: page.locator('#ventana-circuito') });
  const from = await handle.boundingBox();
  const to = await circuitGroup.boundingBox();
  expect(from).not.toBeNull(); expect(to).not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
    await expect(page.locator('[data-dock-zone="center"]')).toBeVisible();
  } finally { await page.mouse.up(); }
  const grouped = page.locator('#dock-layout [data-dock-group]').filter({ has: page.locator('#ventana-componentes') });
  await expect(grouped.getByRole('tab', { name: 'Circuito', exact: true })).toBeVisible();
  await expect(grouped.getByRole('tab', { name: 'Componentes', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#buscar-modulos')).toHaveValue('433');
  await expect(page.locator('#lista-modulos .modulo-card')).toHaveCount(count);
  await page.locator('#ventana-componentes').getByRole('button', { name: 'Ocultar Componentes', exact: true }).click();
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
