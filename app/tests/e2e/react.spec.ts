import { test, expect } from '@playwright/test';
import { abrirProyectoNuevo, modulo, pin, caja, mitadDeCable } from './helpers.js';

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

test('el catálogo lo rinde React y cada tarjeta dibuja su miniatura', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  // Sin fijar el número: los specs del importador agregan módulos al catálogo, que es compartido.
  await expect(page.locator('.modulo-card').first()).toBeVisible();
  expect(await page.locator('.modulo-card').count()).toBeGreaterThanOrEqual(15);

  // La miniatura la construye `miniatura()` nodo por nodo y React la inserta con un ref: si eso
  // se rompiera, las tarjetas quedarían sin dibujo y ningún otro test lo notaría.
  const sinDibujo = await page.evaluate(() => {
    const malas: string[] = [];
    for (const card of document.querySelectorAll('.modulo-card')) {
      const svg = card.querySelector('svg.miniatura');
      if (!svg || svg.querySelectorAll('*').length === 0) malas.push(card.getAttribute('data-type') ?? '?');
    }
    return malas;
  });
  expect(sinDibujo, 'tarjetas sin miniatura dibujada').toEqual([]);

  // El LED de la miniatura se dibuja encendido (así se ve de qué color es).
  const led = page.locator('.modulo-card[data-type="led"] svg.miniatura');
  await expect(led).toBeAttached();
  expect(await led.locator('[data-si="on"]').count()).toBeGreaterThan(0);
});

test('el buscador de proyectos filtra la lista (el filtro pasó del DOM al estado)', async ({ page, request }) => {
  const a = `busca-alfa-${Date.now().toString(36)}`;
  const b = `busca-beta-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name: a, language: 'esphome' } });
  await request.post('/api/projects', { data: { name: b, language: 'micropython' } });
  await page.goto('/');

  const tarjetas = page.locator('#lista-proyectos .proyecto-card');
  await expect(page.locator(`#lista-proyectos .nombre`, { hasText: a })).toBeVisible();
  await expect(page.locator(`#lista-proyectos .nombre`, { hasText: b })).toBeVisible();

  // Por nombre.
  await page.locator('#buscar-proyectos').fill('alfa');
  await expect(page.locator('#lista-proyectos .nombre', { hasText: a })).toBeVisible();
  await expect(page.locator('#lista-proyectos .nombre', { hasText: b })).toHaveCount(0);

  // Por lenguaje (el filtro mira nombre y lenguaje).
  await page.locator('#buscar-proyectos').fill('micropython');
  await expect(page.locator('#lista-proyectos .nombre', { hasText: b })).toBeVisible();

  // Sin resultados.
  await page.locator('#buscar-proyectos').fill('zzzz-nada');
  await expect(page.locator('#lista-proyectos')).toContainText('Ningún proyecto coincide');

  // Y al limpiar vuelven.
  await page.locator('#buscar-proyectos').fill('');
  expect(await tarjetas.count()).toBeGreaterThanOrEqual(2);
});

test('el panel derecho lo rinde React: pines, propiedades y el pulsador que se suelta solo', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  const panel = page.locator('#panel-modulo');

  // --- Tabla de pines: tipo de cada uno y a dónde va ---
  await modulo(page, 'led1').locator('.etiqueta-modulo').click();
  await expect(panel.locator('.insp-pines')).toContainText('entrada');
  await expect(panel.locator('.insp-pines')).toContainText('tierra');
  await expect(panel.locator('.conexion').first()).toContainText('→');

  // --- Propiedades: el select del color ---
  const color = panel.locator('select[data-prop="color"]');
  await expect(color).toBeVisible();

  // --- Cable seleccionado: otra variante del mismo panel ---
  // Un cable es una curva delgada: el centro de su caja cae fuera del trazo, de ahí el helper.
  const p = await mitadDeCable(page, 'btn1.OUT', 'board.GPIO6');
  await page.mouse.click(p.x, p.y);
  await expect(panel).toContainText('Cable');
  await expect(panel.locator('.insp-conexion')).toContainText('↔');
  await expect(panel.locator('#insp-borrar-cable')).toBeVisible();

  // --- El pulsador del panel: se marca al apretarlo y se suelta aunque el mouse se vaya ---
  await modulo(page, 'btn1').locator('.etiqueta-modulo').click();
  const boton = panel.locator('.btn-accionar[data-accion="momentary"]');
  await expect(boton).toHaveText('Mantener presionado');
  await expect(boton).not.toHaveClass(/activo/);

  const caja = await boton.boundingBox();
  await page.mouse.move(caja!.x + caja!.width / 2, caja!.y + caja!.height / 2);
  await page.mouse.down();
  await expect(boton, 'al apretarlo se marca').toHaveClass(/activo/);

  // Se suelta lejos del botón: el mouseup es de la ventana, no del botón.
  await page.mouse.move(10, 10);
  await page.mouse.up();
  await expect(boton, 'al soltar, aunque sea afuera, se desmarca').not.toHaveClass(/activo/);
});
