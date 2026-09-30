import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

let contador = 0;

/** Crea un proyecto por la API (con el circuito por defecto) y lo abre en la UI. */
export async function abrirProyectoNuevo(page: Page, request: APIRequestContext, language = 'esphome'): Promise<string> {
  const name = `e2e-${Date.now().toString(36)}-${contador++}`;
  const res = await request.post('/api/projects', { data: { name, language } });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await expect(page.locator('#proyecto')).toHaveValue(name);
  await expect(page.locator('#editor')).toHaveValue(new RegExp(`name: ${name}`));
  await expect(modulo(page, 'board')).toBeVisible();
  return name;
}

export const modulo = (page: Page, id: string) => page.locator(`#lienzo .modulo[data-id="${id}"]`);

/**
 * Caja en pantalla de un elemento del circuito. El canvas se redibuja entero cuando llegan
 * los avisos del servidor: si se mide justo en ese instante, el nodo viejo ya no está y
 * boundingBox() da null. Se reintenta hasta tener una medida.
 */
export async function caja(loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let box: { x: number; y: number; width: number; height: number } | null = null;
  await expect.poll(async () => (box = await loc.boundingBox()) !== null, { timeout: 5000 }).toBe(true);
  return box!;
}
export const pin = (page: Page, ref: string) => page.locator(`#lienzo .pin[data-ref="${ref}"] .pin-hit`);
export const cable = (page: Page, from: string, to: string) =>
  page.locator(`#lienzo .cable[data-from="${from}"][data-to="${to}"]`);

/** Selecciona un módulo haciendo click en su etiqueta (no en sus controles). */
export async function seleccionarModulo(page: Page, id: string): Promise<void> {
  await modulo(page, id).locator('.etiqueta-modulo').click();
}

/** Click en dos pines: así se cablea. */
export async function cablear(page: Page, a: string, b: string): Promise<void> {
  await pin(page, a).click();
  await pin(page, b).click();
}

/** Punto de pantalla en la mitad de un cable (los cables son curvas: el centro del bbox no cae sobre la línea). */
export async function mitadDeCable(page: Page, from: string, to: string): Promise<{ x: number; y: number }> {
  return cable(page, from, to).locator('.cable-hit').evaluate((el) => {
    const path = el as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
  });
}

/** Mueve un módulo arrastrándolo por su etiqueta. */
export async function arrastrarModulo(page: Page, id: string, dx: number, dy: number): Promise<void> {
  const box = await caja(modulo(page, id).locator('.etiqueta-modulo'));
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}
