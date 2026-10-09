import { expect, test } from '@playwright/test';
import { networkInterfaces } from 'node:os';

test('el planeta abre solo el circuito compilado y permite compartir sus controles', async ({ page, request, context }) => {
  const name = `prueba-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name, language: 'micropython' } });
  const project = (await (await request.get(`/api/projects/${name}`)).json()).project;
  const catalog = (await (await request.get('/api/modules')).json()).modules;
  const types = new Set(project.modules.map(module => module.type));
  let active = true;
  let closed = false;
  const changes: unknown[] = [];
  await page.route('**/api/emulator', route => route.fulfill({ json: { status: { state: 'running', running: true }, boards: { board: { state: 'running', running: true } } } }));
  await page.route('**/api/previews', route => route.fulfill({ json: { path: '/preview.html#abcdef' } }));
  await context.route('**/api/previews/abcdef', route => route.fulfill({ json: {
    name, active, diagram: { modules: project.modules, wires: project.wires }, catalog: catalog.filter(module => types.has(module.type)),
    links: ['http://192.168.1.20:5180/preview.html#abcdef'], live: active ? { cerrados: closed ? ['btn1'] : [], electrico: { resuelto: true, leds: [], modulos: {} } } : null,
  } }));
  await context.route('**/api/previews/abcdef/controls', async route => {
    const change = route.request().postDataJSON(); changes.push(change); closed = change.cerrado;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/#${name}`);
  await expect(page.locator('#abrir-web')).toBeEnabled();
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#abrir-web').click();
  const preview = await popupPromise;
  await expect(preview).toHaveURL(/preview.html#abcdef/);
  await expect(preview.getByRole('status')).toHaveText('En vivo');
  await expect(preview.locator('#lienzo .modulo')).toHaveCount(project.modules.length);
  await expect(preview.locator('.titlebar, .stripe, #panel-codigo, #explorador-archivos')).toHaveCount(0);
  await preview.getByRole('button', { name: 'Compartir en red local' }).click();
  await expect(preview.getByRole('textbox', { name: 'Enlace compartido' })).toHaveValue('http://192.168.1.20:5180/preview.html#abcdef');
  const button = preview.locator('.modulo[data-id="btn1"] .ctrl').first();
  await button.click();
  await expect.poll(() => changes.length).toBe(2);
  expect(changes).toEqual([{ id: 'btn1', cerrado: true }, { id: 'btn1', cerrado: false }]);
  await button.hover();
  await preview.mouse.down();
  await expect.poll(() => changes.length).toBe(3);
  await preview.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => changes.length).toBe(4);
  expect(changes[3]).toEqual({ id: 'btn1', cerrado: false });
  await preview.mouse.up();
  await expect.poll(() => changes.length).toBe(5);
  await preview.screenshot({ path: '/tmp/emulador-vista-compartida.png' });
  const module = preview.locator('.modulo[data-id="board"]');
  const before = await module.getAttribute('transform');
  await module.dragTo(preview.locator('.modulo[data-id="led1"]'));
  expect(await module.getAttribute('transform')).toBe(before);
  active = false;
  await expect(preview.getByRole('status')).toContainText('terminó o cambió');
  await button.click();
  expect(changes).toHaveLength(5);
  await preview.close();
});

test('la interfaz LAN no expone el editor ni sus API', async ({ request }) => {
  const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;
  test.skip(!address, 'Sin interfaz de red local');
  const base = `http://${address}:5191`;
  expect((await request.get(base + '/')).status()).toBe(403);
  expect((await request.get(base + '/api/projects')).status()).toBe(403);
  expect((await request.post(base + '/api/previews', { data: { name: 'demo' } })).status()).toBe(403);
  expect((await request.get(base + '/preview.html')).status()).toBe(200);
  expect((await request.get(base + '/api/previews/abcdef')).status()).toBe(404);
});
