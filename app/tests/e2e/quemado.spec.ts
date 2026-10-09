import { expect, test } from '@playwright/test';
import { abrirProyectoNuevo, modulo, seleccionarModulo } from './helpers.js';
import { firmwareFixture, ledPrendido } from './fisica-fixture.js';

test('el riesgo de sobrecorriente no provoca daño permanente y desaparece al apagar', async ({ page, request }) => {
  const firmware = await firmwareFixture(page, request);
  await abrirProyectoNuevo(page, request);
  await page.locator('#lienzo .modulo[data-id="board"] .placa-usb').click();
  await expect.poll(() => ledPrendido(page, 'led1')).toBe(true);
  await seleccionarModulo(page, 'led1');
  await expect(page.locator('#panel-modulo')).toContainText('Riesgo de sobrecorriente');
  await expect(modulo(page, 'led1')).not.toHaveClass(/quemado/);
  await expect(modulo(page, 'led1').locator('.explosion, .humo')).toHaveCount(0);
  await expect(page.locator('#insp-reemplazar')).toHaveCount(0);
  await firmware.ponerNivel(0);
  await expect.poll(() => ledPrendido(page, 'led1')).toBe(false);
  await expect(page.locator('#panel-modulo')).not.toContainText('Riesgo de sobrecorriente');
  await firmware.ponerNivel(1);
  await expect.poll(() => ledPrendido(page, 'led1')).toBe(true);
  await expect(page.locator('#panel-modulo')).toContainText('Riesgo de sobrecorriente');
  await expect(modulo(page, 'led1')).not.toHaveClass(/quemado/);
});
