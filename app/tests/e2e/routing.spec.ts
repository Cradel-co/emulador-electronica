import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { seleccionarModulo } from './helpers.js';

let serial = 0;
const principal = 'primera = 1\n';

async function crearProyecto(request: APIRequestContext) {
  const name = `routing-${Date.now().toString(36)}-${serial++}`;
  expect((await request.post('/api/projects', { data: { name, language: 'micropython' } })).ok()).toBeTruthy();
  await escribirArchivo(request, name, 'main.py', principal);
  return name;
}

async function escribirArchivo(request: APIRequestContext, name: string, file: string, content: string, board = 'board') {
  expect((await request.put(`/api/projects/${name}/files/${file}?boardId=${encodeURIComponent(board)}`, { data: { content } })).ok()).toBeTruthy();
}

async function segundaPlaca(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post(`/api/projects/${name}/board`, { data: { board: 'esp32-c3-devkitm-1', language: 'micropython', x: 450, y: 80 } });
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  const id: string | undefined = data.boardId ?? data.project.boards.find((board: { id: string }) => board.id !== 'board')?.id;
  if (!id) throw new Error('La API no devolvió la segunda placa');
  await escribirArchivo(request, name, 'main.py', 'segunda = 2\n', id);
  return id;
}

function ruta(name: string, board = 'board', file = 'main.py') {
  return `/#/projects/${encodeURIComponent(name)}?${new URLSearchParams({ board, file })}`;
}

async function esperarContexto(page: Page, name: string, board = 'board', file = 'main.py') {
  await expect(page.locator('#proyecto')).toHaveValue(name);
  await expect(page.locator('#tabs-archivos button.activa')).toHaveText(file);
  // Comparar parámetros independientemente del orden/escape que elija el adaptador.
  await expect.poll(() => {
    const hash = new URL(page.url()).hash.slice(1);
    const url = new URL(hash || '/', 'http://route.local');
    return { path: url.pathname, board: url.searchParams.get('board'), file: url.searchParams.get('file') };
  }).toEqual({ path: `/projects/${encodeURIComponent(name)}`, board, file });
}

async function abrirExplorador(page: Page) {
  const toggle = page.locator('#tw-explorador');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(page.locator('#explorador-archivos')).toBeVisible();
}

async function editar(page: Page, content: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(content);
  await expect(page.locator('#editor')).toHaveValue(content);
}

