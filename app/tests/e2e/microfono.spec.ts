import { expect, test, type Page } from '@playwright/test';

/** Señal sintética en un MediaStream real: ejercita el adaptador Web Audio sin hardware ni sonido audible. */
async function senoNativo(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async (constraints: MediaStreamConstraints) => {
      const ctx = new AudioContext(), oscilador = ctx.createOscillator(), ganancia = ctx.createGain();
      const salida = ctx.createMediaStreamDestination();
      oscilador.frequency.value = 375; ganancia.gain.value = .1;
      oscilador.connect(ganancia); ganancia.connect(salida); oscilador.start(); await ctx.resume();
      Object.assign(window, { pruebaMicrofono: { constraints, stream: salida.stream,
        amplitud: (n: number) => { ganancia.gain.value = n; }, cerrar: async () => { oscilador.stop(); await ctx.close(); } } });
      return salida.stream;
    } });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { value: async () => [] });
  });
}
async function abrir(page: Page, name: string): Promise<void> {
  await page.goto(`/#${name}`); await expect(page.locator('#proyecto')).toHaveValue(name);
  await page.locator('[data-tab="debug"]').click();
  if (!await page.locator('#monitor-detalles').evaluate(el => (el as HTMLDetailsElement).open)) await page.locator('#monitor-detalles > summary').click();
}
test('audio nativo alimenta el circuito, conserva el proyecto y recupera manual al detenerse', async ({ page, request }) => {
  const name = `e2e-microfono-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, template: 'sonometro-que-se-lee' } })).ok()).toBeTruthy();
  const antes = await (await request.get(`/api/projects/${name}`)).json();
  await senoNativo(page); await abrir(page, name);
  try {
    await page.getByRole('button', { name: 'Conectar micrófono', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Micrófono del computador' }).getByRole('status')).toContainText('Micrófono conectado');
    await expect(page.locator('.microfono-lectura')).toContainText(/-23\.0 dBFS/);
    await expect.poll(async () => {
      const r = await (await request.get(`/api/projects/${name}/pins`)).json();
      return r.electrico.resuelto ? r.electrico.tensiones['mic1.OUT'] : null;
    }).toBeCloseTo(1.5398, 2);
    expect(await (await request.get(`/api/projects/${name}`)).json()).toEqual(antes);
    await page.evaluate(() => (window as unknown as { pruebaMicrofono: { amplitud(n: number): void } }).pruebaMicrofono.amplitud(.5));
    await expect(page.locator('.microfono-lectura')).toContainText(/-9\.0 dBFS/);
    await expect.poll(async () => {
      const r = await (await request.get(`/api/projects/${name}/pins`)).json();
      return r.electrico.resuelto ? r.electrico.tensiones['mic1.OUT'] : null;
    }).toBeCloseTo(1.8194, 2);
    await page.evaluate(() => (window as unknown as { pruebaMicrofono: { amplitud(n: number): void } }).pruebaMicrofono.amplitud(0));
    await expect(page.locator('.microfono-lectura')).toContainText('Silencio digital');
    await expect.poll(async () => {
      const r = await (await request.get(`/api/projects/${name}/pins`)).json();
      return r.electrico.resuelto ? r.electrico.tensiones['mic1.OUT'] : null;
    }).toBeCloseTo(.6, 2);
    await page.evaluate(() => (window as unknown as { pruebaMicrofono: { amplitud(n: number): void } }).pruebaMicrofono.amplitud(.1));
    await expect(page.locator('.microfono-lectura')).toContainText(/-23\.0 dBFS/);
    await page.getByLabel('Nivel de simulación en esa referencia').fill('160');
    await expect.poll(async () => {
      const r = await (await request.get(`/api/projects/${name}/pins`)).json();
      return r.electrico.resuelto ? r.electrico.tensiones['mic1.OUT'] : null;
    }).toBeCloseTo(2.6, 2);
    await page.getByLabel('Nivel de simulación en esa referencia').fill('5');
    await expect.poll(async () => {
      const r = await (await request.get(`/api/projects/${name}/pins`)).json();
      return r.electrico.resuelto ? r.electrico.tensiones['mic1.OUT'] : null;
    }).toBeCloseTo(.6, 2);
    await page.getByRole('button', { name: 'Detener micrófono', exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/projects/${name}/pins`)).json()).electrico.tensiones['mic1.OUT']).toBeCloseTo(1, 2);
    expect(await page.evaluate(() => (window as unknown as { pruebaMicrofono: { stream: MediaStream } }).pruebaMicrofono.stream.getTracks().every(t => t.readyState === 'ended'))).toBe(true);
    expect(await (await request.get(`/api/projects/${name}`)).json()).toEqual(antes);
  } finally {
    await page.getByRole('button', { name: 'Detener micrófono', exact: true }).click({ force: true, timeout: 1000 }).catch(() => {});
    await page.evaluate(async () => { await (window as unknown as { pruebaMicrofono?: { cerrar(): Promise<void> } }).pruebaMicrofono?.cerrar(); });
  }
});
test('permiso denegado informa el problema y mantiene el sensor manual', async ({ page, request }) => {
  const name = `e2e-microfono-denegado-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, template: 'sonometro-que-se-lee' } })).ok()).toBeTruthy();
  await page.addInitScript(() => { Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new DOMException('denegado', 'NotAllowedError'); } }); });
  await abrir(page, name); await page.getByRole('button', { name: 'Conectar micrófono', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Micrófono del computador' }).getByRole('alert')).toContainText('Permiso de micrófono denegado');
  expect((await (await request.get(`/api/projects/${name}/sound/mic1/status`)).json()).activo).toBe(false);
  await expect.poll(async () => (await (await request.get(`/api/projects/${name}/pins`)).json()).electrico.tensiones['mic1.OUT']).toBeCloseTo(1, 2);
});
