import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const escribir = async (page: Page, contenido: string) => {
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText(contenido);
};
function barrera() {
  let liberar: () => void = () => {}, inicio: () => void = () => {};
  const pausa = new Promise<void>(r => { liberar = r; }), comenzado = new Promise<void>(r => { inicio = r; });
  return { liberar, inicio, pausa, comenzado };
}

test('dos pestañas conservan el archivo local, permiten descargarlo y vuelven a comprobar un reemplazo explícito', async ({ page, context, request }) => {
  const nombre = `conflicto-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name: nombre, language: 'micropython' } });
  const ruta = `/api/projects/${nombre}/files/main.py`;
  await request.put(ruta, { data: { content: 'original = 0\n' } });
  const otra = await context.newPage(); await page.goto(`/#${nombre}`); await otra.goto(`/#${nombre}`);
  await expect(page.locator('.cm-content')).toContainText('original'); await expect(otra.locator('.cm-content')).toContainText('original');
  const b = barrera();
  await page.route(`**${ruta}`, async route => {
    if (route.request().method() === 'PUT') { b.inicio(); await b.pausa; }
    await route.continue();
  });
  try {
    await escribir(page, 'local = 1\n'); await page.keyboard.press('Control+s'); await b.comenzado;
    await escribir(otra, 'remoto = 2\n');
    const guardado = otra.waitForResponse(r => r.url().endsWith(ruta) && r.request().method() === 'PUT' && r.status() === 200);
    await otra.keyboard.press('Control+s'); await guardado;
    await expect(page.getByRole('region', { name: 'Conflicto de guardado' })).toBeVisible();
    const rechazado = page.waitForResponse(r => r.url().endsWith(ruta) && r.status() === 412);
    b.liberar(); await rechazado; await page.unroute(`**${ruta}`);
    await expect(page.locator('.cm-content')).toContainText('local = 1');
    expect((await (await request.get(ruta)).json()).content).toBe('remoto = 2\n');
    const descarga = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar mis cambios' }).click();
    const archivo = await (await descarga).path(); if (!archivo) throw new Error('No se descargó el archivo');
    expect(await readFile(archivo, 'utf8')).toBe('local = 1\n');
    await page.screenshot({ path: '/tmp/conflictos-guardado-ui.png' });
    // Un editor externo cambia el disco sin WebSocket: el panel conserva una revisión vieja.
    const proyectos = process.env.EMU_E2E_PROJECTS;
    if (!proyectos) throw new Error('Falta el directorio aislado');
    await writeFile(path.join(proyectos, nombre, 'main.py'), 'tercero = 3\n');
    const nuevoConflicto = page.waitForResponse(r => r.url().endsWith(ruta) && r.status() === 412);
    await page.getByRole('button', { name: 'Reemplazar versión guardada' }).click(); await nuevoConflicto;
    expect((await (await request.get(ruta)).json()).content).toBe('tercero = 3\n');
    await expect(page.locator('.cm-content')).toContainText('local = 1');
    const reemplazo = page.waitForResponse(r => r.url().endsWith(ruta) && r.status() === 200 && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Reemplazar versión guardada' }).click(); await reemplazo;
    await expect(page.getByRole('region', { name: 'Conflicto de guardado' })).toHaveCount(0);
    expect((await (await request.get(ruta)).json()).content).toBe('local = 1\n');
  } finally { b.liberar(); await otra.close(); }
});

test('una carga tardía de la versión guardada no pisa lo que se escribió durante la espera', async ({ page, request }) => {
  const nombre = `conflicto-tardio-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name: nombre, language: 'micropython' } });
  const ruta = `/api/projects/${nombre}/files/main.py`;
  await request.put(ruta, { data: { content: 'original = 0\n' } });
  await page.goto(`/#${nombre}`); await expect(page.locator('.cm-content')).toContainText('original');
  await escribir(page, 'local = 1\n');
  await request.put(ruta, { data: { content: 'remoto = 2\n' } });
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('button', { name: 'Cargar versión guardada' })).toBeEnabled();
  const b = barrera();
  await page.route(`**${ruta}`, async route => {
    if (route.request().method() === 'GET') { b.inicio(); await b.pausa; }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Cargar versión guardada' }).click(); await b.comenzado;
    await escribir(page, 'edicion = 4\n'); b.liberar();
    await expect(page.locator('#conflictos-guardado')).toContainText('Tus cambios locales se conservan');
    await expect(page.locator('.cm-content')).toContainText('edicion = 4');
    await page.unroute(`**${ruta}`);
    await expect(page.getByRole('button', { name: 'Cargar versión guardada' })).toBeEnabled();
    await page.getByRole('button', { name: 'Cargar versión guardada' }).click();
    await expect(page.locator('.cm-content')).toContainText('remoto = 2');
    await expect(page.getByRole('region', { name: 'Conflicto de guardado' })).toHaveCount(0);
  } finally { b.liberar(); }
});

test('un circuito editado en dos pestañas conserva el dibujo local hasta elegir la versión guardada', async ({ page, context, request }) => {
  const nombre = `conflicto-circuito-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name: nombre, board: null } });
  const ruta = `/api/projects/${nombre}/diagram`, otra = await context.newPage(), b = barrera();
  await page.goto(`/#${nombre}`); await otra.goto(`/#${nombre}`);
  await expect(page.locator('#proyecto')).toHaveValue(nombre); await expect(otra.locator('#proyecto')).toHaveValue(nombre);
  await page.route(`**${ruta}`, async route => { b.inicio(); await b.pausa; await route.continue(); });
  try {
    await page.locator('.modulo-card[data-type="relay"]').click(); await b.comenzado;
    const guardado = otra.waitForResponse(r => r.url().endsWith(ruta) && r.request().method() === 'PUT' && r.status() === 200);
    await otra.locator('.modulo-card[data-type="resistor"]').click(); await guardado;
    await expect(page.getByRole('region', { name: 'Conflicto de guardado' })).toBeVisible();
    const rechazado = page.waitForResponse(r => r.url().endsWith(ruta) && r.status() === 412);
    b.liberar(); await rechazado; await page.unroute(`**${ruta}`);
    await expect(page.locator('#lienzo .modulo[data-type="relay"]')).toHaveCount(1);
    const resumen = await (await request.get(`/api/projects/${nombre}`)).json();
    expect(resumen.project.modules.some((m: { type: string }) => m.type === 'relay')).toBe(false);
    await page.getByRole('button', { name: 'Cargar versión guardada' }).click();
    await expect(page.locator('#lienzo .modulo[data-type="relay"]')).toHaveCount(0);
    await expect.poll(() => page.locator('#lienzo .modulo').evaluateAll(nodos => nodos.map(n => n.getAttribute('data-id')).sort())).toEqual(resumen.project.modules.map((m: { id: string }) => m.id).sort());
    await expect(page.getByRole('region', { name: 'Conflicto de guardado' })).toHaveCount(0);
    await page.locator('#ir-inicio').click();
    await expect(page.locator('#pantalla-inicio')).toBeVisible();
  } finally { b.liberar(); await otra.close(); }
});

test('el keepalive al salir lleva la revisión y no pisa un circuito cambiado afuera', async ({ page, request }) => {
  const nombre = `conflicto-salida-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name: nombre, board: null } });
  await page.goto(`/#${nombre}`); await expect(page.locator('#proyecto')).toHaveValue(nombre);
  const antes = await (await request.get(`/api/projects/${nombre}`)).json();
  const proyectos = process.env.EMU_E2E_PROJECTS; if (!proyectos) throw new Error('Falta el directorio aislado');
  const nuevo = structuredClone(antes.project); nuevo.modules[0].x += 20;
  await writeFile(path.join(proyectos, nombre, 'project.json'), JSON.stringify(nuevo));
  const respuesta = page.waitForResponse(r => r.url().endsWith(`/api/projects/${nombre}/diagram`) && r.request().method() === 'PUT');
  await page.locator('.modulo-card[data-type="relay"]').click();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const envio = await respuesta;
  expect(envio.request().headers()['if-match']).toBe(antes.revisionDiagrama);
  expect(envio.status()).toBe(412);
  const actual = await (await request.get(`/api/projects/${nombre}`)).json();
  expect(actual.project.modules).toEqual(nuevo.modules);
  await expect(page.locator('#lienzo .modulo[data-type="relay"]')).toHaveCount(1);
});
