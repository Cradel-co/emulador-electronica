import { expect, test } from '@playwright/test';
import { abrirProyectoNuevo, modulo, seleccionarModulo } from './helpers';

/**
 * La animación de quemado se prueba sin firmware real: el veredicto eléctrico ("se-quema")
 * se inyecta en la respuesta de /pins y la simulación (puente listo + GPIO7 en alto) se
 * simula en el WebSocket. Lo que se verifica es la parte de la UI: cuándo se quema, que
 * quede muerto aunque el pin siga en alto, y que "Reemplazar LED" lo reviva.
 */
test('un LED que el motor marca "se-quema" se quema al encenderse, queda muerto y se reemplaza', async ({ page, request }) => {
  let alServidor: ((msg: object) => void) | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    alServidor = (msg) => ws.send(JSON.stringify(msg));
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
  });
  await page.route(/\/api\/projects\/[^/]+\/pins$/, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.electrico = { leds: [{ id: 'led1', mA: 96, estado: 'se-quema' }] };
    await route.fulfill({ response: res, json });
  });

  await abrirProyectoNuevo(page, request);
  await expect.poll(() => alServidor !== null).toBe(true);

  // Simulación arrancada, pero el LED todavía apagado: no se quema nada.
  alServidor!({ type: 'bridge.ready', version: 1 });
  await expect(page.locator('#badge-modo')).toBeVisible();
  await expect(modulo(page, 'led1')).not.toHaveClass(/quemado/);

  // El firmware pone GPIO7 en alto: con esa corriente, se quema.
  alServidor!({ type: 'pin.out', pin: 7, level: 1 });
  await expect(modulo(page, 'led1')).toHaveClass(/quemado/);
  await expect(modulo(page, 'led1').locator('.explosion')).toHaveCount(1);
  await expect(page.locator('#nota')).toContainText('Se quemó');
  await expect(page.locator('#nota')).toContainText('96 mA');
  await page.screenshot({ path: 'test-results/quemado-explosion.png' });

  // Pasa la explosión: queda el humo, y sigue muerto aunque el pin siga en alto.
  await expect(modulo(page, 'led1').locator('.explosion')).toHaveCount(0, { timeout: 4000 });
  await expect(modulo(page, 'led1').locator('.humo')).toHaveCount(1);
  alServidor!({ type: 'pin.out', pin: 7, level: 0 });
  alServidor!({ type: 'pin.out', pin: 7, level: 1 });
  await expect(modulo(page, 'led1')).toHaveClass(/quemado/);

  await seleccionarModulo(page, 'led1');
  await expect(page.locator('#panel-modulo .insp-badge.quemado')).toContainText('Quemado');
  await page.screenshot({ path: 'test-results/quemado-humo.png' });
  await page.locator('#insp-reemplazar').click();
  await expect(modulo(page, 'led1')).not.toHaveClass(/quemado/);
});
