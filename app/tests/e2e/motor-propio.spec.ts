import { expect, test, type Page } from '@playwright/test';
import { ledPrendido } from './fisica-fixture.js';

async function ajustes(page: Page) {
  await page.locator('#act-ajustes').click();
  await expect(page.locator('#dlg-ajustes')).toBeVisible();
}
test('Ejecutar corre el main.py existente en el mismo lienzo sin esp-emu, con botón, reset y stop', async ({ page, request }) => {
  const name = `e2e-propio-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, language: 'micropython' } })).ok()).toBe(true);
  const errores: string[] = []; page.on('pageerror', e => errores.push(e.message));
  try {
    await page.goto(`/#${name}`); await expect(page.locator('#proyecto')).toHaveValue(name);
    await ajustes(page);
    await page.getByLabel('Motor ESP32').selectOption('propio');
    await expect.poll(async () => (await (await request.get(`/api/projects/${name}`)).json()).project.sim.motorEsp).toBe('propio');
    await page.locator('#dlg-ajustes').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.locator('#lienzo .modulo[data-id="board"] .placa-usb').click();
    await expect(page.locator('#lienzo .modulo[data-id="board"] .placa-usb')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#ejecutar').click();
    await expect.poll(async () => (await (await request.get('/api/emulator')).json()).status).toMatchObject({ state: 'bridge', motor: 'propio', pid: null, ports: null });
    await expect(page.locator('body')).toHaveClass(/corriendo/);
    await expect.poll(async () => (await (await request.get('/api/emulator')).json()).recentLog.join('\n')).toContain('Hola desde MicroPython');
    await expect.poll(() => ledPrendido(page, 'led1')).toBe(false);
    // Un control del dibujo real alimenta el programa a través del solver, sin interceptar API o WS.
    expect((await request.post(`/api/projects/${name}/controls`, { data: { id: 'btn1', cerrado: true } })).ok()).toBe(true);
    await expect.poll(() => ledPrendido(page, 'led1')).toBe(true);
    await expect.poll(async () => (await (await request.get(`/api/projects/${name}/pins`)).json()).electrico.modulos.led1.on).toBe(true);
    await page.screenshot({ path: '/tmp/motor-propio-lienzo.png' });
    const p = (await (await request.get(`/api/projects/${name}`)).json()).project;
    expect((await request.put(`/api/projects/${name}`, { data: { sim: { ...p.sim, motorEsp: 'esp-emu' } } })).status()).toBe(409);
    // El programa activo conserva su snapshot aunque el archivo editado ya no compile.
    expect((await request.put(`/api/projects/${name}/files/main.py`, { data: { content: 'import network\n' } })).ok()).toBe(true);
    await page.locator('#reset').click();
    await expect.poll(async () => (await (await request.get('/api/emulator')).json()).status).toMatchObject({ state: 'bridge', motor: 'propio', pid: null });
    expect((await request.post(`/api/projects/${name}/controls`, { data: { id: 'btn1', cerrado: false } })).ok()).toBe(true);
    await expect.poll(() => ledPrendido(page, 'led1')).toBe(false);
    await page.locator('#parar').click();
    await expect.poll(async () => (await (await request.get('/api/emulator')).json()).status.running).toBe(false);
    await expect(page.locator('body')).not.toHaveClass(/corriendo/);
    await expect.poll(() => ledPrendido(page, 'led1')).toBe(false);
    expect(errores).toEqual([]);
  } finally { await test.info().attach('estado-motor', { body: JSON.stringify(await (await request.get('/api/emulator')).json(), null, 2), contentType: 'application/json' }); await request.post('/api/emulator/stop'); await request.delete(`/api/projects/${name}`); }
});

test('un programa no soportado falla en la pantalla actual sin iniciar otro motor', async ({ page, request }) => {
  const name = `e2e-propio-error-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, language: 'micropython' } })).ok()).toBe(true);
  try {
    const p = (await (await request.get(`/api/projects/${name}`)).json()).project;
    expect((await request.put(`/api/projects/${name}`, { data: { sim: { ...p.sim, motorEsp: 'propio' } } })).ok()).toBe(true);
    expect((await request.put(`/api/projects/${name}/files/main.py`, { data: { content: 'import network\n' } })).ok()).toBe(true);
    await page.goto(`/#${name}`); await expect(page.locator('#proyecto')).toHaveValue(name);
    await page.locator('#lienzo .modulo[data-id="board"] .placa-usb').click();
    await page.locator('#ejecutar').click();
    await expect(page.locator('#panel-build, #avisos, #problemas').filter({ hasText: /Import no soportado: import network/ }).first()).toBeVisible();
    const estado = (await (await request.get('/api/emulator')).json()).status;
    expect(estado.running).toBe(false); expect(estado.pid).toBeNull();
  } finally { await test.info().attach('estado-motor', { body: JSON.stringify(await (await request.get('/api/emulator')).json(), null, 2), contentType: 'application/json' }); await request.post('/api/emulator/stop'); await request.delete(`/api/projects/${name}`); }
});
test('cortar USB detiene el programa propio y retira su salida del lienzo', async ({ page, request }) => {
  const name = `e2e-propio-energia-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, language: 'micropython' } })).ok()).toBe(true);
  try {
    const p = (await (await request.get(`/api/projects/${name}`)).json()).project;
    expect((await request.put(`/api/projects/${name}`, { data: { sim: { ...p.sim, motorEsp: 'propio' } } })).ok()).toBe(true);
    expect((await request.put(`/api/projects/${name}/files/main.py`, { data: { content: 'from machine import Pin\nfrom time import sleep_ms\nled = Pin(7, Pin.OUT)\nwhile True:\n    led.on()\n    sleep_ms(50)\n' } })).ok()).toBe(true);
    await page.goto(`/#${name}`); await expect(page.locator('#proyecto')).toHaveValue(name);
    const usb = page.locator('#lienzo .modulo[data-id="board"] .placa-usb');
    await usb.click(); await expect(usb).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#ejecutar').click();
    await expect.poll(() => ledPrendido(page, 'led1')).toBe(true);
    await usb.click(); await expect(usb).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await (await request.get('/api/emulator')).json()).status.running).toBe(false);
    await expect.poll(() => ledPrendido(page, 'led1')).toBe(false);
    await expect(page.locator('#ejecutar')).toBeEnabled();
  } finally { await request.post('/api/emulator/stop'); await request.delete(`/api/projects/${name}`); }
});
