import { expect, test } from '@playwright/test';

// Las prácticas energizan el servidor compartido: cada caso devuelve su estado al reposo.
test.afterEach(async ({ request }) => {
  expect((await request.post('/api/emulator/stop')).ok()).toBeTruthy();
});

test('el catálogo abre el recorrido MDX, guarda progreso y permite retomar la lectura', async ({ page }) => {
  await page.goto('/#/aprender');
  await page.getByRole('link', { name: /De Ohm a Kirchhoff y Tellegen/ }).click();
  await expect(page).toHaveURL(/aprender\/rutas\/ohm-kirchhoff-tellegen$/);
  await expect(page.locator('.mdx-indice a')).toHaveCount(6);
  await page.getByRole('link', { name: /Tensión, corriente y resistencia/ }).click();
  await expect(page.getByRole('heading', { name: 'Tres magnitudes para describir un circuito' })).toBeVisible();
  await expect(page.locator('.mdx-contenido table').first()).toContainText('voltio');
  await page.getByRole('button', { name: 'Completar y continuar' }).click();
  await expect(page).toHaveURL(/aprender\/ley-ohm\?paso=contenido$/);
  await expect(page.getByRole('heading', { name: 'La ley de Ohm en acción' })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Predecí antes de encender' })).toBeVisible();
  await page.getByRole('link', { name: '← Volver al recorrido' }).click();
  await expect(page.locator('.mdx-indice a').first()).toContainText('Completada');
  await expect(page.locator('.mdx-indice a').nth(1)).toContainText('En curso');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'La ley de Ohm en acción' })).toBeVisible();
});

test('abre una copia de _learning y vuelve a la lección sin duplicar la práctica', async ({ page, request }) => {
  const nombre = 'practica-mdx-ohm';
  await request.delete(`/api/projects/${nombre}`);
  const ejemplos = await (await request.get('/api/learning/examples')).json();
  expect(ejemplos).toHaveLength(8);
  await page.goto('/#/aprender/ley-ohm');
  await page.getByRole('button', { name: 'Abrir ejemplo en el emulador' }).click();
  await page.getByRole('textbox', { name: 'Nombre del proyecto' }).fill(nombre);
  await page.getByRole('button', { name: 'Crear y abrir' }).click();
  await expect(page).toHaveURL(/projects\/practica-mdx-ohm\?leccion=ley-ohm$/);
  await expect(page.locator('#proyecto')).toHaveValue(nombre);
  await expect(page.locator('#ventana-circuito')).toBeVisible();
  const { project } = await (await request.get(`/api/projects/${nombre}`)).json();
  expect(project.modules.find((item: { id: string }) => item.id === 'r1').props.ohms).toBe(1000);
  await request.post(`/api/projects/${nombre}/energia`, { data: { encendido: true } });
  const mediciones = await (await request.get(`/api/projects/${nombre}/pins`)).json();
  const resistor = mediciones.electrico.mediciones.find((item: { modulo: string; elemento: string }) => item.modulo === 'r1' && item.elemento === 'r');
  // El modelo CV/CC suaviza su transición: tolerancia de 0,5 % frente al cálculo ideal.
  expect(Math.abs(resistor.corrienteMa - 5)).toBeLessThan(0.025);
  expect(Math.abs(resistor.tensionV - 5)).toBeLessThan(0.025);
  expect(Math.abs(resistor.potenciaMw - 25)).toBeLessThan(0.125);
  await page.getByRole('button', { name: 'Volver a la lección' }).click();
  await expect(page.getByRole('heading', { name: 'La ley de Ohm en acción' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar práctica' }).click();
  await expect(page.locator('#proyecto')).toHaveValue(nombre);
  await expect(page.locator('#ventana-circuito')).toBeVisible();
  await request.delete(`/api/projects/${nombre}`);
});

test('las seis lecciones cargan sus componentes y no desbordan en móvil', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const id of ['magnitudes-dc', 'ley-ohm', 'redes-resistivas', 'kirchhoff-corrientes', 'kirchhoff-tensiones', 'tellegen-potencia']) {
    await page.goto(`/#/aprender/${id}`);
    await expect(page.locator('.mdx-actividad').first()).toBeVisible();
    await expect(page.locator('.mdx-formula').first()).toBeVisible();
    await expect(page.locator('.mdx-contenido [role="alert"]')).toHaveCount(0);
    await expect(page.locator('.mdx-circuito svg').first()).toBeVisible();
    const ancho = await page.locator('#pantalla-aprender').evaluate(element => ({ cliente: element.clientWidth, contenido: element.scrollWidth }));
    expect(ancho.contenido).toBeLessThanOrEqual(ancho.cliente);
  }
});


test('la API separa ejemplos de plantillas y rechaza copias inválidas', async ({ request }) => {
  const plantillas = await (await request.get('/api/templates')).json();
  expect(plantillas.some((item: { id: string }) => ['ohm', 'serie', 'paralelo', 'divisor-cargado'].includes(item.id))).toBe(false);
  expect((await request.post('/api/learning/examples/ohm/projects', { data: { name: '../escape' } })).status()).toBe(400);
  expect((await request.post('/api/learning/examples/ausente/projects', { data: { name: 'ausente' } })).status()).toBe(404);
});


test('KCL muestra el ejemplo resuelto y abre la variante de una rama abierta', async ({ page, request }) => {
  const nombre = 'practica-kcl-abierta';
  await request.delete(`/api/projects/${nombre}`);
  await page.goto('/#/aprender/kirchhoff-corrientes');
  await expect(page.getByRole('heading', { name: 'KCL con una rama que no conduce' })).toBeVisible();
  await expect(page.locator('.mdx-circuito[data-ejemplo="paralelo-rama-abierta"]')).toContainText('Una rama abierta');
  const variante = page.locator('.mdx-actividad[data-ejemplo="paralelo-rama-abierta"]');
  await expect(variante).toContainText('0 mA');
  await variante.getByRole('button', { name: 'Abrir variante en el emulador' }).click();
  await page.getByRole('textbox', { name: 'Nombre del proyecto' }).fill(nombre);
  await page.getByRole('button', { name: 'Crear y abrir' }).click();
  await expect(page.locator('#ventana-circuito')).toBeVisible();
  const { project } = await (await request.get(`/api/projects/${nombre}`)).json();
  expect(project.wires.some((wire: { from: string; to: string }) => wire.from === 'r2.1' || wire.to === 'r2.1')).toBe(false);
  await request.post(`/api/projects/${nombre}/energia`, { data: { encendido: true } });
  const datos = await (await request.get(`/api/projects/${nombre}/pins`)).json();
  const r2 = datos.electrico.mediciones.find((item: { modulo: string; elemento: string }) => item.modulo === 'r2' && item.elemento === 'r');
  expect(Math.abs(r2.corrienteMa)).toBeLessThan(.001);
  await page.getByRole('button', { name: 'Volver a la lección' }).click();
  await expect(page.getByRole('heading', { name: 'Kirchhoff: conservación de corriente' })).toBeVisible();
  await request.delete(`/api/projects/${nombre}`);
});
