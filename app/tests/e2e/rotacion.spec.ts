import { expect, test, type Page } from '@playwright/test';
import { abrirProyectoNuevo, modulo, seleccionarModulo } from './helpers';

/**
 * Distancia en pantalla entre cada punta de los cables de un módulo y el pin al que llega:
 * si los cables no se reajustaran al girar, quedarían colgando lejos del pin.
 */
async function desfaseCables(page: Page, id: string): Promise<number> {
  return page.evaluate((id) => {
    let peor = 0;
    for (const c of document.querySelectorAll('#lienzo .cable')) {
      for (const [attr, punta] of [['data-from', 0], ['data-to', 1]] as const) {
        const ref = c.getAttribute(attr)!;
        if (!ref.startsWith(`${id}.`)) continue;
        const path = c.querySelector('.cable-linea') as SVGPathElement;
        const p = path.getPointAtLength(punta === 0 ? 0 : path.getTotalLength());
        const m = path.getScreenCTM()!;
        const x = p.x * m.a + p.y * m.c + m.e;
        const y = p.x * m.b + p.y * m.d + m.f;
        const r = document.querySelector(`#lienzo .pin[data-ref="${ref}"] .pin-punto`)!.getBoundingClientRect();
        peor = Math.max(peor, Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)));
      }
    }
    return peor;
  }, id);
}

test.describe('rotar módulos', () => {
  test('R y Shift+R giran 90°, los cables siguen pegados a los pines y queda guardado', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await seleccionarModulo(page, 'led1');
    const rotado = modulo(page, 'led1').locator(':scope > .rotado');
    await expect(rotado).toHaveAttribute('transform', /rotate\(0 /);

    await page.keyboard.press('r');
    await expect(rotado).toHaveAttribute('transform', /rotate\(90 /);
    expect(await desfaseCables(page, 'led1')).toBeLessThan(1.5);

    await page.keyboard.press('r');
    await page.keyboard.press('Shift+R');
    await expect(rotado).toHaveAttribute('transform', /rotate\(90 /);
    await expect(page.locator('#panel-modulo [data-rotacion]')).toHaveValue('90');

    await page.waitForResponse((r) => r.url().includes('/diagram') && r.ok());
    await page.reload();
    await expect(modulo(page, 'led1').locator(':scope > .rotado')).toHaveAttribute('transform', /rotate\(90 /);
    expect(await desfaseCables(page, 'led1')).toBeLessThan(1.5);
  });

  test('el asa gira a cualquier ángulo (de a 15°) y los cables se reajustan mientras se gira', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await seleccionarModulo(page, 'led1');
    const asa = modulo(page, 'led1').locator('.asa-rotar circle');
    const a = (await asa.boundingBox())!;
    const cuerpo = (await modulo(page, 'led1').locator(':scope > .rotado').boundingBox())!;
    const cx = cuerpo.x + cuerpo.width / 2;
    const cy = cuerpo.y + cuerpo.height / 2;

    // Gira el asa ~135° alrededor del centro del módulo, en varios pasos (como una mano).
    const r0 = Math.hypot(a.x + a.width / 2 - cx, a.y + a.height / 2 - cy);
    const ang0 = Math.atan2(a.y + a.height / 2 - cy, a.x + a.width / 2 - cx);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 9; i++) {
      const ang = ang0 + ((135 * Math.PI) / 180) * (i / 9);
      await page.mouse.move(cx + r0 * Math.cos(ang), cy + r0 * Math.sin(ang));
      // Mientras se gira: los cables ya están en los pines (se reajustan en vivo).
      if (i === 5) expect(await desfaseCables(page, 'led1')).toBeLessThan(1.5);
    }
    await page.mouse.up();

    const transform = (await modulo(page, 'led1').locator(':scope > .rotado').getAttribute('transform'))!;
    const grados = Number(/rotate\((\d+)/.exec(transform)![1]);
    expect(grados % 15).toBe(0);
    expect(grados).toBeGreaterThanOrEqual(120);
    expect(grados).toBeLessThanOrEqual(150);
    expect(await desfaseCables(page, 'led1')).toBeLessThan(1.5);
    await expect(page.locator('#panel-modulo [data-rotacion]')).toHaveValue(String(grados));
  });

  test('el control del panel gira a un ángulo exacto', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await seleccionarModulo(page, 'btn1');
    await page.locator('#panel-modulo [data-rotacion]').fill('37');
    await page.locator('#panel-modulo [data-rotacion]').press('Enter');
    await expect(modulo(page, 'btn1').locator(':scope > .rotado')).toHaveAttribute('transform', /rotate\(37 /);
    expect(await desfaseCables(page, 'btn1')).toBeLessThan(1.5);
  });
});
