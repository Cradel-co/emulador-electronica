import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { abrirProyectoNuevo } from './helpers.js';
import type { InformePrototipo } from '@emu/shared';

async function solicitar(page: Page): Promise<void> {
  await page.locator('#menu-principal').click();
  await page.locator('#menu > .menu-item.sub', { hasText: /^Archivo/ }).hover();
  await page.getByRole('menuitem', { name: 'Informe del prototipo…', exact: true }).click();
}
async function textoDescarga(page: Page, boton: string): Promise<string> {
  const espera = page.waitForEvent('download');
  await page.getByRole('button', { name: boton, exact: true }).click();
  const descarga = await espera, archivo = await descarga.path();
  if (!archivo) throw new Error('Descarga sin archivo');
  return readFile(archivo, 'utf8');
}
test('guarda el circuito pendiente y descarga JSON y HTML de la misma instantánea', async ({ page, request }) => {
  const nombre = await abrirProyectoNuevo(page, request);
  const inicial = await (await request.get(`/api/projects/${nombre}`)).json();
  const resistenciasIniciales = inicial.project.modules.filter((m: { type: string }) => m.type === 'resistor').length;
  await page.locator('.modulo-card[data-type="resistor"]').click();
  await solicitar(page);
  const dialogo = page.locator('#dlg-informe-prototipo');
  await expect(dialogo).toBeVisible();
  await expect(dialogo).toContainText('instantanea-dc');
  const i: InformePrototipo = JSON.parse(await textoDescarga(page, 'Descargar JSON'));
  expect(i.proyecto).toBe(nombre); expect(i.circuito.modules.filter(m => m.type === 'resistor').length).toBe(resistenciasIniciales + 1);
  const persistido = await (await request.get(`/api/projects/${nombre}`)).json();
  expect(i.revisionProyecto).toBe(persistido.revision);
  expect(i.circuito.wires).toEqual(persistido.project.wires);
  const html = await textoDescarga(page, 'Descargar HTML');
  expect(html).toContain(i.fechaUtc); expect(html).toContain('Corriente (mA)'); expect(html).toContain(nombre);
  await page.screenshot({ path: '/tmp/informe-prototipo-ui.png' });
  await dialogo.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(dialogo).toBeHidden();
  const vista = await page.context().newPage();
  await vista.setContent(html);
  await expect(vista.getByRole('heading', { name: 'Conexiones', exact: true })).toBeVisible();
  await expect(vista.getByRole('heading', { name: 'Medidas', exact: true })).toBeVisible();
  await vista.screenshot({ path: '/tmp/informe-prototipo-html.png', fullPage: true });
  await vista.close();
});
test('una edición durante la captura impide aplicar la respuesta tardía', async ({ page, request }) => {
  const nombre = await abrirProyectoNuevo(page, request);
  let liberar: () => void = () => {}, iniciar: () => void = () => {};
  const espera = new Promise<void>(r => { liberar = r; });
  const recibida = new Promise<void>(r => { iniciar = r; });
  await page.route(`**/api/projects/${nombre}/report`, async route => {
    const respuesta = await route.fetch(); iniciar(); await espera; await route.fulfill({ response: respuesta });
  });
  await solicitar(page); await recibida;
  await page.locator('.modulo-card[data-type="resistor"]').click();
  liberar();
  await expect(page.locator('#dlg-informe-prototipo')).toBeHidden();
  await expect(page.locator('body')).toContainText('El proyecto cambió durante la captura');
  await solicitar(page);
  await expect(page.locator('#dlg-informe-prototipo')).toBeVisible();
});
test('la vista previa distingue una observación no resuelta de medidas de cero', async ({ page, request }) => {
  const nombre = await abrirProyectoNuevo(page, request);
  await page.route(`**/api/projects/${nombre}/report`, async route => {
    const respuesta = await route.fetch(); const i: InformePrototipo = await respuesta.json();
    i.observacion.estado = 'no-resuelta'; i.observacion.resuelto = false; i.observacion.mediciones = []; i.observacion.tensiones = {};
    await route.fulfill({ response: respuesta, json: i });
  });
  await solicitar(page);
  const dialogo = page.locator('#dlg-informe-prototipo');
  await expect(dialogo).toBeVisible(); await expect(dialogo).toContainText('no-resuelta');
  await expect(dialogo).toContainText('No hay medidas disponibles');
  await expect(dialogo.locator('tbody tr')).toHaveCount(0);
});
