import { test, expect, type Page } from '@playwright/test';

async function abrirBanco(page: Page) {
  await page.locator('#menu-principal').click();
  await page.locator('#menu > .menu-item.sub', { hasText: /^Archivo/ }).hover();
  await page.getByRole('menuitem', { name: 'Banco de componentes propios…', exact: true }).click();
  const banco = page.locator('#dlg-banco-componentes'); await expect(banco).toBeVisible(); return banco;
}
test('banco real: parpadeo, reset, energía y representación sin esp-emu', async ({ page, request }) => {
  const errores: string[] = [], arranques: string[] = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('request', r => { if (r.method() === 'POST' && /\/(run|emulator\/reset)$/.test(new URL(r.url()).pathname)) arranques.push(r.url()); });
  const antes = await (await request.get('/api/emulator')).json();
  expect(antes.status.state).toBe('stopped');
  expect(antes.status.pid).toBeNull();
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/emulator' && r.ok()), page.goto('/')]);
  const banco = await abrirBanco(page);
  await expect(banco).toContainText('sin esp-emu');
  await banco.getByRole('button', { name: 'Iniciar / reiniciar' }).click();
  await expect(banco.getByRole('img')).toHaveAccessibleName('Esquema jerárquico con LED encendido');
  await expect(banco).toContainText('driver / equivalente');
  await banco.getByRole('button', { name: 'Avanzar 250 ms' }).click();
  await expect(banco.getByRole('img')).toHaveAccessibleName('Esquema jerárquico con LED apagado');
  await banco.getByRole('button', { name: 'Avanzar 250 ms' }).click();
  await expect(banco.getByRole('img')).toHaveAccessibleName('Esquema jerárquico con LED encendido');
  await banco.getByRole('button', { name: 'Mantener reset' }).click();
  await expect(banco.getByRole('img')).toHaveAccessibleName('Esquema jerárquico con LED apagado');
  await banco.getByRole('button', { name: 'Liberar reset' }).click();
  await expect(banco.getByRole('img')).toHaveAccessibleName('Esquema jerárquico con LED encendido');
  await banco.getByRole('button', { name: 'Cortar alimentación' }).click();
  await expect(banco.getByRole('img')).toHaveAccessibleName('Esquema jerárquico con LED apagado');
  await banco.getByRole('button', { name: 'Restaurar alimentación' }).click();
  await expect(banco.getByRole('img')).toHaveAccessibleName('Esquema jerárquico con LED encendido');
  await banco.getByLabel('Representación del driver').selectOption('completa');
  await expect(banco.getByRole('img')).toHaveAccessibleName('Esquema jerárquico con LED encendido');
  await expect(banco).not.toContainText('driver / equivalente');
  await page.screenshot({ path: '/tmp/banco-componentes-escritorio.png' });
  await page.setViewportSize({ width: 700, height: 850 });
  await page.screenshot({ path: '/tmp/banco-componentes-angosto.png' });
  expect(arranques).toEqual([]); expect(errores).toEqual([]);
  const despues = await (await request.get('/api/emulator')).json();
  expect(despues.status.state).toBe('stopped'); expect(despues.status.pid).toBeNull();
  expect(despues.running).toBeNull();
  await banco.getByRole('button', { name: 'Cerrar banco' }).click(); await expect(banco).not.toBeVisible();
});
test('abrir el banco desde un proyecto no cambia su circuito', async ({ page, request }) => {
  const name = `e2e-banco-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, board: null, language: null } })).ok()).toBe(true);
  try {
    const antes = await (await request.get(`/api/projects/${name}`)).json();
    await page.goto(`/#${name}`); await expect(page.locator('#proyecto')).toHaveValue(name);
    const banco = await abrirBanco(page);
    await banco.getByRole('button', { name: 'Iniciar / reiniciar' }).click();
    await expect(banco.getByRole('img')).toHaveAccessibleName('Esquema jerárquico con LED encendido');
    await banco.getByRole('button', { name: 'Cerrar banco' }).click();
    expect(await (await request.get(`/api/projects/${name}`)).json()).toEqual(antes);
  } finally { await request.delete(`/api/projects/${name}`); }
});
test('un fallo del banco retira las medidas anteriores y permite reiniciar', async ({ page }) => {
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/emulator' && r.ok()), page.goto('/')]);
  const banco = await abrirBanco(page);
  await banco.getByRole('button', { name: 'Iniciar / reiniciar' }).click();
  await expect(banco.getByRole('img')).toBeVisible();
  await page.route('**/api/componentes/banco-led', route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Sin solución eléctrica' }) }));
  await banco.getByRole('button', { name: 'Avanzar 250 ms' }).click();
  await expect(banco.getByRole('alert')).toHaveText('Sin solución eléctrica');
  await expect(banco.getByRole('img')).toHaveCount(0);
  await page.unroute('**/api/componentes/banco-led');
  await banco.getByRole('button', { name: 'Iniciar / reiniciar' }).click();
  await expect(banco.getByRole('img')).toHaveAccessibleName('Esquema jerárquico con LED encendido');
});
