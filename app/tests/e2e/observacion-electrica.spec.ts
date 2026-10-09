import { expect, test } from '@playwright/test';
import { abrirProyectoNuevo } from './helpers.js';
import { firmwareFixture, ledPrendido } from './fisica-fixture.js';

test('cambiar la alimentación retira la lectura anterior antes de guardar el circuito', async ({ page, request }) => {
  await firmwareFixture(page, request);
  await abrirProyectoNuevo(page, request);
  await page.locator('#usb').click();
  await expect.poll(() => ledPrendido(page, 'led1')).toBe(true);
  let liberar: () => void = () => undefined;
  const pausa = new Promise<void>(resolve => { liberar = resolve; });
  await page.route(/\/api\/projects\/[^/]+\/diagram$/, async route => {
    await pausa;
    await route.continue();
  });
  try {
    await page.locator('#usb').click();
    // El servidor aún conserva USB=true. Su medición anterior no pertenece al diagrama editado.
    await expect.poll(() => ledPrendido(page, 'led1')).toBe(false);
  } finally { liberar(); }
});

test('una observación de otro proyecto no enciende el LED del proyecto visible', async ({ page, request }) => {
  await page.route(/\/api\/projects\/[^/]+\/pins$/, async route => {
    const respuesta = await route.fetch();
    const json = await respuesta.json();
    json.electrico.contexto.proyecto = 'otro-proyecto';
    json.electrico.leds = [{ id: 'led1', mA: 10, mAFijo: 10, estado: 'ok' }];
    await route.fulfill({ response: respuesta, json });
  });
  await abrirProyectoNuevo(page, request);
  await expect(page.locator('#avisos-dibujo')).toContainText('Análisis eléctrico no válido');
  expect(await ledPrendido(page, 'led1')).toBe(false);
});
