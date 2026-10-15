import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import type { ResultadoVistaAnalisis } from '@emu/shared';

async function circuitoRc(page: Page, request: APIRequestContext): Promise<string> {
  const name = `e2e-fisica-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, board: null, language: null } })).ok()).toBe(true);
  expect((await request.put(`/api/projects/${name}`, { data: {
    modules: [
      { id: 'fuente', type: 'fuente-regulable', x: 50, y: 80, props: { voltage: 5, currentLimitMa: 1000 } },
      { id: 'r', type: 'resistor', x: 250, y: 80, props: { ohms: 1000 } },
      { id: 'c', type: 'capacitor', x: 430, y: 80, props: { faradios: 1e-6, inicialV: 0 } },
    ], wires: [{ from: 'fuente.V', to: 'r.1' }, { from: 'r.2', to: 'c.1' }, { from: 'c.2', to: 'fuente.GND' }],
  } })).ok()).toBe(true);
  await page.goto(`/#${name}`);
  await expect(page.locator('#proyecto')).toHaveValue(name);
  await page.locator('#ejecutar').click();
  await expect(page.locator('body')).toHaveClass(/corriendo/);
  await page.locator('#menu-principal').click();
  await page.locator('#menu > .menu-item.sub', { hasText: /^Archivo/ }).hover();
  await page.getByRole('menuitem', { name: 'Análisis físicos…', exact: true }).click();
  return name;
}
async function descargar(page: Page): Promise<ResultadoVistaAnalisis> {
  const descarga = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar análisis JSON' }).click();
  const p = await (await descarga).path(); if (!p) throw new Error('Falta archivo descargado');
  return JSON.parse(await readFile(p, 'utf8'));
}
test('DC y transitorio RC calculados por ngspice y descarga completa con unidades', async ({ page, request }) => {
  const name = await circuitoRc(page, request);
  try {
    const panel = page.locator('#dlg-analisis-fisicos');
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel).toContainText('instantanea-dc');
    const dc = await descargar(page);
    expect(dc.dominio).toBe('instantanea-dc');
    expect(JSON.stringify(dc)).not.toContain('wifiPassword'); expect(JSON.stringify(dc)).not.toContain('firmaVista');
    if (dc.dominio !== 'instantanea-dc') throw new Error('Dominio DC incorrecto');
    expect(dc.resultado.observacion.resuelto).toBe(true);
    const capacitor = dc.resultado.observacion.mediciones.find(m => m.modulo === 'c');
    expect(capacitor?.tensionV).toBeCloseTo(5, 2);
    await panel.getByLabel('Tipo de análisis').selectOption('transitorio');
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel).toContainText('transitorio-diseno');
    await panel.getByLabel('Señal', { exact: true }).selectOption('v:c.c');
    await expect(panel.getByTestId('traza-fisica')).toHaveAttribute('d', /M.*L/);
    const r = await descargar(page);
    if (r.dominio !== 'transitorio-diseno') throw new Error('Dominio temporal incorrecto');
    expect(r.proyecto).toBe(name); expect(r.resultado.unidades).toEqual({ t: 's', v: 'V', i: 'A', p: 'W' });
    const ultimo = r.resultado.t.length - 1;
    expect(r.resultado.elementos['c.c']?.v[ultimo]).toBeCloseTo(5 * (1 - Math.exp(-5)), 2);
    expect(r.resultado.elementos['c.c']?.v[0]).toBeCloseTo(0, 2);
    await page.screenshot({ path: '/tmp/analisis-fisicos-escritorio.png' });
    await page.setViewportSize({ width: 900, height: 850 });
    await expect(panel.getByRole('img')).toBeVisible();
    await page.screenshot({ path: '/tmp/analisis-fisicos-angosto.png' });
    // Cambiar un parámetro retira la curva y su exportación; petición inválida no sale de la UI.
    let pedidos = 0;
    page.on('request', req => { if (req.url().endsWith('/analysis/transient')) pedidos++; });
    await panel.getByLabel('Paso máximo (s)').fill('0');
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    expect(pedidos).toBe(0); await expect(panel.getByTestId('traza-fisica')).toHaveCount(0);
  } finally { await request.post('/api/emulator/stop'); }
});
test('cerrar durante el cálculo descarta la respuesta; nueva captura funciona', async ({ page, request }) => {
  const name = await circuitoRc(page, request);
  try {
    let liberar: () => void = () => {}, iniciar: () => void = () => {};
    const espera = new Promise<void>(r => { liberar = r; }), recibida = new Promise<void>(r => { iniciar = r; });
    await page.route(`**/api/projects/${name}/report`, async route => {
      const response = await route.fetch(); iniciar(); await espera;
      await route.fulfill({ response }).catch(() => {});
    });
    const panel = page.locator('#dlg-analisis-fisicos');
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click(); await recibida;
    await panel.getByRole('button', { name: 'Cerrar', exact: true }).click(); liberar();
    await expect(panel).toBeHidden();
    await page.unroute(`**/api/projects/${name}/report`);
    await page.locator('#menu-principal').click();
    await page.locator('#menu > .menu-item.sub', { hasText: /^Archivo/ }).hover();
    await page.getByRole('menuitem', { name: 'Análisis físicos…', exact: true }).click();
    await expect(panel).not.toContainText('instantanea-dc');
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel).toContainText('instantanea-dc');
  } finally { await request.post('/api/emulator/stop'); }
});
test('una edición durante el transitorio impide publicar la respuesta tardía', async ({ page, request }) => {
  const name = await circuitoRc(page, request);
  try {
    let liberar: () => void = () => {}, iniciar: () => void = () => {};
    const espera = new Promise<void>(r => { liberar = r; }), recibida = new Promise<void>(r => { iniciar = r; });
    await page.route(`**/api/projects/${name}/analysis/transient`, async route => {
      const response = await route.fetch(); iniciar(); await espera; await route.fulfill({ response });
    });
    const panel = page.locator('#dlg-analisis-fisicos');
    await panel.getByLabel('Tipo de análisis').selectOption('transitorio');
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click(); await recibida;
    // La API emite la actualización al editor por WebSocket aunque el diálogo esté abierto.
    const actual = await (await request.get(`/api/projects/${name}`)).json();
    const modules = actual.project.modules.map((m: { id: string; props: Record<string, unknown> }) => m.id === 'fuente' ? { ...m, props: { ...m.props, voltage: 7 } } : m);
    expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules, wires: actual.project.wires } })).ok()).toBe(true);
    await expect(page.locator('#lienzo')).toContainText('7 V');
    liberar();
    await expect(panel.getByRole('alert')).toContainText('El proyecto cambió durante el análisis');
    await expect(panel.getByTestId('traza-fisica')).toHaveCount(0);
    await page.unroute(`**/api/projects/${name}/analysis/transient`);
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel).toContainText('transitorio-diseno');
    const cambiados = modules.map((m: { id: string; props: Record<string, unknown> }) => m.id === 'fuente' ? { ...m, props: { ...m.props, voltage: 9 } } : m);
    expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules: cambiados, wires: actual.project.wires } })).ok()).toBe(true);
    await expect(panel.getByRole('alert')).toContainText('El circuito cambió');
    await expect(panel.getByRole('button', { name: 'Descargar análisis JSON' })).toBeDisabled();
  } finally { await request.post('/api/emulator/stop'); }
});
