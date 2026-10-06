import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test, type Page } from '@playwright/test';
import { abrirProyectoNuevo, cable, modulo, pin, seleccionarModulo } from './helpers';

// Compila con Docker (ESPHome) y corre esp-emu de verdad: tarda minutos, por eso
// solo corre con E2E_EMU=1  →  E2E_EMU=1 npx playwright test simulacion
test.skip(!process.env.E2E_EMU, 'necesita Docker + esp-emu: correr con E2E_EMU=1');

/** El dibujo "encendido" del LED (data-si="on") está visible. */
const ledPrendido = (page: Page, id: string) => modulo(page, id).locator('[data-si="on"]').first().isVisible();

test('apretar el pulsador del circuito prende el LED (firmware real en el emulador)', async ({ page, request }) => {
  test.setTimeout(8 * 60_000);
  await abrirProyectoNuevo(page, request);

  await page.locator('#ejecutar').click();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge', { timeout: 7 * 60_000 });
  await expect(page.locator('#ayuda-lienzo, #badge-alimentacion')).toHaveCount(0);
  await expect(page.locator('#badge-modo')).toBeVisible();

  expect(await ledPrendido(page, 'led1')).toBe(false);
  const boton = modulo(page, 'btn1').locator('.ctrl');
  // Con la simulación corriendo, el control brilla solo en el dibujo (si no, "no veo el botón").
  await expect(boton).not.toHaveCSS('animation-name', 'none');
  const box = (await boton.boundingBox())!;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => ledPrendido(page, 'led1'), { timeout: 10_000 }).toBe(true);
  await expect(page.locator('#lienzo .pin[data-ref="board.GPIO7"]')).toHaveClass(/alto/);
  await expect(page.locator('#consola')).toBeAttached();

  await page.mouse.up();
  await expect.poll(() => ledPrendido(page, 'led1'), { timeout: 10_000 }).toBe(false);
  await expect(pin(page, 'board.GPIO7').locator('..')).not.toHaveClass(/alto/);

  // Reset por el canal de control (antes fallaba con 400, igual que Parar).
  const [reset] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/emulator/reset')),
    page.locator('#reset').click(),
  ]);
  expect(reset.ok()).toBeTruthy();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge', { timeout: 60_000 });

  const [respuesta] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/emulator/stop')),
    page.locator('#parar').click(),
  ]);
  expect(respuesta.ok()).toBeTruthy();
  await page.locator('.consola-tabs [data-tab="emu"]').click();
  try {
    await expect(page.locator('#estado')).toHaveAttribute('data-s', 'stopped', { timeout: 15_000 });
  } finally {
    const log = await page.locator('#consola').innerText();
    console.log('--- log del emulador ---\n' + log.split('\n').slice(-15).join('\n'));
  }
});

test('el botón "Mantener presionado" del panel también prende el LED (no hace falta acertarle al dibujo chico)', async ({ page, request }) => {
  test.setTimeout(8 * 60_000);
  await abrirProyectoNuevo(page, request);
  await page.locator('#ejecutar').click();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge', { timeout: 7 * 60_000 });

  await seleccionarModulo(page, 'btn1');
  const boton = page.locator('#panel-modulo .btn-accionar');
  await expect(page.locator('#panel-modulo .insp-control')).not.toHaveClass(/deshabilitado/);
  await expect(page.locator('#panel-modulo')).toContainText('También podés tocar el dibujo');

  expect(await ledPrendido(page, 'led1')).toBe(false);
  const box = (await boton.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => ledPrendido(page, 'led1'), { timeout: 10_000 }).toBe(true);

  await page.mouse.up();
  await expect.poll(() => ledPrendido(page, 'led1'), { timeout: 10_000 }).toBe(false);

  await page.locator('#parar').click();
});

test('un agente maneja la simulación por MCP: ejecutar, apretar el botón, ver el LED y el log', async ({ page, request }) => {
  test.setTimeout(8 * 60_000);
  const nombre = await abrirProyectoNuevo(page, request);
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:5191/mcp')));
  const llamar = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 7 * 60_000 });
    return { texto: (r.content as { text: string }[]).map((c) => c.text).join('\n'), error: Boolean(r.isError) };
  };

  const ejecucion = await llamar('ejecutar', { proyecto: nombre });
  expect(ejecucion.texto).toContain('Simulación corriendo y lista');
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge');

  const log = llamar('esperar_log', { patron: 'Boton presionado', segundos: 20 });
  expect((await llamar('accionar_modulo', { id: 'btn1', accion: 'presionar' })).texto).toContain('GPIO6');
  expect((await log).texto).toContain('Boton presionado');
  await expect.poll(async () => (await llamar('leer_pines')).texto).toContain('"encendido": true');
  await expect.poll(() => ledPrendido(page, 'led1'), { timeout: 10_000 }).toBe(true); // la UI lo muestra

  await llamar('accionar_modulo', { id: 'btn1', accion: 'soltar' });
  await expect.poll(async () => (await llamar('leer_pines')).texto).toContain('"encendido": false');
  expect((await llamar('leer_log', { filtro: 'Boton' })).texto).toContain('Boton suelto');

  expect((await llamar('parar')).texto).toContain('detenido');
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'stopped');
  await client.close();
});

test('sin GND el LED no prende aunque el ESP32 ponga el pin en 1, como en la vida real', async ({ page, request }) => {
  test.setTimeout(8 * 60_000);
  const nombre = await abrirProyectoNuevo(page, request);
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:5191/mcp')));
  const llamar = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 7 * 60_000 });
    return { texto: (r.content as { text: string }[]).map((c) => c.text).join('\n'), error: Boolean(r.isError) };
  };

  // Le saca el GND al LED antes de arrancar: queda cableado a la señal pero no a tierra.
  const desconexion = await llamar('desconectar', { proyecto: nombre, desde: 'led1.GND' });
  expect(desconexion.error).toBe(false);
  await expect(cable(page, 'led1.GND', 'board.GND')).toHaveCount(0); // se ve en la UI sin recargar

  expect((await llamar('ejecutar', { proyecto: nombre })).texto).toContain('Simulación corriendo y lista');
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge');

  await llamar('accionar_modulo', { id: 'btn1', accion: 'presionar' });
  await expect.poll(async () => (await llamar('leer_log', { filtro: 'Boton' })).texto).toContain('Boton presionado');
  // El firmware (que no sabe nada de nuestro dibujo) sí puso GPIO7 en 1 de verdad.
  const pines = await llamar('leer_pines');
  expect(pines.texto).toMatch(/"7":\s*1/);
  // Pero como el LED no tiene GND cableado, no cuenta como encendido: como en la vida real.
  expect(pines.texto).toContain('"encendido": false');
  expect(pines.texto).toContain('"sinAlimentar"');
  expect(await ledPrendido(page, 'led1')).toBe(false); // tampoco se ve prendido en la UI

  await llamar('accionar_modulo', { id: 'btn1', accion: 'soltar' });
  await llamar('parar');
  await client.close();
});
