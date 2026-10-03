import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { modulo, seleccionarModulo } from './helpers.js';
let serial = 0;
async function crearProyecto(request: APIRequestContext) {
  const name = `explorer-${Date.now().toString(36)}-${serial++}`;
  expect((await request.post('/api/projects', { data: { name, language: 'micropython' } })).ok()).toBeTruthy();
  expect((await request.put(`/api/projects/${name}/files/main.py`, { data: { content: 'primera = 1\n' } })).ok()).toBeTruthy();
  return name;
}
async function escribir(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(text);
}
async function abrir(page: Page, name: string) {
  await page.goto(`/#${name}`);
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('#tabs-archivos button.activa')).toHaveText('main.py');
}

test('explorador lateral jerárquico crea un archivo Python hermano con extensión automática', async ({ page, request }) => {
  const name = await crearProyecto(request);
  expect((await request.put(`/api/projects/${name}/files/lib/sensores/temperatura.py`, { data: { content: 'temperatura = 24\n' } })).ok()).toBeTruthy();
  for (let i = 0; i < 4; i++) expect((await request.put(`/api/projects/${name}/files/lib/sensores/archivo_largo_para_comprobar_desplazamiento_${i}.py`, { data: { content: '' } })).ok()).toBeTruthy();
  await abrir(page, name);
  const explorer = page.locator('#explorador-archivos');
  await expect(explorer.locator('summary')).toHaveText(['lib', 'sensores']);
  await explorer.getByRole('button', { name: 'temperatura.py', exact: true }).click();
  await expect(page.locator('#editor')).toHaveValue('temperatura = 24\n');
  const nuevo = page.getByRole('button', { name: 'Nuevo archivo MicroPython', exact: true });
  await expect(nuevo).toBeInViewport();
  await nuevo.click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo archivo MicroPython', exact: true });
  await dialog.getByLabel('Nombre del archivo').fill('humedad');
  await dialog.getByRole('button', { name: 'Crear', exact: true }).click();
  await expect(page.locator('#tabs-archivos button.activa')).toHaveText('lib/sensores/humedad.py');
  await expect(explorer.getByRole('button', { name: 'humedad.py', exact: true })).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('');
  await escribir(page, 'humedad = 60\n');
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await (await request.get(`/api/projects/${name}/files/lib/sensores/humedad.py`)).json()).content).toBe('humedad = 60\n');
  await expect(nuevo).toBeInViewport();
  await page.screenshot({ path: '/tmp/multiplaca-explorer.png' });
});

test('cada placa mantiene contenido e historial propios al seleccionarla en el circuito', async ({ page, request }) => {
  const sent: string[] = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => sent.push(String(payload))));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const name = await crearProyecto(request);
  const response = await request.post(`/api/projects/${name}/board`, { data: { board: 'esp32-c3-devkitm-1', language: 'micropython', x: 450, y: 80 } });
  expect(response.ok()).toBeTruthy();
  const result = await response.json();
  const secondId = result.boardId ?? result.project.boards.at(-1).id;
  expect(secondId).not.toBe('board');
  expect((await request.put(`/api/projects/${name}/files/main.py?boardId=${encodeURIComponent(secondId)}`, { data: { content: 'segunda = 2\n' } })).ok()).toBeTruthy();
  await abrir(page, name);
  const explorer = page.locator('#explorador-archivos');
  await expect(explorer.locator('select')).toHaveCount(0);
  await escribir(page, 'primera = 7\n');
  await seleccionarModulo(page, secondId);
  await expect(page.locator('#editor')).toHaveValue('segunda = 2\n');
  await expect(explorer.locator('h3 span')).toHaveText(secondId);
  expect((await (await request.get(`/api/projects/${name}/files/main.py`)).json()).content).toBe('primera = 7\n');
  await escribir(page, 'segunda = 8\n');
  await seleccionarModulo(page, 'board');
  await expect(page.locator('#editor')).toHaveValue('primera = 7\n');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await expect(page.locator('#editor')).toHaveValue('primera = 1\n');
  expect((await (await request.get(`/api/projects/${name}/files/main.py?boardId=${encodeURIComponent(secondId)}`)).json()).content).toBe('segunda = 8\n');
  await seleccionarModulo(page, secondId);
  await expect(page.locator('#editor')).toHaveValue('segunda = 8\n');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await expect(page.locator('#editor')).toHaveValue('segunda = 2\n');
  await expect(explorer.locator('h3 span')).toHaveText(secondId);
  const bpRequest = page.waitForResponse(r => r.url().includes('/api/debug/breakpoints') && r.url().includes(`boardId=${secondId}`) && r.request().method() === 'PUT');
  const line = await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^1$/ }).boundingBox();
  const gutter = await page.locator('.cm-breakpointGutter').boundingBox();
  expect(line).not.toBeNull(); expect(gutter).not.toBeNull();
  await page.mouse.click(gutter!.x + gutter!.width / 2, line!.y + line!.height / 2);
  expect((await bpRequest).ok()).toBeTruthy();
  await expect.poll(async () => (await (await request.get(`/api/debug/breakpoints?project=${name}&boardId=${secondId}`)).json()).breakpoints).toEqual(expect.arrayContaining([expect.objectContaining({ line: 1 })]));
  expect((await (await request.get(`/api/debug/breakpoints?project=${name}`)).json()).breakpoints).toEqual([]);
  await page.locator('#entrada-console').fill('print(42)');
  await page.locator('#entrada-console').press('Enter');
  await expect.poll(() => sent.some(payload => {
    const message = JSON.parse(payload);
    return message.type === 'console.input' && message.boardId === secondId && message.data === 'print(42)\n';
  })).toBe(true);
  expect(errors).toEqual([]);
});

