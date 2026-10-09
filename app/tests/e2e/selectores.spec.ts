import { test, expect } from '@playwright/test';
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { abrirProyectoNuevo, modulo } from './helpers.js';

/**
 * Los <select> que se llenan con datos del server: el selector de proyectos de la barra y los de
 * los diálogos "Nuevo proyecto" y "Agregar placa". Los de los diálogos no tenían ni un e2e: se
 * escribieron antes de migrarlos a React (#9) y contra el código imperativo.
 */

test('el selector de proyectos lista solo los nombres y cambia de proyecto', async ({ page, request }) => {
  // Por la API y no con abrirProyectoNuevo: ese helper espera el YAML de ESPHome en el editor.
  const a = `sel-mp-${Date.now().toString(36)}`;
  const b = `sel-sin-placa-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name: a, language: 'micropython' } });
  await request.post('/api/projects', { data: { name: b, board: null, language: null } });
  await page.goto(`/#${a}`);
  await expect(modulo(page, 'board')).toBeVisible();

  const s = page.locator('#proyecto');
  await expect(s).toHaveValue(a);
  await expect(page.locator('.titlebar #dispositivo, .titlebar #quitar-placa, .titlebar #config-run, .titlebar #nuevo, .titlebar #buscar-todo')).toHaveCount(0);
  await page.locator('.titlebar').screenshot({ path: '/tmp/emulador-barra-simplificada.png' });
  await expect(s.locator(`option[value="${a}"]`)).toHaveText(a);
  await expect(s.locator(`option[value="${b}"]`)).toHaveText(b);
  // La opción vacía existe pero está oculta: sin ella el <select> mostraría el primero como elegido.
  await expect(s.locator('option[value=""]')).toHaveJSProperty('hidden', true);

  await s.selectOption(b);
  await expect(page).toHaveURL(url => url.hash === `#/projects/${b}`);
});

test('"Nuevo proyecto": las placas, "sin placa", la de por defecto y las plantillas', async ({ page, request }) => {
  // La carpeta de proyectos de los e2e es temporal y nace sin plantillas: se copia una.
  const destino = path.join(process.env.EMU_E2E_PROJECTS!, '_template', 'circuito-continuo');
  if (!existsSync(destino)) {
    cpSync(path.resolve(import.meta.dirname, '../../../projects/_template/circuito-continuo'), destino, { recursive: true });
  }
  await abrirProyectoNuevo(page, request);
  await page.locator('#menu-principal').click();
  await page.locator('#menu > .menu-item').filter({ hasText: /^Archivo/ }).hover();
  await page.getByRole('menuitem', { name: 'Nuevo proyecto…', exact: true }).click();
  const dlg = page.locator('#dlg-nuevo');
  await expect(dlg).toBeVisible();

  const placa = page.locator('#nuevo-placa');
  const opciones = await placa.locator('option').allTextContents();
  expect(opciones).toContain('Sin placa (solo circuito)');
  expect(opciones.length).toBeGreaterThanOrEqual(5); // 4 placas + "sin placa"
  // La de por defecto es el ESP32-S3, no la primera de la lista (que alfabéticamente sería el Uno).
  await expect(placa).toHaveValue('esp32-s3-devkitc-1');

  // Plantillas: "Vacío" más las de projects/_template.
  const plantilla = page.locator('#nuevo-plantilla');
  await expect(plantilla.locator('option').first()).toHaveText('Vacío: botón y LED de la placa');
  await expect(plantilla.locator('option[value="circuito-continuo"]')).toBeAttached();
  // Elegir una plantilla esconde placa y lenguaje (los trae la plantilla).
  await plantilla.selectOption('circuito-continuo');
  await expect(placa.locator('xpath=ancestor::label')).toBeHidden();
  await plantilla.selectOption('');
  await expect(placa.locator('xpath=ancestor::label')).toBeVisible();

  // Recuerda la última placa elegida en la sesión.
  await placa.selectOption('esp32-c3-devkitm-1');
  await page.keyboard.press('Escape');
  await page.locator('#menu-principal').click();
  await page.locator('#menu > .menu-item').filter({ hasText: /^Archivo/ }).hover();
  await page.getByRole('menuitem', { name: 'Nuevo proyecto…', exact: true }).click();
  await expect(page.locator('#nuevo-placa')).toHaveValue('esp32-c3-devkitm-1');
});

test('"Agregar placa": las placas y los lenguajes de la elegida', async ({ page, request }) => {
  const name = `sel-agregar-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name, board: null, language: null } });
  await page.goto(`/#${name}`);
  await page.locator('#sp-agregar-placa').click();
  const dlg = page.locator('#dlg-placa');
  await expect(dlg).toBeVisible();

  const placa = page.locator('#placa-nueva');
  const lenguaje = page.locator('#placa-lenguaje');
  await expect(placa).toHaveValue('esp32-s3-devkitc-1');
  expect(await placa.locator('option').count()).toBeGreaterThanOrEqual(4);
  // El ESP32-S3 admite MicroPython y ESPHome, entre otros.
  const delS3 = await lenguaje.locator('option').allTextContents();
  expect(delS3).toEqual(expect.arrayContaining(['ESPHome', 'MicroPython']));

  // Al cambiar de placa cambian los lenguajes: el Uno solo se programa en Arduino.
  await placa.selectOption('arduino-uno');
  await expect(lenguaje.locator('option')).toHaveText(['Arduino']);
  await placa.selectOption('esp32-s3-devkitc-1');
  expect(await lenguaje.locator('option').count()).toBeGreaterThan(1);
});
