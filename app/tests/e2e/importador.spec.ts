import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import { abrirProyectoNuevo, modulo } from './helpers';

// Un módulo de ejemplo: un zumbador con su dibujo (usa data-si y un {{props}}).
const zumbador = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type,
    name: `Zumbador ${type}`,
    category: 'Salidas',
    description: 'Suena cuando el pin está en 1.',
    width: 60,
    height: 60,
    pins: [
      { name: 'SIG', x: 20, y: 60, kind: 'digital-in' },
      { name: 'GND', x: 40, y: 60, kind: 'ground' },
    ],
    bridge: { role: 'output', pin: 'SIG' },
    props: { etiqueta: { type: 'string', default: 'BZ' } },
    ...extra,
  });
const SVG_ZUMBADOR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <line x1="20" y1="48" x2="20" y2="60" stroke="#aab4be" stroke-width="2"/>
  <line x1="40" y1="48" x2="40" y2="60" stroke="#aab4be" stroke-width="2"/>
  <circle cx="30" cy="24" r="22" fill="#1b1f24" stroke="#566374"/>
  <circle data-si="on" class="zumbando" cx="30" cy="24" r="8" fill="#ffd83d"/>
  <text x="30" y="28" class="txt-mini claro" text-anchor="middle">{{props.etiqueta}}</text>
</svg>`;

const unico = () => Date.now().toString(36).slice(-5);

async function abrirImportador(page: Page, fuente: 'Carpeta' | 'Zip' | 'Chip de Wokwi' | 'URL / GitHub') {
  await page.locator('#importar-modulo').click();
  await page.locator('.imp-fuentes button', { hasText: fuente }).click();
}

test('importar una carpeta con dos módulos: aparecen en el catálogo y se pueden usar', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'emu-carpeta-'));
  const [a, b] = [`zumb-a-${unico()}`, `zumb-b-${unico()}`];
  for (const t of [a, b]) {
    mkdirSync(path.join(dir, t));
    writeFileSync(path.join(dir, t, 'module.json'), zumbador(t));
    writeFileSync(path.join(dir, t, 'module.svg'), SVG_ZUMBADOR);
  }
  await abrirImportador(page, 'Carpeta');
  await page.locator('#imp-carpeta').setInputFiles(dir);
  await page.locator('#imp-importar').click();
  await expect(page.locator('#imp-resultado .ok')).toHaveCount(2);
  await page.locator('#dlg-importar button[value="cerrar"]').click();

  const tarjeta = page.locator(`.modulo-card[data-type="${a}"]`);
  await expect(tarjeta).toBeVisible();
  await expect(tarjeta.locator('.tag-importado')).toHaveText('importado');
  await tarjeta.click();
  // Se dibuja con su SVG, con el valor de la propiedad y sin la parte "encendida".
  const m = page.locator(`#lienzo .modulo.seleccionado[data-type="${a}"]`);
  await expect(m.locator('text', { hasText: 'BZ' })).toBeVisible();
  await expect(m.locator('[data-si="on"]')).toBeHidden();
  await expect(page.locator('#panel-modulo')).toContainText('Suena cuando el pin está en 1.');
});

test('importar un zip, validarlo antes, y quitarlo del catálogo', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  const t = `zumb-zip-${unico()}`;
  const zip = zipSync({
    [`mods/${t}/module.json`]: strToU8(zumbador(t)),
    [`mods/${t}/module.svg`]: strToU8(SVG_ZUMBADOR),
  });
  await abrirImportador(page, 'Zip');
  await page.locator('#imp-zip').setInputFiles({ name: 'mods.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });

  await page.locator('#imp-validar').click();
  await expect(page.locator('#imp-resultado .ok')).toContainText(t);
  await expect(page.locator(`.modulo-card[data-type="${t}"]`)).toHaveCount(0); // validar no instala

  await page.locator('#imp-importar').click();
  await expect(page.locator(`.modulo-card[data-type="${t}"]`)).toBeVisible();
  await page.locator('#imp-importar').click(); // de nuevo: ya existe
  await expect(page.locator('#imp-resultado .error')).toContainText('reemplazar');
  await page.locator('#dlg-importar button[value="cerrar"]').click();

  // Se usa en el circuito y después se quita del catálogo: queda marcado como desconocido.
  await page.locator(`.modulo-card[data-type="${t}"]`).click();
  const id = await page.locator('#lienzo .modulo.seleccionado').getAttribute('data-id');
  page.once('dialog', (d) => d.accept());
  await page.locator(`.modulo-card[data-type="${t}"]`).hover();
  await page.locator(`.card-wrap:has(.modulo-card[data-type="${t}"]) .card-quitar`).click();
  await expect(page.locator(`.modulo-card[data-type="${t}"]`)).toHaveCount(0);
  await expect(modulo(page, id!)).toContainText(`¿${t}?`);
  await modulo(page, id!).locator('.etiqueta-modulo').click();
  await expect(page.locator('#panel-modulo')).toContainText('no está en el catálogo');
});

test('importar un chip de Wokwi con rol, en su propia categoría', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  const nombre = `Inversor ${unico()}`;
  await abrirImportador(page, 'Chip de Wokwi');
  await page.locator('#imp-chip').setInputFiles({
    name: 'inverter.chip.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ name: nombre, author: 'Wokwi', pins: ['IN', 'OUT', 'GND', 'VCC'] })),
  });
  await page.locator('#imp-rol').selectOption('output');
  await page.locator('#imp-categoria').fill('Lógica');
  await page.locator('#imp-importar').click();
  await expect(page.locator('#imp-resultado .ok')).toContainText(nombre);
  await expect(page.locator('#imp-resultado .aviso')).toContainText('no se ejecuta');
  await page.locator('#dlg-importar button[value="cerrar"]').click();
  await expect(page.locator('#lista-modulos .cat-header', { hasText: 'Lógica' })).toBeVisible();
});

test('rechaza un módulo con un SVG peligroso y explica por qué', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  const t = `malo-${unico()}`;
  const zip = zipSync({
    [`${t}/module.json`]: strToU8(zumbador(t)),
    [`${t}/module.svg`]: strToU8('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onload="x()"/></svg>'),
  });
  await abrirImportador(page, 'Zip');
  await page.locator('#imp-zip').setInputFiles({ name: 'malo.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
  await page.locator('#imp-importar').click();
  const error = page.locator('#imp-resultado .error');
  await expect(error).toContainText('elementos no permitidos: <script>');
  await expect(error).toContainText('eventos');
  await expect(page.locator(`.modulo-card[data-type="${t}"]`)).toHaveCount(0);
});

test('una URL que no es https se rechaza', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  await abrirImportador(page, 'URL / GitHub');
  await page.locator('#imp-url').fill('http://example.com/mods.zip');
  await page.locator('#imp-importar').click();
  await expect(page.locator('#imp-resultado .error')).toContainText('https');
});
