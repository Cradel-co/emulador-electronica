import { test, expect } from '@playwright/test';
import { abrirProyectoNuevo } from './helpers.js';

/**
 * Problemas, errores de compilación y la alimentación del panel Debug. No tenían e2e: se
 * escribieron antes de migrarlos a React (#9) y contra el código imperativo.
 *
 * Compilar de verdad necesita Docker, así que los errores se inyectan como un `build.done` del
 * server, igual que los niveles de pin en render.spec.ts.
 */

async function tomarWebSocket(page: any) {
  await page.addInitScript(() => {
    const Orig = window.WebSocket;
    (window as any).WebSocket = class extends Orig {
      constructor(...a: any[]) { super(...(a as [string])); (window as any).__ws = this; }
    };
  });
}

const compilacionFallida = (page: any, errors: any[]) => page.evaluate((errors: any[]) => {
  (window as any).__ws.onmessage({ data: JSON.stringify({ type: 'build.done', ok: false, durationMs: 1200, errors }) });
}, errors);

const ERRORES = [
  { file: 'main.yaml', line: 3, message: "Unknown key 'pinn'" },
  { file: null, line: null, message: 'Falló el enlazado' },
];

test('una compilación fallida lista sus errores debajo del editor', async ({ page, request }) => {
  await tomarWebSocket(page);
  await abrirProyectoNuevo(page, request);
  await compilacionFallida(page, ERRORES);

  const avisos = page.locator('#avisos .error');
  await expect(avisos).toHaveCount(2);
  // Con archivo y línea, o solo el mensaje si el error no es de un lugar del código.
  await expect(avisos.nth(0)).toHaveText("main.yaml:3 — Unknown key 'pinn'");
  await expect(avisos.nth(1)).toHaveText('Falló el enlazado');
  // La cuenta del punto rojo dice cuántos errores hay.
  await expect(page.locator('#cuenta-problemas')).toHaveText('2');
});

test('la pestaña Problemas junta errores y avisos del circuito, y un error lleva a su línea', async ({ page, request }) => {
  await tomarWebSocket(page);
  await abrirProyectoNuevo(page, request);
  await page.keyboard.press('Alt+6');
  const problemas = page.locator('#problemas');
  await expect(problemas).toBeVisible();

  // Un proyecto recién creado no tiene alimentación (la placa nace sin USB): es un aviso del
  // circuito, no un error.
  const aviso = problemas.locator('.problema', { hasText: 'no tiene alimentación' });
  await expect(aviso).toBeVisible();
  await expect(aviso).not.toHaveClass(/error/);
  await expect(aviso.locator('.ico')).toHaveText('⚠');
  // Es del circuito entero (el server lo manda con pin -1): antes se mostraba "GPIO-1".
  await expect(aviso.locator('.donde')).toHaveText('circuito');

  // Con el USB prendido ese aviso se va. (No queda vacío: el circuito de prueba del ESP32-S3
  // lleva el LED sin resistencia, y el motor avisa que le pasan ~37 mA.)
  await page.locator('#usb').click();
  await expect(aviso).toHaveCount(0);
  await expect(problemas.locator('.problema', { hasText: 'mA' }).first()).toBeVisible();

  // Errores de compilación: arriba, marcados como error, con su lugar.
  await compilacionFallida(page, ERRORES);
  await page.keyboard.press('Alt+6'); // la compilación fallida muestra el editor: se vuelve a Problemas
  if (!(await problemas.isVisible())) await page.keyboard.press('Alt+6');
  const items = problemas.locator('.problema');
  await expect(items.filter({ hasText: 'Unknown key' })).toHaveClass(/error/);
  await expect(items.filter({ hasText: 'Unknown key' }).locator('.donde')).toHaveText('main.yaml:3');
  await expect(items.filter({ hasText: 'Unknown key' }).locator('.ico')).toHaveText('✕');

  // Un click en un error con línea lleva el cursor del editor ahí.
  await items.filter({ hasText: 'Unknown key' }).click();
  const linea = await page.locator('#editor').evaluate((t: HTMLTextAreaElement) =>
    t.value.slice(0, t.selectionStart).split('\n').length);
  expect(linea).toBe(3);
});

test('el panel Debug muestra alimentación y consumo calculados en vivo', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  await page.keyboard.press('Alt+5');
  const alim = page.locator('#dbg-alimentacion');
  await expect(alim).toBeVisible();
  // Recién creada, la placa no tiene con qué andar.
  await expect(alim.locator('.dbg-alim-placa')).toContainText('Sin alimentación');
  await expect(alim.locator('.dbg-alim-placa')).toHaveClass(/sin/);
  // Con el USB prendido, se actualiza en vivo.
  await page.locator('#usb').click();
  await expect(alim.locator('.dbg-alim-placa')).toContainText('Por USB');
  await expect(alim.locator('.dbg-alim-placa')).toHaveClass(/ok/);
  await expect(alim.locator('.dbg-alim-resumen')).toContainText('5.00 V');
  await expect(alim.locator('.dbg-alim-resumen')).toContainText('mA');
  await expect(alim.locator('.dbg-alim-resumen')).toContainText(/mW|W/);
  const componentes = alim.locator('details.dbg-mediciones').first();
  await componentes.locator('summary').click();
  await expect(componentes).toContainText('led1');
  const tensiones = alim.locator('details.dbg-mediciones').nth(1);
  await tensiones.locator('summary').click();
  await expect(tensiones).toContainText('board.GPIO7');
  // El circuito de prueba no tiene fuentes regulables.
  await expect(alim.locator('.dbg-vacio')).toHaveText('Sin fuentes regulables en el circuito.');
});

test('el panel Debug lista las fuentes regulables de un circuito sin placa', async ({ page, request }) => {
  const name = `alim-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name, board: null, language: null } });
  await page.goto(`/#${name}`);
  await page.keyboard.press('Alt+5');
  const alim = page.locator('#dbg-alimentacion');
  await expect(alim.locator('.dbg-alim-placa')).toContainText('Circuito');
  await expect(alim.locator('.dbg-alim-placa')).toContainText('apagado');
  const fila = alim.locator('table.dbg-fuentes tbody tr').first();
  await expect(fila.locator('td').first()).toHaveText('fuente1');
  await expect(fila.locator('.modo-fuente')).toHaveText('apagada');
});
