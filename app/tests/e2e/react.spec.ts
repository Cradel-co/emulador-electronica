import { test, expect } from '@playwright/test';
import { abrirProyectoNuevo, modulo, pin, caja } from './helpers.js';

/**
 * Migración a React (#9). Paso 1: la cadena Vite → React → navegador. Paso 2: el canvas lo monta
 * React, pero lo sigue manejando canvas.ts. Lo que importa es que nada de la UI cambie.
 */
test('React monta el lienzo y el canvas sigue funcionando igual', async ({ page, request }) => {
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

  await abrirProyectoNuevo(page, request);

  // El <svg> lo rindió React, no index.html.
  await expect(page.locator('#lienzo[data-react="lienzo"]')).toBeAttached();
  // Y está en su lugar de siempre dentro del layout.
  await expect(page.locator('.lienzo-wrap #lienzo')).toBeAttached();

  // El dibujo funciona: canvas.ts llenó el svg que le dio React.
  await expect(modulo(page, 'board')).toBeVisible();
  await expect(modulo(page, 'led1')).toBeVisible();
  await expect(page.locator('#lienzo .cable')).not.toHaveCount(0);
  await expect(page.locator('#lienzo .pin')).not.toHaveCount(0);

  // Y la interacción también: seleccionar un módulo abre su panel.
  await modulo(page, 'led1').locator('.etiqueta-modulo').click();
  await expect(page.locator('#panel-modulo')).toContainText('LED');

  expect(errores, 'la consola del navegador no debe tener errores').toEqual([]);
});

test('el lienzo se crea una sola vez', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  // Dos svg (o dos juegos de handlers) serían el síntoma de que el efecto corrió de más.
  await expect(page.locator('#lienzo')).toHaveCount(1);
  await expect(page.locator('#react-lienzo > svg')).toHaveCount(1);
  // Un click en un pin empieza un cable: si hubiera handlers duplicados, se cancelaría solo.
  await pin(page, 'led1.IN').click();
  const c = await caja(page.locator('#lienzo'));
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await expect(page.locator('#lienzo .cable-temporal')).toHaveCount(1);
});

test('los avisos del dibujo los rinde React: se listan, se despliegan y se cierran solos', async ({ page, request }) => {
  const name = `avisos-${Date.now().toString(36)}`;
  const creado = await request.post('/api/projects', { data: { name, language: 'esphome' } });
  const proyecto = (await creado.json()).project;
  // Se quita el cable del botón: el código usa ese pin y queda sin cablear → aviso del server.
  const sinBoton = proyecto.wires.filter((w: any) => !w.from.startsWith('btn1.') && !w.to.startsWith('btn1.'));
  await request.put(`/api/projects/${name}/diagram`, { data: { modules: proyecto.modules, wires: sinBoton } });
  await page.goto(`/#${name}`);

  const avisos = page.locator('#avisos-dibujo');
  await expect(avisos).toContainText(/pin/i);
  await expect(avisos.locator('div')).not.toHaveCount(0);
  // Cada aviso lleva su pin, como antes.
  await expect(avisos.locator('div').first()).toHaveAttribute('data-pin', /.+/);

  // Compacto por defecto; al tocarlo se despliega (es el CSS el que usa la clase).
  await expect(avisos).not.toHaveClass(/abiertos/);
  await avisos.click();
  await expect(avisos).toHaveClass(/abiertos/);
  await avisos.click();
  await expect(avisos).not.toHaveClass(/abiertos/);

  // Al volver a cablear el botón, los avisos desaparecen y el panel no queda desplegado.
  await avisos.click();
  await expect(avisos).toHaveClass(/abiertos/);
  await request.put(`/api/projects/${name}/diagram`, { data: { modules: proyecto.modules, wires: proyecto.wires } });
  await page.reload();
  await expect(page.locator('#avisos-dibujo')).not.toHaveClass(/abiertos/);
});
