import { expect, test } from '@playwright/test';

test('Aprender abre su índice, permite avanzar pasos y conserva la ruta al recargar', async ({ page }) => {
  await page.goto('/');
  await page.locator('#bienvenida-acerca').click();
  await expect(page.locator('body')).toHaveClass(/aprender/);
  await expect(page).toHaveURL(/#\/aprender$/);
  await expect(page.getByRole('heading', { name: 'Aprendé electrónica, paso a paso' })).toBeVisible();

  await page.getByRole('button', { name: 'Empezar lección' }).click();
  await expect(page).toHaveURL(/#\/aprender\/encender-un-led\?paso=identificar$/);
  await expect(page.getByRole('heading', { name: 'Encender un LED' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Identificá cada componente' })).toBeVisible();
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await expect(page).toHaveURL(/#\/aprender\/encender-un-led\?paso=seguir-circuito$/);
  await expect(page.getByRole('heading', { name: 'Seguí el circuito' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Seguí el circuito' })).toBeVisible();
  await page.locator('#pantalla-aprender').getByRole('button', { name: /Todas las lecciones/ }).click();
  await expect(page).toHaveURL(/#\/aprender$/);
  await page.getByRole('button', { name: 'Continuar lección' }).click();
  await expect(page).toHaveURL(/#\/aprender\/encender-un-led\?paso=seguir-circuito$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/aprender$/);
});

test('una lección desconocida muestra una salida para volver al índice', async ({ page }) => {
  await page.goto('/#/aprender/no-existe');
  await expect(page.getByRole('heading', { name: 'Lección no encontrada' })).toBeVisible();
  await page.getByRole('button', { name: 'Volver a Aprender' }).click();
  await expect(page).toHaveURL(/#\/aprender$/);
});

test('avanzar pasos reemplaza la entrada para volver al índice de la lección', async ({ page }) => {
  await page.goto('/');
  await page.locator('#bienvenida-acerca').click();
  await page.getByRole('button', { name: 'Empezar lección' }).click();
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await expect(page).toHaveURL(/paso=estimar-corriente$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/aprender$/);
  await expect(page.getByRole('heading', { name: 'Aprendé electrónica, paso a paso' })).toBeVisible();
});

test('un paso desconocido vuelve al primer paso y normaliza la dirección', async ({ page }) => {
  await page.goto('/#/aprender/encender-un-led?paso=no-existe');
  await expect(page.getByRole('heading', { name: 'Identificá cada componente' })).toBeVisible();
  await expect(page).toHaveURL(/#\/aprender\/encender-un-led\?paso=identificar$/);
});

test('la última parte de la lección crea la práctica con una plantilla independiente', async ({ page, request }) => {
  const plantillas = await (await request.get('/api/templates')).json();
  expect(plantillas.some((plantilla: { id: string }) => plantilla.id === 'aprender-led')).toBe(true);
  const nombre = 'practica-aprender-led';
  await page.goto('/#/aprender/encender-un-led?paso=invertir-led');
  page.once('dialog', dialog => dialog.accept(nombre));
  await page.getByRole('button', { name: 'Abrir práctica' }).click();
  await expect(page.locator('#proyecto')).toHaveValue(nombre);
  await expect(page).toHaveURL(/leccion=encender-un-led$/);
  await expect(page.locator('body')).not.toHaveClass(/aprender/);
  const { project } = await (await request.get('/api/projects/' + nombre)).json();
  expect(project.board).toBeNull();
  expect(project.modules.map((modulo: { id: string }) => modulo.id)).toEqual(['fuente1', 'r1', 'led1']);
  expect(project.modules.find((modulo: { id: string }) => modulo.id === 'r1').props.ohms).toBe(330);
  expect(project.wires).toHaveLength(3);

  await page.getByRole('button', { name: 'Volver a la lección' }).click();
  await expect(page).toHaveURL(/#\/aprender\/encender-un-led\?paso=invertir-led$/);
  await page.locator('#pantalla-aprender').getByRole('button', { name: /Todas las lecciones/ }).click();
  await page.getByRole('button', { name: 'Continuar práctica' }).click();
  await expect(page.locator('#proyecto')).toHaveValue(nombre);
  const proyectos = await (await request.get('/api/projects')).json();
  expect(proyectos.projects.filter((item: { name: string }) => item.name === nombre)).toHaveLength(1);

  await request.delete('/api/projects/' + nombre);
  await page.getByRole('button', { name: 'Volver a la lección' }).click();
  await page.locator('#pantalla-aprender').getByRole('button', { name: /Todas las lecciones/ }).click();
  await page.getByRole('button', { name: 'Continuar práctica' }).click();
  await expect(page).toHaveURL(/#\/aprender\/encender-un-led\?paso=invertir-led$/);
  await expect(page.getByRole('button', { name: 'Abrir práctica' })).toBeVisible();
  await expect(page.locator('#pantalla-aprender').getByRole('button', { name: 'Continuar práctica' })).toHaveCount(0);
});

test('terminar la lección guarda la finalización local', async ({ page }) => {
  await page.goto('/#/aprender/encender-un-led?paso=invertir-led');
  await page.getByRole('button', { name: 'Terminar lección' }).click();
  await expect(page.getByText('Completada')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuar lección' })).toBeVisible();
});
