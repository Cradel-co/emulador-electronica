import { readFile } from 'node:fs/promises';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { ResultadoVistaAnalisis } from '@emu/shared';
async function abrir(page: Page, request: APIRequestContext): Promise<string> {
  const name = `e2e-termico-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, board: null, language: null } })).ok()).toBe(true);
  expect((await request.put(`/api/projects/${name}`, { data: { modules: [
    { id: 'fuente', type: 'fuente-regulable', x: 50, y: 80, props: { voltage: 5, currentLimitMa: 1000 } },
    { id: 'r', type: 'resistor', x: 260, y: 80, props: { ohms: 100 } },
  ], wires: [{ from: 'fuente.V', to: 'r.1' }, { from: 'r.2', to: 'fuente.GND' }] } })).ok()).toBe(true);
  await page.goto(`/#${name}`); await expect(page.locator('#proyecto')).toHaveValue(name);
  await page.locator('#ejecutar').click(); await expect(page.locator('body')).toHaveClass(/corriendo/);
  await page.locator('#menu-principal').click();
  await page.locator('#menu > .menu-item.sub', { hasText: /^Archivo/ }).hover();
  await page.getByRole('menuitem', { name: 'Análisis físicos…', exact: true }).click();
  const panel = page.locator('#dlg-analisis-fisicos');
  await panel.getByLabel('Tipo de análisis').selectOption('termico');
  await panel.getByRole('button', { name: 'Identificar elementos' }).click();
  await expect(panel.getByLabel('Elemento disipativo')).toContainText('r.r');
  await panel.getByLabel('Elemento disipativo').selectOption('r.r');
  return name;
}
async function configurar(page: Page): Promise<void> {
  const p = page.locator('#dlg-analisis-fisicos');
  const campos = {
    'Identificador del modelo': 'fixture-sintetico', 'Fuente de los parámetros': 'Oráculo analítico de test; parámetros inventados',
    'Condiciones de aplicación': 'Un cuerpo isotermo, ambiente constante; sin caracterización física',
    'Resistencia térmica (K/W)': '40', 'Capacidad térmica (J/K)': '0.01', 'Temperatura ambiente (°C)': '25',
    'Temperatura inicial (°C)': '25', 'Rango mínimo (°C)': '0', 'Rango máximo (°C)': '100',
    'Duración (s)': '1.2', 'Paso máximo (s)': '0.01',
  };
  for (const [label, valor] of Object.entries(campos)) await p.getByLabel(label, { exact: true }).fill(valor);
  await p.getByLabel('Inicialización', { exact: true }).selectOption('equilibrio');
}
test('temperatura y energía de una resistencia real con modelo declarado y sin cambiar el proyecto', async ({ page, request }) => {
  const name = await abrir(page, request);
  try {
    const panel = page.locator('#dlg-analisis-fisicos');
    const antes = await (await request.get(`/api/projects/${name}`)).json();
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Completá todos');
    await configurar(page);
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel).toContainText('termico-diseno');
    await expect(panel.getByLabel('Señal', { exact: true })).toHaveValue('temperatura:r.r');
    await panel.getByRole('img').scrollIntoViewIfNeeded();
    await expect(panel.getByTestId('traza-fisica')).toHaveAttribute('d', /M.*L/);
    const descarga = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Descargar análisis JSON' }).click();
    const archivo = await (await descarga).path(); if (!archivo) throw new Error('Sin descarga');
    const r: ResultadoVistaAnalisis = JSON.parse(await readFile(archivo, 'utf8'));
    if (r.dominio !== 'termico-diseno') throw new Error('Dominio térmico incorrecto');
    const resultado = r.resultado, t = resultado.termica?.['r.r'];
    if (!t) throw new Error('Falta el modelo y su resultado');
    expect(resultado.unidades.temperaturaC).toBe('°C'); expect(resultado.unidades.energia).toBe('J');
    expect(t.caracterizadoEnLaboratorio).toBe(false); expect(t.modelo.fuente).toContain('parámetros inventados');
    const ultimo = resultado.t.length - 1, fin = resultado.t[ultimo]; if (fin === undefined) throw new Error('Sin tiempo');
    const dt = fin - t.inicioS, potencia = resultado.elementos['r.r']?.p[0]; if (potencia === undefined) throw new Error('Sin potencia');
    const potencias = resultado.elementos['r.r']?.p; if (!potencias) throw new Error('Sin traza de potencia');
    // La fuente CV/CC real tiene pequeñas variaciones numéricas: encerrar la curva
    // con los oráculos analíticos de potencia mínima y máxima, sin asumir P exactamente fija.
    const respuestaConstante = (p: number) => 25 + p * 40 * (1 - Math.exp(-dt / 0.4));
    const final = t.temperaturaC[ultimo]; if (final === undefined) throw new Error('Sin temperatura final');
    expect(final).toBeGreaterThanOrEqual(respuestaConstante(Math.min(...potencias)) - 1e-9);
    expect(final).toBeLessThanOrEqual(respuestaConstante(Math.max(...potencias)) + 1e-9);
    expect(t.energiaDisipadaJ).toBeGreaterThanOrEqual(Math.min(...potencias) * dt - 1e-10);
    expect(t.energiaDisipadaJ).toBeLessThanOrEqual(Math.max(...potencias) * dt + 1e-10);
    expect(t.energiaAlmacenadaDeltaJ).toBeCloseTo(0.01 * (final - 25), 10);
    expect(t.energiaEvacuadaJ + t.energiaAlmacenadaDeltaJ).toBeCloseTo(t.energiaDisipadaJ, 6);
    expect(JSON.stringify(r)).not.toContain('wifiPassword');
    const despues = await (await request.get(`/api/projects/${name}`)).json();
    expect(despues.project).toEqual(antes.project);
    await page.screenshot({ path: '/tmp/termico-escritorio.png' });
    await page.setViewportSize({ width: 900, height: 850 });
    await panel.getByRole('img').scrollIntoViewIfNeeded(); await page.screenshot({ path: '/tmp/termico-angosto.png' });
    await panel.getByLabel('Rango máximo (°C)').fill('26');
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('fuera del dominio declarado');
    await expect(panel.getByTestId('traza-fisica')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Descargar análisis JSON' })).toHaveCount(0);
  } finally { await request.post('/api/emulator/stop'); }
});
test('editar el circuito durante cálculo térmico rechaza la respuesta tardía y obliga a identificar nuevamente', async ({ page, request }) => {
  const name = await abrir(page, request);
  try {
    await configurar(page);
    let liberar: () => void = () => {}, iniciar: () => void = () => {};
    const espera = new Promise<void>(r => { liberar = r; }), recibida = new Promise<void>(r => { iniciar = r; });
    await page.route(`**/api/projects/${name}/analysis/transient`, async route => { const response = await route.fetch(); iniciar(); await espera; await route.fulfill({ response }); });
    const panel = page.locator('#dlg-analisis-fisicos');
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click(); await recibida;
    const actual = await (await request.get(`/api/projects/${name}`)).json();
    const modules = actual.project.modules.map((m: { id: string; props: Record<string, unknown> }) => m.id === 'fuente' ? { ...m, props: { ...m.props, voltage: 7 } } : m);
    expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules, wires: actual.project.wires } })).ok()).toBe(true);
    await expect(page.locator('#lienzo')).toContainText('7 V'); liberar();
    await expect(panel.getByRole('alert')).toContainText('El proyecto cambió durante el análisis');
    await expect(panel.getByLabel('Elemento disipativo')).toHaveValue('');
    await expect(panel.getByTestId('traza-fisica')).toHaveCount(0);
    await page.unroute(`**/api/projects/${name}/analysis/transient`);
    await panel.getByRole('button', { name: 'Calcular', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Identificá de nuevo');
  } finally { await request.post('/api/emulator/stop'); }
});
