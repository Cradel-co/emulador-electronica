import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import type { ResultadoVistaAnalisis } from '@emu/shared';
async function preparar(page: Page, request: APIRequestContext) {
  const name = `e2e-ac-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, board: null, language: null } })).ok()).toBe(true);
  expect((await request.put(`/api/projects/${name}`, { data: { modules: [
    { id: 'f', type: 'fuente-regulable', x: 50, y: 80, props: { voltage: 5, currentLimitMa: 1000 } },
    { id: 'r', type: 'resistor', x: 250, y: 80, props: { ohms: 1000 } },
    { id: 'c', type: 'capacitor', x: 430, y: 80, props: { faradios: 1e-6, inicialV: 0 } },
  ], wires: [{ from: 'f.V', to: 'r.1' }, { from: 'r.2', to: 'c.1' }, { from: 'c.2', to: 'f.GND' }] } })).ok()).toBe(true);
  await page.goto(`/#${name}`); await expect(page.locator('#proyecto')).toHaveValue(name);
  await page.locator('#ejecutar').click(); await expect(page.locator('body')).toHaveClass(/corriendo/);
  await page.locator('#menu-principal').click();
  await page.locator('#menu > .menu-item.sub', { hasText: /^Archivo/ }).hover();
  await page.getByRole('menuitem', { name: 'Análisis físicos…', exact: true }).click();
  const panel = page.locator('#dlg-analisis-fisicos');
  await panel.getByLabel('Tipo de análisis').selectOption('ac');
  await panel.getByRole('button', { name: 'Identificar circuito AC' }).click();
  await expect(panel.getByLabel('Fuente AC').locator('option')).toHaveCount(2);
  await panel.getByLabel('Fuente AC').selectOption('f.salida');
  await panel.getByLabel('Entrada AC').selectOption('f.V');
  await panel.getByLabel('Salida AC').selectOption('c.1');
  const fc = 1 / (2 * Math.PI * 0.001);
  await panel.getByLabel('Frecuencia inicial (Hz)').fill(String(fc / 10));
  await panel.getByLabel('Frecuencia final (Hz)').fill(String(fc * 10));
  await panel.getByLabel('Puntos por década').fill('10');
  return { name, panel };
}
test('Bode RC con ngspice real, exportación de fasores y parámetros inválidos', async ({ page, request }) => {
  const { name, panel } = await preparar(page, request);
  try {
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel).toContainText('ac-diseno');
    await expect(panel.getByTestId('bode-ganancia')).toHaveAttribute('d', /M.*L/);
    await expect(panel.getByTestId('bode-fase')).toHaveAttribute('d', /M.*L/);
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Descargar análisis JSON' }).click();
    const path = await (await download).path(); if (!path) throw new Error('Falta descarga');
    const r = JSON.parse(await readFile(path, 'utf8')) as ResultadoVistaAnalisis;
    if (r.dominio !== 'ac-diseno') throw new Error('Dominio incorrecto');
    expect(r.proyecto).toBe(name); expect(r.resultado.frecuenciaHz).toHaveLength(21);
    expect(r.resultado.gananciaDb[10]).toBeCloseTo(-3.0103, 4);
    expect(r.resultado.faseGrados[10]).toBeCloseTo(-45, 6);
    expect(r.resultado.unidades).toEqual({ frecuencia: 'Hz', tension: 'V', transferencia: 'V/V', ganancia: 'dB', fase: '°' });
    expect(JSON.stringify(r)).not.toMatch(/wifiPassword|firmaVista/);
    await page.screenshot({ path: '/tmp/ac-escritorio.png' });
    await page.setViewportSize({ width: 900, height: 850 });
    await panel.getByRole('img', { name: 'Bode: Fase en °' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/ac-angosto.png' });
    let pedidos = 0; page.on('request', req => { if (req.url().endsWith('/analysis/ac')) pedidos++; });
    await panel.getByLabel('Frecuencia inicial (Hz)').fill('0');
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible(); expect(pedidos).toBe(0);
    await expect(panel.getByTestId('bode-ganancia')).toHaveCount(0);
  } finally { await request.post('/api/emulator/stop'); }
});
test('edición durante AC rechaza respuesta tardía y obliga a identificar de nuevo', async ({ page, request }) => {
  const { name, panel } = await preparar(page, request);
  try {
    let liberar: () => void = () => {}, iniciar: () => void = () => {};
    const espera = new Promise<void>(r => { liberar = r; }), recibida = new Promise<void>(r => { iniciar = r; });
    await page.route(`**/api/projects/${name}/analysis/ac`, async route => { const response = await route.fetch(); iniciar(); await espera; await route.fulfill({ response }); });
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click(); await recibida;
    const actual = await (await request.get(`/api/projects/${name}`)).json();
    const modules = actual.project.modules.map((m: { id: string; props: Record<string, unknown> }) => m.id === 'r' ? { ...m, props: { ...m.props, ohms: 2000 } } : m);
    expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules, wires: actual.project.wires } })).ok()).toBe(true);
    await expect(panel.getByLabel('Entrada AC')).toHaveValue(''); liberar();
    await expect(panel.getByRole('alert')).toContainText('El proyecto cambió durante el análisis');
    await expect(panel.getByTestId('bode-ganancia')).toHaveCount(0);
    await page.unroute(`**/api/projects/${name}/analysis/ac`);
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Identificá el circuito');
    await panel.getByRole('button', { name: 'Identificar circuito AC' }).click();
    await expect(panel.getByLabel('Fuente AC').locator('option')).toHaveCount(2);
    await panel.getByLabel('Fuente AC').selectOption('f.salida');
    await panel.getByLabel('Entrada AC').selectOption('f.V');
    await panel.getByLabel('Salida AC').selectOption('c.1');
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel).toContainText('ac-diseno');
    const cambiados = modules.map((m: { id: string; props: Record<string, unknown> }) => m.id === 'r' ? { ...m, props: { ...m.props, ohms: 3000 } } : m);
    await request.put(`/api/projects/${name}/diagram`, { data: { modules: cambiados, wires: actual.project.wires } });
    await expect(panel.getByRole('alert')).toContainText('El circuito cambió');
    await expect(panel.getByRole('button', { name: 'Descargar análisis JSON' })).toBeDisabled();
  } finally { await request.post('/api/emulator/stop'); }
});

test('cerrar durante AC descarta la respuesta y permite un nuevo cálculo', async ({ page, request }) => {
  const { name, panel } = await preparar(page, request);
  try {
    let liberar: () => void = () => {}, iniciar: () => void = () => {};
    const espera = new Promise<void>(r => { liberar = r; }), recibida = new Promise<void>(r => { iniciar = r; });
    await page.route(`**/api/projects/${name}/analysis/ac`, async route => {
      const response = await route.fetch(); iniciar(); await espera; await route.fulfill({ response }).catch(() => {});
    });
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click(); await recibida;
    await panel.getByRole('button', { name: 'Cerrar', exact: true }).click(); liberar();
    await expect(panel).toBeHidden(); await page.unroute(`**/api/projects/${name}/analysis/ac`);
    await page.locator('#menu-principal').click();
    await page.locator('#menu > .menu-item.sub', { hasText: /^Archivo/ }).hover();
    await page.getByRole('menuitem', { name: 'Análisis físicos…', exact: true }).click();
    await expect(panel.getByTestId('bode-ganancia')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click(); await expect(panel).toContainText('ac-diseno');
  } finally { await request.post('/api/emulator/stop'); }
});
