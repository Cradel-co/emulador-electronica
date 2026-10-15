import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { agarreVentana, arrastrarVentana as arrastrar, grupoVentana as grupo, previewDock } from './docking-helpers.js';

let serial = 0;
async function crearProyecto(request: APIRequestContext) {
  const name = `docking-${Date.now().toString(36)}-${serial++}`;
  expect((await request.post('/api/projects', { data: { name, language: 'micropython' } })).ok()).toBeTruthy();
  expect((await request.put(`/api/projects/${name}/files/main.py`, { data: { content: 'valor = 1\n' } })).ok()).toBeTruthy();
  return name;
}
async function abrir(page: Page, name: string) {
  await page.goto(`/#${name}`);
  await expect(page.locator('#proyecto')).toHaveValue(name);
  await expect(page.locator('.cm-content')).toBeVisible();
}
async function configuracion(page: Page) {
  await page.locator('#act-ajustes').click();
  await page.locator('#dlg-ajustes').getByRole('button', { name: 'Distribución de ventanas', exact: true }).click();
  await expect(page.locator('#dlg-layout-settings')).toBeVisible();
  return page.locator('#dlg-layout-settings');
}
async function cerrarConfiguracion(settings: Locator) {
  await settings.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(settings).toBeHidden();
}

test('agrupa ventanas como pestañas, las cierra individualmente y mueve Explorador y Consola', async ({ page, request }) => {
  await abrir(page, await crearProyecto(request));
  await arrastrar(page, 'Componentes', 'circuito', 'center');
  const circuit = grupo(page, 'circuito');
  await expect(circuit.getByRole('tab', { name: 'Componentes', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(circuit.getByRole('tab', { name: 'Circuito', exact: true })).toBeVisible();
  await grupo(page, 'componentes').getByRole('button', { name: 'Ocultar Componentes', exact: true }).click();
  await expect(page.locator('#ventana-componentes')).toBeHidden();
  await expect(page.locator('#ventana-circuito')).toBeVisible();
  await expect(page.locator('#ventana-codigo')).toBeVisible();
  await page.locator('#tw-explorador').click();
  await arrastrar(page, 'Explorador', 'circuito', 'bottom');
  await expect(page.locator('#explorador-archivos')).toContainText('main.py');
  await arrastrar(page, 'Consola', 'codigo', 'bottom');
  await expect(page.locator('#ventana-consola')).toBeVisible();
  await expect(page.locator('#ventana-codigo')).toBeVisible();
  for (const id of ['explorador', 'componentes', 'circuito', 'codigo', 'consola']) await expect(page.locator(`#ventana-${id}`)).toHaveCount(1);
  await page.screenshot({ path: '/tmp/ventanas-acopladas.png' });
});

test('mover Código y Circuito conserva código sin guardar, historial y selección', async ({ page, request }) => {
  const name = await crearProyecto(request);
  await abrir(page, name);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let release!: () => void;
  const pendingSave = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/projects/${name}/files/main.py*`, async route => {
    if (route.request().method() === 'PUT') await pendingSave;
    await route.continue();
  });
  const content = page.locator('.cm-content');
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('valor_nuevo = 2');
  try {
    await arrastrar(page, 'Código', 'componentes', 'right');
    await expect(page.locator('#editor')).toHaveValue('valor = 1\nvalor_nuevo = 2');
    expect((await (await request.get(`/api/projects/${name}/files/main.py`)).json()).content).toBe('valor = 1\n');
    await page.locator('#lienzo .modulo[data-id="btn1"] .etiqueta-modulo').click();
    await expect(page.locator('#lienzo .modulo[data-id="btn1"]')).toHaveClass(/seleccionado/);
    await arrastrar(page, 'Circuito', 'codigo', 'top');
    await expect(page.locator('#lienzo .modulo[data-id="btn1"]')).toHaveClass(/seleccionado/);
    // Deseleccionar vuelve al editor dentro de la misma ventana Código.
    await page.keyboard.press('Escape');
    await expect(content).toBeVisible();
    await content.click();
    await page.keyboard.press('Control+z');
    await expect(page.locator('#editor')).toHaveValue('valor = 1\n');
    expect(errors).toEqual([]);
  } finally { release(); }
});

test('cada proyecto conserva su distribución al alternar y recargar', async ({ page, request }) => {
  const a = await crearProyecto(request);
  const b = await crearProyecto(request);
  await abrir(page, a);
  await arrastrar(page, 'Componentes', 'circuito', 'center');
  await expect(grupo(page, 'circuito').getByRole('tab', { name: 'Componentes', exact: true })).toBeVisible();
  await page.locator('#proyecto').selectOption(b);
  await expect(page.locator('#proyecto')).toHaveValue(b);
  await expect(page.locator('#ventana-componentes')).toBeVisible();
  await expect(page.locator('#ventana-circuito')).toBeVisible();
  expect(await grupo(page, 'componentes').getAttribute('data-dock-group')).not.toBe(await grupo(page, 'circuito').getAttribute('data-dock-group'));
  await page.locator('#proyecto').selectOption(a);
  await expect(grupo(page, 'circuito').getByRole('tab', { name: 'Componentes', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('#proyecto')).toHaveValue(a);
  await expect(grupo(page, 'circuito').getByRole('tab', { name: 'Componentes', exact: true })).toBeVisible();
});

test('redimensiona separadores y conserva la proporción al recargar', async ({ page, request }) => {
  await abrir(page, await crearProyecto(request));
  const separator = page.getByRole('separator', { name: 'Redimensionar ventanas', exact: true }).first();
  await expect(separator).toBeVisible();
  const vertical = await separator.getAttribute('aria-orientation') === 'vertical';
  const dimension = async () => page.locator('[data-dock-group]').evaluateAll((groups, vertical) => groups.map(group => {
    const rect = group.getBoundingClientRect();
    return { id: group.getAttribute('data-dock-group'), size: vertical ? rect.width : rect.height };
  }), vertical);
  const before = await dimension();
  const box = (await separator.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (vertical ? 80 : 0), y + (vertical ? 0 : 80), { steps: 8 });
  await page.mouse.up();
  const after = await dimension();
  const changed = after.find(group => Math.abs(group.size - (before.find(old => old.id === group.id)?.size ?? group.size)) > 15);
  expect(changed, 'arrastrar un separador debe cambiar el espacio asignado a sus grupos').toBeTruthy();
  await page.reload();
  await expect.poll(async () => {
    const restored = (await dimension()).find(group => group.id === changed!.id);
    return restored ? Math.abs(restored.size - changed!.size) : Infinity;
  }).toBeLessThan(8);
});

test('guarda un predeterminado y permite restaurar el proyecto y el original desde Ajustes', async ({ page, request }) => {
  const a = await crearProyecto(request);
  const b = await crearProyecto(request);
  await abrir(page, a);
  await arrastrar(page, 'Componentes', 'circuito', 'center');
  let settings = await configuracion(page);
  await expect(settings).toContainText('Cada proyecto guarda su distribución');
  await settings.getByRole('button', { name: 'Guardar distribución actual como predeterminada', exact: true }).click();
  await cerrarConfiguracion(settings);
  await page.locator('#proyecto').selectOption(b);
  await expect(grupo(page, 'circuito').getByRole('tab', { name: 'Componentes', exact: true })).toBeVisible();
  await grupo(page, 'circuito').getByRole('tab', { name: 'Circuito', exact: true }).click();
  await grupo(page, 'circuito').getByRole('button', { name: 'Ocultar Circuito', exact: true }).click();
  await expect(page.locator('#ventana-circuito')).toBeHidden();
  settings = await configuracion(page);
  await settings.getByRole('button', { name: 'Restaurar este proyecto al predeterminado', exact: true }).click();
  await cerrarConfiguracion(settings);
  await expect(grupo(page, 'circuito').getByRole('tab', { name: 'Circuito', exact: true })).toBeVisible();
  settings = await configuracion(page);
  await settings.getByRole('button', { name: 'Restablecer el predeterminado original', exact: true }).click();
  await settings.getByRole('button', { name: 'Restaurar este proyecto al predeterminado', exact: true }).click();
  await cerrarConfiguracion(settings);
  await expect(page.locator('#ventana-componentes')).toBeVisible();
  await expect(page.locator('#ventana-circuito')).toBeVisible();
  expect(await grupo(page, 'componentes').getAttribute('data-dock-group')).not.toBe(await grupo(page, 'circuito').getAttribute('data-dock-group'));
});

test('Ajustes deshabilita acciones de proyecto en la bienvenida', async ({ page }) => {
  await page.goto('/');
  const settings = await configuracion(page);
  await expect(settings.getByRole('button', { name: 'Guardar distribución actual como predeterminada', exact: true })).toBeDisabled();
  await expect(settings.getByRole('button', { name: 'Restaurar este proyecto al predeterminado', exact: true })).toBeDisabled();
  await expect(settings.getByRole('button', { name: 'Restablecer el predeterminado original', exact: true })).toBeEnabled();
});

test('Escape o soltar fuera cancela el movimiento sin cambiar la selección ni la distribución', async ({ page, request }) => {
  await abrir(page, await crearProyecto(request));
  await page.locator('#lienzo .modulo[data-id="btn1"] .etiqueta-modulo').click();
  const handle = agarreVentana(page, 'Componentes');
  const original = await grupo(page, 'componentes').getAttribute('data-dock-group');
  const start = (await handle.boundingBox())!;
  const destination = (await grupo(page, 'circuito').locator('.dv-content-container').boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 8 });
  await expect(previewDock(page, 'center').first()).toBeVisible();
  await expect(page.locator('[data-dock-dragging]')).toHaveAttribute('data-dock-dragging', 'componentes');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(previewDock(page)).toHaveCount(0);
  await expect(page.locator('[data-dock-dragging]')).toHaveCount(0);
  await expect(grupo(page, 'componentes')).toHaveAttribute('data-dock-group', original!);
  await expect(page.locator('#lienzo .modulo[data-id="btn1"]')).toHaveClass(/seleccionado/);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(4, 20, { steps: 8 });
  await expect(page.locator('[data-dock-dragging]')).toHaveAttribute('data-dock-dragging', 'componentes');
  await page.mouse.up();
  await expect(page.locator('[data-dock-dragging]')).toHaveCount(0);
  await expect(previewDock(page)).toHaveCount(0);
  await expect(grupo(page, 'componentes')).toHaveAttribute('data-dock-group', original!);
});