async function esperarInicio(page: Page) {
  await expect(page.locator('body')).toHaveClass(/\binicio\b/);
  await expect(page.locator('#pantalla-inicio')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toMatch(/^(?:#\/?)?$/);
}

test('la navegación de proyectos conserva el historial y permite volver a Inicio', async ({ page, request }) => {
  const first = await crearProyecto(request);
  const second = await crearProyecto(request);
  await page.goto('/');
  await esperarInicio(page);
  await page.locator('.proyecto-abrir').filter({ has: page.locator('.nombre', { hasText: first }) }).click();
  await esperarContexto(page, first);
  await page.locator('#proyecto').selectOption(second);
  await esperarContexto(page, second);
  await page.goBack();
  await esperarContexto(page, first);
  await page.goForward();
  await esperarContexto(page, second);
  await page.locator('#ir-inicio').click();
  await esperarInicio(page);
  await page.goBack();
  await esperarContexto(page, second);
});

test('una ruta de proyecto sin parámetros completa la placa y el archivo principal', async ({ page, request }) => {
  const name = await crearProyecto(request);
  await page.goto(`/#/projects/${encodeURIComponent(name)}`);
  await esperarContexto(page, name);
  await expect(page.locator('#editor')).toHaveValue(principal);
  await page.reload();
  await esperarContexto(page, name);
});

test('un enlace directo restaura placa y archivo anidado después de recargar', async ({ page, request }) => {
  const name = await crearProyecto(request);
  const board = await segundaPlaca(request, name);
  const file = 'sensores/temperatura.py';
  await escribirArchivo(request, name, file, 'temperatura = 24\n', board);
  await page.goto(ruta(name, board, file));
  await esperarContexto(page, name, board, file);
  await expect(page.locator('#editor')).toHaveValue('temperatura = 24\n');
  await page.reload();
  await esperarContexto(page, name, board, file);
  await expect(page.locator('#editor')).toHaveValue('temperatura = 24\n');
  await abrirExplorador(page);
  await expect(page.locator('#explorador-archivos .file-explorer-tree')).toHaveAttribute('data-board-id', board);
});

test('explorador, pestañas y circuito sincronizan URL sin remontar editor ni lienzo', async ({ page, request }) => {
  const name = await crearProyecto(request);
  const board = await segundaPlaca(request, name);
  const file = 'lib/valor.py';
  await escribirArchivo(request, name, file, 'valor = 42\n', board);
  await page.goto(ruta(name));
  await esperarContexto(page, name);
  await abrirExplorador(page);
  const editor = await page.locator('.cm-editor').elementHandle();
  const canvas = await page.locator('#lienzo').elementHandle();
  if (!editor || !canvas) throw new Error('Faltan los contenedores persistentes');
  const secondary = page.locator(`#explorador-archivos .explorer-board[data-board-id="${board}"]`);
  await secondary.locator('.explorer-board-root > summary').click();
  await esperarContexto(page, name);
  await secondary.locator(`button[title="${file}"]`).click();
  await esperarContexto(page, name, board, file);
  await expect(page.locator('#editor')).toHaveValue('valor = 42\n');
  await page.locator('#tabs-archivos button').filter({ hasText: /^main\.py$/ }).click();
  await esperarContexto(page, name, board);
  await seleccionarModulo(page, 'board');
  await esperarContexto(page, name);
  await page.goBack();
  await esperarContexto(page, name, board);
  expect(await editor.evaluate(node => node.isConnected)).toBe(true);
  expect(await canvas.evaluate(node => node.isConnected)).toBe(true);
});

test('los enlaces legacy se canonicalizan y los hashes malformados no rompen la aplicación', async ({ page, request }) => {
  const name = await crearProyecto(request);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/#${name}`);
  await esperarContexto(page, name);
  await page.goto('/#%E0%A4%A');
  await esperarInicio(page);
  await page.locator('.proyecto-abrir').filter({ has: page.locator('.nombre', { hasText: name }) }).click();
  await esperarContexto(page, name);
  expect(errors).toEqual([]);
});

test('destinos inexistentes se normalizan al contexto que realmente se muestra', async ({ page, request }) => {
  const name = await crearProyecto(request);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ruta(name, 'placa-inexistente', 'perdido.py'));
  await esperarContexto(page, name);
  await expect(page.locator('#editor')).toHaveValue(principal);
  await page.goto(ruta(name, 'board', 'carpeta/perdido.py'));
  await esperarContexto(page, name);
  await expect(page.locator('#editor')).toHaveValue(principal);
  // También debe recuperarse de una URL inválida durante una sesión ya iniciada.
  await page.evaluate(() => { window.location.hash = '/projects/proyecto-inexistente?board=board&file=main.py'; });
  await esperarInicio(page);
  expect(errors).toEqual([]);
});

test('un error de guardado bloquea la navegación desde la interfaz y conserva los cambios', async ({ page, request }) => {
  const name = await crearProyecto(request);
  await escribirArchivo(request, name, 'otro.py', 'otro = 2\n');
  await page.goto(ruta(name));
  await esperarContexto(page, name);
  await abrirExplorador(page);
  await page.route(`**/api/projects/${name}/files/**`, async route => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 500, json: { error: 'fallo de guardado de prueba' } });
    else await route.continue();
  });
  await editar(page, 'pendiente = 99\n');
  const failed = page.waitForResponse(response => response.request().method() === 'PUT' && response.status() === 500);
  await page.locator('#explorador-archivos button[title="otro.py"]').click();
  await failed;
  await esperarContexto(page, name);
  await expect(page.locator('#editor')).toHaveValue('pendiente = 99\n');
  const failedHome = page.waitForResponse(response => response.request().method() === 'PUT' && response.status() === 500);
  await page.locator('#ir-inicio').click();
  await failedHome;
  await esperarContexto(page, name);
  await expect(page.locator('body')).not.toHaveClass(/\binicio\b/);
});

test('Atrás con guardado fallido restaura la URL y permite reintentar cuando se recupera', async ({ page, request }) => {
  const name = await crearProyecto(request);
  await escribirArchivo(request, name, 'otro.py', 'otro = 2\n');
  await page.goto(ruta(name));
  await esperarContexto(page, name);
  await abrirExplorador(page);
  await page.locator('#explorador-archivos button[title="otro.py"]').click();
  await esperarContexto(page, name, 'board', 'otro.py');
  let fail = true;
  await page.route(`**/api/projects/${name}/files/**`, async route => {
    if (fail && route.request().method() === 'PUT') await route.fulfill({ status: 500, json: { error: 'fallo de guardado de prueba' } });
    else await route.continue();
  });
  await editar(page, 'pendiente = 77\n');
  const failed = page.waitForResponse(response => response.request().method() === 'PUT' && response.status() === 500);
  await page.goBack();
  await failed;
  await esperarContexto(page, name, 'board', 'otro.py');
  await expect(page.locator('#editor')).toHaveValue('pendiente = 77\n');
  fail = false;
  await page.goBack();
  await esperarContexto(page, name);
  await expect.poll(async () => (await (await request.get(`/api/projects/${name}/files/otro.py`)).json()).content).toBe('pendiente = 77\n');
});

