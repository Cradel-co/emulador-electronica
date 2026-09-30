import { expect, test, type Page } from '@playwright/test';

// Compila un sketch real para el Arduino Uno (arduino-cli en Docker) y lo depura en avr8js:
// correr con E2E_EMU=1  →  E2E_EMU=1 npx playwright test depuracion
test.skip(!process.env.E2E_EMU, 'necesita Docker + arduino-cli: correr con E2E_EMU=1');

const SKETCH = `#include <Arduino.h>

// Sketch de prueba del depurador: un contador global y el LED en D13.
volatile unsigned long contador = 0;
int estadoLed = 0;

void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT_PULLUP);
  pinMode(13, OUTPUT);
}

void loop() {
  contador = contador + 1;
  estadoLed = digitalRead(2) == LOW;
  digitalWrite(13, estadoLed);
  delay(200);
}
`;

/** Click en el número de línea del editor: pone o saca un breakpoint. */
async function clickMargen(page: Page, linea: number): Promise<void> {
  const g = (await page.locator('#gutter').boundingBox())!;
  await page.mouse.click(g.x + 20, g.y + 8 + (linea - 1) * 19.5 + 9);
}

const contador = async (page: Page) => Number((await page.locator('#dbg-variables').innerText()).match(/contador\s*=\s*(\d+)/)?.[1]);

test('depurar un Uno: variables en vivo, breakpoint desde el margen, continuar, paso por encima y evaluar', async ({ page, request }) => {
  test.setTimeout(6 * 60_000);
  const name = `e2e-dbg-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, language: 'arduino', board: 'arduino-uno' } })).ok()).toBeTruthy();
  expect((await request.put(`/api/projects/${name}/files/sketch.cpp`, { data: { content: SKETCH } })).ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await expect(page.locator('#editor')).toHaveValue(/volatile unsigned long contador/);

  await page.locator('#ejecutar').click();
  await expect(page.locator('#badge-modo')).toBeVisible({ timeout: 4 * 60_000 });
  await page.locator('#tw-debug').click();

  // Corriendo: las globales se leen en vivo, sin pausar (el contador sube solo).
  await expect.poll(() => contador(page), { timeout: 15_000 }).toBeGreaterThan(0);
  const antes = await contador(page);
  await expect.poll(() => contador(page), { timeout: 10_000 }).toBeGreaterThan(antes);
  await expect(page.locator('#dbg-variables')).toContainText('estadoLed'); // compilado con -Og: no lo borra el optimizador

  // Breakpoint en la línea 14 con click en el margen: se detiene ahí.
  await clickMargen(page, 14);
  await expect(page.locator('#bp-capa .bp.verificado')).toHaveCount(1);
  await expect(page.locator('#dbg-estado')).toContainText('sketch.cpp:14', { timeout: 15_000 });
  await expect(page.locator('#linea-parada')).toBeVisible();
  await expect(page.locator('#dbg-pila')).toContainText('loop');
  await expect(page.locator('#estado')).toHaveText('en pausa');
  const enBreakpoint = await contador(page);

  // Continuar (F9): da una vuelta de loop() y vuelve a parar en el mismo breakpoint, con +1.
  await page.keyboard.press('F9');
  await expect.poll(() => contador(page), { timeout: 10_000 }).toBe(enBreakpoint + 1);
  await expect(page.locator('#dbg-estado')).toContainText('sketch.cpp:14');

  // Paso por encima (F8): a la línea siguiente.
  await page.keyboard.press('F8');
  await expect(page.locator('#dbg-estado')).toContainText('sketch.cpp:15');

  // Evaluar una expresión con el valor actual.
  await page.locator('#dbg-eval').fill('contador * 2');
  await page.locator('#dbg-eval').press('Enter');
  await expect(page.locator('#dbg-eval-res')).toContainText(new RegExp(`=\\s*${(enBreakpoint + 2) * 2}(?!\\d)`));

  // Saca el breakpoint y sigue: vuelve a correr.
  await clickMargen(page, 14);
  await expect(page.locator('#bp-capa .bp')).toHaveCount(0);
  await page.keyboard.press('F9');
  await expect(page.locator('#dbg-estado')).toHaveText('Corriendo');
  await expect(page.locator('#linea-parada')).toBeHidden();

  // El analizador lógico tiene los pines del sketch.
  await expect.poll(() => page.locator('#dbg-pines').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);

  await request.post('/api/emulator/stop');
});
