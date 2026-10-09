import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { seleccionarModulo } from './helpers.js';

let serial = 0;
const explorer = (page: Page) => page.locator('#explorador-archivos');
const file = (page: Page, path: string) => explorer(page).locator(`button[title="${path}"]`);

async function proyecto(request: APIRequestContext) {
  const name = `explorer-files-${Date.now().toString(36)}-${serial++}`;
  expect((await request.post('/api/projects', { data: { name, language: 'micropython' } })).ok()).toBeTruthy();
  expect((await request.put(`/api/projects/${name}/files/main.py`, { data: { content: 'original = True\n' } })).ok()).toBeTruthy();
  return name;
}
async function abrir(page: Page, name: string) {
  await page.goto(`/#${name}`);
  await expect(page.locator('#proyecto')).toHaveValue(name);
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.keyboard.press('Control+Shift+e');
  await expect(explorer(page)).toBeVisible();
}
async function raiz(page: Page) {
  await explorer(page).locator('.file-explorer-tree').click({ position: { x: 5, y: 200 } });
}
async function seleccionarCarpeta(page: Page, path: string) {
  const entry = explorer(page).locator(`summary[title="${path}"]`);
  await entry.click();
  // La selección del summary también pliega la carpeta: abrirla conserva el destino.
  if (await entry.locator('..').getAttribute('open') === null) await entry.click();
  await expect(entry).toHaveClass(/activa/);
}
async function formulario(page: Page, kind: 'file' | 'directory', name: string) {
  await page.locator('#ventana-explorador').getByRole('button', { name: kind === 'file' ? 'Nuevo archivo' : 'Nueva carpeta', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: kind === 'file' ? 'Nuevo archivo MicroPython' : 'Nueva carpeta', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.locator('#nuevo-archivo-nombre').fill(name);
  return dialog;
}
async function crear(page: Page, kind: 'file' | 'directory', name: string) {
  const dialog = await formulario(page, kind, name);
  await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function escribirYGuardar(page: Page, request: APIRequestContext, project: string, path: string, content: string, boardId = 'board') {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(content);
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await (await request.get(`/api/projects/${project}/files/${path}?boardId=${boardId}`)).json()).content).toBe(content);
}

test('crea una carpeta vacía desde el explorador y la conserva al recargar', async ({ page, request }) => {
  const name = await proyecto(request);
  await abrir(page, name);
  await raiz(page);
  await crear(page, 'directory', 'vacia');
  await expect(explorer(page).locator('summary[title="vacia"]')).toBeVisible();
  let summary = await (await request.get(`/api/projects/${name}`)).json();
  expect(summary.directories).toContain('vacia');
  expect(summary.files.some((entry: { path: string }) => entry.path.startsWith('vacia/'))).toBe(false);
  await page.reload();
  await expect(explorer(page).locator('summary[title="vacia"]')).toBeVisible();
  summary = await (await request.get(`/api/projects/${name}`)).json();
  expect(summary.directories).toContain('vacia');
});

test('crea paquetes anidados y archivos hermanos con extensión automática y guarda imports en main', async ({ page, request }) => {
  const name = await proyecto(request);
  await abrir(page, name);
  await raiz(page);
  await crear(page, 'directory', 'lib/sensores');
  await seleccionarCarpeta(page, 'lib');
  await crear(page, 'file', '__init__.py');
  await expect(page.locator('#tabs-archivos button.activa')).toHaveText('lib/__init__.py');
  await escribirYGuardar(page, request, name, 'lib/__init__.py', 'from .sensores.temperatura import leer\n');
  await seleccionarCarpeta(page, 'lib/sensores');
  await crear(page, 'file', '__init__.py');
  await seleccionarCarpeta(page, 'lib/sensores');
  await crear(page, 'file', 'temperatura');
  await expect(page.locator('#tabs-archivos button.activa')).toHaveText('lib/sensores/temperatura.py');
  await escribirYGuardar(page, request, name, 'lib/sensores/temperatura.py', 'def leer():\n    return 24\n');
  // Sin seleccionar una carpeta, el archivo activo define dónde crear su hermano.
  await crear(page, 'file', 'humedad');
  await expect(page.locator('#tabs-archivos button.activa')).toHaveText('lib/sensores/humedad.py');
  await expect(file(page, 'lib/sensores/humedad.py')).toBeVisible();
  await file(page, 'main.py').click();
  const main = 'from lib import leer\nfrom lib.sensores import humedad\nprint(leer())\n';
  await escribirYGuardar(page, request, name, 'main.py', main);
  await page.reload();
  await expect(page.locator('#editor')).toHaveValue(main);
  const summary = await (await request.get(`/api/projects/${name}`)).json();
  expect(summary.directories).toEqual(expect.arrayContaining(['lib', 'lib/sensores']));
  expect(summary.files.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining([
    'lib/__init__.py', 'lib/sensores/__init__.py', 'lib/sensores/temperatura.py', 'lib/sensores/humedad.py',
  ]));
});

test('las carpetas y archivos pertenecen a la placa seleccionada en el circuito', async ({ page, request }) => {
  const name = await proyecto(request);
  const added = await request.post(`/api/projects/${name}/board`, { data: { board: 'esp32-c3-devkitm-1', language: 'micropython', x: 450, y: 80 } });
  expect(added.ok()).toBeTruthy();
  const result = await added.json();
  const second = result.boardId ?? result.project.boards.at(-1).id;
  await abrir(page, name);
  await raiz(page);
  await crear(page, 'directory', 'solo_primaria');
  await seleccionarCarpeta(page, 'solo_primaria');
  await crear(page, 'file', 'valor');
  await escribirYGuardar(page, request, name, 'solo_primaria/valor.py', 'valor = 1\n');
  await seleccionarModulo(page, second);
  await expect(explorer(page).locator('.file-explorer-tree')).toHaveAttribute('data-board-id', second);
  await expect(explorer(page).locator('summary[title="solo_primaria"]')).toBeHidden();
  await raiz(page);
  await crear(page, 'directory', 'solo_secundaria');
  await seleccionarCarpeta(page, 'solo_secundaria');
  await crear(page, 'file', 'valor');
  await escribirYGuardar(page, request, name, 'solo_secundaria/valor.py', 'valor = 2\n', second);
  await seleccionarModulo(page, 'board');
  await expect(explorer(page).locator('.file-explorer-tree')).toHaveAttribute('data-board-id', 'board');
  await expect(explorer(page).locator('summary[title="solo_secundaria"]')).toBeHidden();
  await file(page, 'solo_primaria/valor.py').click();
  await expect(page.locator('#editor')).toHaveValue('valor = 1\n');
  await seleccionarModulo(page, second);
  await file(page, 'solo_secundaria/valor.py').click();
  await expect(page.locator('#editor')).toHaveValue('valor = 2\n');
  const primary = await (await request.get(`/api/projects/${name}?boardId=board`)).json();
  const secondary = await (await request.get(`/api/projects/${name}?boardId=${second}`)).json();
  expect(primary.directories).toContain('solo_primaria');
  expect(primary.directories).not.toContain('solo_secundaria');
  expect(secondary.directories).toContain('solo_secundaria');
  expect(secondary.directories).not.toContain('solo_primaria');
  await page.reload();
  await seleccionarModulo(page, second);
  await expect(file(page, 'solo_secundaria/valor.py')).toBeVisible();
});

test('un duplicado responde 409, conserva el contenido y deja el formulario abierto para corregirlo', async ({ page, request }) => {
  const name = await proyecto(request);
  await abrir(page, name);
  await raiz(page);
  const dialog = await formulario(page, 'file', 'main');
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/api/projects/${name}/files/main.py`));
  await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.locator('#nuevo-archivo-nombre')).toHaveValue('main');
  expect((await (await request.get(`/api/projects/${name}/files/main.py`)).json()).content).toBe('original = True\n');
  await dialog.locator('#nuevo-archivo-nombre').fill('otro');
  await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(file(page, 'otro.py')).toBeVisible();
  await raiz(page);
  await crear(page, 'directory', 'existente');
  const directoryDialog = await formulario(page, 'directory', 'existente');
  const duplicateDirectory = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/api/projects/${name}/directories`));
  await directoryDialog.getByRole('button', { name: 'Crear', exact: true }).click();
  expect((await duplicateDirectory).status()).toBe(409);
  await expect(directoryDialog).toBeVisible();
  await expect(directoryDialog.getByRole('alert')).toBeVisible();
});

test('rechaza traversal tanto en el formulario como en los endpoints sin crear entradas', async ({ page, request }) => {
  const name = await proyecto(request);
  await abrir(page, name);
  await raiz(page);
  const before = await (await request.get(`/api/projects/${name}`)).json();
  const dialog = await formulario(page, 'directory', '../fuera');
  await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('ruta relativa');
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  const fileDialog = await formulario(page, 'file', 'lib/../../fuera');
  await fileDialog.getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(fileDialog).toBeVisible();
  await expect(fileDialog.getByRole('alert')).toContainText('ruta relativa');
  expect((await request.post(`/api/projects/${name}/directories`, { data: { path: '../fuera' } })).status()).toBe(400);
  expect((await request.post(`/api/projects/${name}/files/..%2Ffuera.py`, { data: { content: 'no debe escribirse\n' } })).status()).toBe(403);
  const after = await (await request.get(`/api/projects/${name}`)).json();
  expect(after.directories).toEqual(before.directories);
  expect(after.files).toEqual(before.files);
});