test('escribir durante el guardado al salir a Inicio mantiene la versión nueva y su contexto', async ({ page, request }) => {
  const name = await crearProyecto(request);
  await page.goto(ruta(name));
  await esperarContexto(page, name);
  let avisarGuardado: () => void = () => {};
  let liberarGuardado: () => void = () => {};
  const guardadoEmpezado = new Promise<void>(resolve => { avisarGuardado = resolve; });
  const permisoRespuesta = new Promise<void>(resolve => { liberarGuardado = resolve; });
  let bloquearPrimero = true;
  await page.route(`**/api/projects/${name}/files/**`, async route => {
    if (route.request().method() === 'PUT' && bloquearPrimero) {
      bloquearPrimero = false;
      avisarGuardado();
      await permisoRespuesta;
    }
    await route.continue();
  });
  await editar(page, 'version = 10\n');
  await page.locator('#ir-inicio').click();
  await guardadoEmpezado;
  // El usuario sigue trabajando mientras el servidor recibe la versión anterior.
  await editar(page, 'version = 20\n');
  const guardadoTerminado = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes(`/api/projects/${name}/files/`));
  liberarGuardado();
  await guardadoTerminado;
  await expect(page.locator('#nota')).toContainText('Hubo cambios durante el guardado');
  await esperarContexto(page, name);
  await expect(page.locator('body')).not.toHaveClass(/\binicio\b/);
  await expect(page.locator('#editor')).toHaveValue('version = 20\n');
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await (await request.get(`/api/projects/${name}/files/main.py`)).json()).content).toBe('version = 20\n');
});


test('un fallo al cargar código o explorador mantiene la URL sincronizada con el contexto visible', async ({ page, request }) => {
  const first = await crearProyecto(request);
  const second = await crearProyecto(request);
  await escribirArchivo(request, second, 'main.py', 'segunda = 22\n');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ruta(first));
  await esperarContexto(page, first);
  let failCode = true;
  await page.route(`**/api/projects/${second}/files/**`, async route => {
    if (failCode && route.request().method() === 'GET') {
      await route.fulfill({ status: 500, json: { error: 'fallo de carga de código' } });
    } else await route.continue();
  });
  const failedCode = page.waitForResponse(response => response.status() === 500 && response.url().includes(`/api/projects/${second}/files/`));
  await page.locator('#proyecto').selectOption(second);
  await failedCode;
  await expect(page.locator('#nota')).toContainText('fallo de carga de código');
  await esperarContexto(page, first);
  await expect(page.locator('#editor')).toHaveValue(principal);
  failCode = false;
  await page.route(`**/api/projects/${second}/explorer`, route => route.fulfill({ status: 500, json: { error: 'fallo de carga del explorador' } }));
  const failedExplorer = page.waitForResponse(response => response.status() === 500 && response.url().endsWith(`/api/projects/${second}/explorer`));
  await page.locator('#proyecto').selectOption(second);
  await failedExplorer;
  await esperarContexto(page, second);
  await expect(page.locator('#editor')).toHaveValue('segunda = 22\n');
  expect(errors).toEqual([]);
});


test('Aprender tiene ruta propia, conserva la página al recargar y permite volver a Proyectos', async ({ page }) => {
  await page.goto('/');
  await esperarInicio(page);
  await page.getByRole('button', { name: 'Aprender', exact: true }).click();
  await expect(page).toHaveURL(/#\/aprender$/);
  await expect(page.getByRole('heading', { name: 'Aprender', exact: true })).toBeVisible();
  await expect(page.locator('#bienvenida-acerca')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#inicio-proyectos')).toBeHidden();
  await expect(page.locator('#dlg-acerca')).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Aprender', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Proyectos', exact: true }).click();
  await esperarInicio(page);
  await expect(page.locator('#inicio-proyectos')).toBeVisible();
  await expect(page.locator('#bienvenida-proyectos')).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Aprender', exact: true })).toBeVisible();
  await page.goForward();
  await esperarInicio(page);
});


test('el layout de aprendizaje permite buscar temas y explorar recorridos', async ({ page }) => {
  await page.goto('/#/aprender');
  await expect(page.getByRole('heading', { name: 'Todos los temas', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Buscar temas y rutas' }).fill('ESP32');
  await expect(page.locator('.aprender-tema')).toHaveCount(1);
  await page.locator('.aprender-tema').click();
  await expect(page).toHaveURL(/#\/aprender\/temas\/esp32$/);
  await expect(page.getByRole('heading', { name: 'ESP32', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Rutas de aprendizaje', exact: true }).click();
  await page.getByRole('textbox', { name: 'Buscar temas y rutas' }).fill('');
  await page.getByRole('link', { name: /RUTA DE APRENDIZAJE Tu primer circuito/ }).click();
  await expect(page).toHaveURL(/#\/aprender\/rutas\/primer-circuito$/);
  await expect(page.getByRole('heading', { name: 'Tu recorrido', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Tu primer circuito', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 600, height: 850 });
  await expect(page.locator('#pagina-aprender')).toBeVisible();
  expect(await page.locator('#pagina-aprender').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(480);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