test('agrega una segunda placa desde catálogo y quita únicamente la elegida', async ({ page, request }) => {
  const name = await crearProyecto(request);
  await abrir(page, name);
  await page.locator('#buscar-modulos').fill('ESP32-C3');
  await page.locator('.modulo-card[data-type="esp32-c3-devkitm-1"]').click();
  await expect(page.locator('#dlg-placa')).toBeVisible();
  await page.locator('#placa-lenguaje').selectOption('micropython');
  await page.locator('#dlg-placa button[value="agregar"]').click();
  let secondId = '';
  await expect.poll(async () => {
    const { project } = await (await request.get(`/api/projects/${name}`)).json();
    secondId = project.boards?.find((b: { id: string }) => b.id !== 'board')?.id ?? '';
    return project.boards?.length ?? 0;
  }).toBe(2);
  await expect(modulo(page, secondId)).toBeVisible();
  await seleccionarModulo(page, secondId);
  await expect(page.locator('#explorador-archivos h3 span')).toHaveText(secondId);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Quitar la placa', exact: true }).click();
  await expect(modulo(page, secondId)).toHaveCount(0);
  await expect(modulo(page, 'board')).toBeVisible();
  await expect(page.locator('#explorador-archivos h3 span')).toHaveText('board');
  const { project } = await (await request.get(`/api/projects/${name}`)).json();
  expect(project.boards.map((b: { id: string }) => b.id)).toEqual(['board']);
  expect((await (await request.get(`/api/projects/${name}/files/main.py`)).json()).content).toBe('primera = 1\n');
});

test('eliminar la placa principal conserva la segunda y no inventa una placa fantasma', async ({ page, request }) => {
  const name = await crearProyecto(request);
  const response = await request.post(`/api/projects/${name}/board`, { data: { board: 'esp32-c3-devkitm-1', language: 'micropython', x: 450, y: 80 } });
  expect(response.ok()).toBeTruthy();
  const result = await response.json();
  const secondId = result.boardId ?? result.project.boards.at(-1).id;
  expect((await request.put(`/api/projects/${name}/files/main.py?boardId=${secondId}`, { data: { content: 'sobrevive = True\n' } })).ok()).toBeTruthy();
  await abrir(page, name);
  // El evento externo debe consultar el proyecto antes de intentar reutilizar el id borrado.
  expect((await request.delete(`/api/projects/${name}/board?boardId=board`)).ok()).toBeTruthy();
  await expect(modulo(page, 'board')).toHaveCount(0);
  await expect(modulo(page, secondId)).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('sobrevive = True\n');
  await expect(page.locator('#explorador-archivos h3 span')).toHaveText(secondId);
  const { project } = await (await request.get(`/api/projects/${name}`)).json();
  expect(project.boards.map((b: { id: string }) => b.id)).toEqual([secondId]);
  expect(project.modules.filter((m: { id: string }) => m.id === 'board')).toHaveLength(0);
});
