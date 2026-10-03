import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

let serial = 0;
async function proyecto(page: Page, request: APIRequestContext, language = 'micropython', content = 'from machine import Pin\n\nled = Pin(2, Pin.OUT)\nled.on()\n') {
  const name = `editor-${Date.now().toString(36)}-${serial++}`;
  expect((await request.post('/api/projects', { data: { name, language } })).ok()).toBeTruthy();
  const file = language === 'micropython' ? 'main.py' : 'main.yaml';
  expect((await request.put(`/api/projects/${name}/files/${file}`, { data: { content } })).ok()).toBeTruthy();
  if (language === 'micropython') expect((await request.put(`/api/projects/${name}/files/helpers.py`, { data: { content: 'def helper():\n    return 1\n' } })).ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await expect(page.locator('#tabs-archivos button.activa')).toHaveText(file);
  if (language === 'micropython') await expect(page.locator('.cm-content')).toBeVisible();
  else await expect(page.locator('#editor')).toHaveValue(content);
  return name;
}

async function escribir(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(text);
}

async function websocket(page: Page) {
  await page.addInitScript(() => {
    const Orig = window.WebSocket;
    (window as any).WebSocket = class extends Orig {
      constructor(...args: any[]) { super(...(args as [string])); (window as any).__editorWs = this; }
    };
  });
}
async function mensaje(page: Page, event: Record<string, unknown>) {
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__editorWs?.onmessage))).toBe(true);
  await page.evaluate(event => (window as any).__editorWs.onmessage({ data: JSON.stringify(event) }), event);
}

// Caracterización de lo que debe seguir funcionando en el editor artesanal.
test('el editor YAML conserva indentado, Ctrl+S y la paleta de comandos', async ({ page, request }) => {
  const name = await proyecto(page, request, 'esphome', 'sensor:');
  const editor = page.locator('#editor');
  await editor.focus();
  await editor.press('Control+End');
  await editor.press('Enter');
  await page.keyboard.insertText('value: 1');
  await expect(editor).toHaveValue('sensor:\n  value: 1');
  const saved = page.waitForResponse(r => r.url().endsWith(`/files/main.yaml`) && r.request().method() === 'PUT');
  await page.keyboard.press('Control+s');
  expect((await saved).ok()).toBeTruthy();
  expect((await (await request.get(`/api/projects/${name}/files/main.yaml`)).json()).content).toBe('sensor:\n  value: 1');
  await page.keyboard.press('Control+Shift+p');
  await expect(page.locator('#dlg-buscar')).toBeVisible();
});

test('MicroPython indenta bloques con cuatro espacios y actualiza Ln:Col', async ({ page, request }) => {
  await proyecto(page, request, 'micropython', 'if True:');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('pass');
  await expect(page.locator('#editor')).toHaveValue('if True:\n    pass');
  await expect(page.locator('#pos-cursor')).toHaveText('2:9');
  await expect(page.locator('#lenguaje-status')).toHaveText(/Python/);
});

test('buscar y reemplazar modifica el archivo con el panel de CodeMirror', async ({ page, request }) => {
  await proyecto(page, request, 'micropython', 'led = 1\nprint(led)\n');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+f');
  const panel = page.locator('.cm-search');
  await expect(panel).toBeVisible();
  await panel.locator('input[name="search"]').fill('led');
  await panel.locator('input[name="replace"]').fill('pin');
  await panel.locator('button[name="replaceAll"]').click();
  await expect(page.locator('#editor')).toHaveValue('pin = 1\nprint(pin)\n');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('completa módulos y API MicroPython con Ctrl+Space', async ({ page, request }) => {
  await proyecto(page, request, 'micropython', 'from machine import Pi');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+Space');
  const pin = page.locator('.cm-tooltip-autocomplete [role="option"]').filter({ has: page.locator('.cm-completionLabel', { hasText: /^Pin$/ }) });
  await expect(pin).toBeVisible();
  await pin.click();
  await expect(page.locator('#editor')).toHaveValue('from machine import Pin');
  await escribir(page, 'import machine\nmachine.I2');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('I2C');
  await page.screenshot({ path: '/tmp/editor-micropython.png' });
});

test('detecta sintaxis inválida mientras se escribe y limpia el diagnóstico al corregir', async ({ page, request }) => {
  await proyecto(page, request);
  await escribir(page, 'if True\n    pass');
  await expect(page.locator('.cm-lintRange-error, .cm-lintPoint-error').first()).toBeAttached();
  await expect(page.locator('.cm-lint-marker-error').first()).toBeVisible();
  await escribir(page, 'if True:\n    pass');
  await expect(page.locator('.cm-lintRange-error, .cm-lintPoint-error')).toHaveCount(0);
});

test('autoguarda, guarda con Ctrl+S y cambia de pestaña sin perder contenido', async ({ page, request }) => {
  const name = await proyecto(page, request);
  await escribir(page, 'from machine import Pin\nvalor = 42\n');
  await expect.poll(async () => (await (await request.get(`/api/projects/${name}/files/main.py`)).json()).content).toBe('from machine import Pin\nvalor = 42\n');
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('print(valor)');
  const saved = page.waitForResponse(r => r.url().endsWith('/files/main.py') && r.request().method() === 'PUT');
  await page.keyboard.press('Control+s');
  expect((await saved).ok()).toBeTruthy();
  const other = page.locator('#tabs-archivos button', { hasText: /^helpers\.py$/ });
  await expect(other).toBeVisible();
  await other.click();
  await page.locator('#tabs-archivos button', { hasText: /^main\.py$/ }).click();
  await expect(page.locator('#editor')).toHaveValue('from machine import Pin\nvalor = 42\nprint(valor)');
  await page.keyboard.press('Control+Shift+p');
  await expect(page.locator('#dlg-buscar')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+k');
  await expect(page.locator('#dlg-buscar')).toBeVisible();
});

test('los errores de build aparecen inline y Problemas navega a su línea', async ({ page, request }) => {
  await websocket(page);
  await proyecto(page, request);
  await mensaje(page, { type: 'build.done', ok: false, durationMs: 100, errors: [{ file: 'main.py', line: 3, message: 'Pin inexistente en la placa' }] });
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(1);
  await page.keyboard.press('Alt+6');
  const error = page.locator('#problemas .problema', { hasText: 'Pin inexistente' });
  await expect(error).toBeVisible();
  await error.click();
  await expect(page.locator('#pos-cursor')).toHaveText('3:1');
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.insertText('#');
  await expect(page.locator('#problemas .problema', { hasText: 'Pin inexistente' })).toHaveCount(0);
});

test('pliega y despliega un bloque Python', async ({ page, request }) => {
  await proyecto(page, request, 'micropython', 'def saludar():\n    print("hola")\n    return 1\n\nsaludar()');
  const fold = page.locator('.cm-foldGutter .cm-gutterElement').filter({ hasText: '⌄' }).first();
  await expect(fold).toBeVisible();
  await fold.click();
  await expect(page.locator('.cm-foldPlaceholder')).toBeVisible();
  await page.locator('.cm-foldPlaceholder').click();
  await expect(page.locator('.cm-foldPlaceholder')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('print("hola")');
});

test('un error de otro archivo no marca main.py y Problemas abre el archivo correcto', async ({ page, request }) => {
  await websocket(page);
  await proyecto(page, request);
  await mensaje(page, { type: 'build.done', ok: false, durationMs: 100, errors: [{ file: 'helpers.py', line: 2, message: 'Error de helper' }] });
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(0);
  await page.keyboard.press('Alt+6');
  await page.locator('#problemas .problema', { hasText: 'Error de helper' }).click();
  await expect(page.locator('#tabs-archivos button.activa')).toHaveText('helpers.py');
  await expect(page.locator('#pos-cursor')).toHaveText('2:1');
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(1);
  await expect(page.locator('#problemas .problema', { hasText: 'Error de helper' })).toHaveCount(1);
});

test('el historial de deshacer queda separado por proyecto', async ({ page, request }) => {
  const first = await proyecto(page, request, 'micropython', 'valor = 1');
  await escribir(page, 'valor = 10');
  const saved = page.waitForResponse(r => r.url().endsWith('/files/main.py') && r.request().method() === 'PUT');
  await page.keyboard.press('Control+s');
  expect((await saved).ok()).toBeTruthy();
  const second = `historial-${Date.now().toString(36)}-${serial++}`;
  expect((await request.post('/api/projects', { data: { name: second, language: 'micropython' } })).ok()).toBeTruthy();
  expect((await request.put(`/api/projects/${second}/files/main.py`, { data: { content: 'valor = 2' } })).ok()).toBeTruthy();
  // Cambiar el hash conserva la instancia de la app y refresca proyectos creados externamente.
  await page.evaluate(second => { location.hash = second; }, second);
  await expect(page.locator('.cm-content')).toHaveText('valor = 2');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cm-content')).toHaveText('valor = 2');
  await page.locator('#proyecto').selectOption(first);
  await expect(page.locator('.cm-content')).toHaveText('valor = 10');
});

test('breakpoints usan DAP y la pausa resalta la línea real de CodeMirror', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await websocket(page);
  const name = await proyecto(page, request);
  const line = await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^3$/ }).boundingBox();
  const gutter = await page.locator('.cm-breakpointGutter').boundingBox();
  expect(line).not.toBeNull(); expect(gutter).not.toBeNull();
  await page.mouse.click(gutter!.x + gutter!.width / 2, line!.y + line!.height / 2);
  await expect(page.locator('.cm-breakpointGutter .cm-breakpoint:visible')).toHaveCount(1);
  await expect.poll(async () => (await (await request.get(`/api/debug/breakpoints?project=${name}`)).json()).breakpoints)
    .toEqual(expect.arrayContaining([expect.objectContaining({ line: 3 })]));
  let debugState: Record<string, unknown> = { status: 'stopped', reason: 'breakpoint', source: { name: 'main.py', path: 'main.py' }, line: 3 };
  // Abrir Debug refresca el estado DAP: devolver la misma pausa que anuncia el WebSocket.
  await page.route('**/api/debug/state', async route => {
    const { breakpoints } = await (await request.get(`/api/debug/breakpoints?project=${name}`)).json();
    await route.fulfill({ json: { state: debugState, capabilities: { motor: 'e2e', stackTrace: 'no', variables: false }, breakpoints } });
  });
  await mensaje(page, { type: 'debug.stopped', reason: 'breakpoint', source: { name: 'main.py', path: 'main.py' }, line: 3 });
  await expect(page.locator('.cm-debug-stopped')).toContainText('led = Pin');
  await expect(page.locator('#dbg-estado')).toContainText('main.py:3');
  await page.locator('.cm-breakpointGutter .cm-breakpoint:visible').click();
  await expect(page.locator('.cm-breakpointGutter .cm-breakpoint:visible')).toHaveCount(0);
  await escribir(page, 'pass');
  await expect(page.locator('.cm-debug-stopped')).toHaveCount(0);
  expect(errors).toEqual([]);
  debugState = { status: 'running' };
  await mensaje(page, { type: 'debug.continued' });
  await expect(page.locator('.cm-debug-stopped')).toHaveCount(0);
});

test('edita dos líneas con múltiples cursores', async ({ page, request }) => {
  await proyecto(page, request, 'micropython', 'uno = 1\ndos = 2');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+Alt+ArrowDown');
  await page.keyboard.insertText('# ');
  await expect(page.locator('#editor')).toHaveValue('# uno = 1\n# dos = 2');
});

test('las pestañas conservan cursor y scroll de archivos largos', async ({ page, request }) => {
  await proyecto(page, request, 'micropython', Array.from({ length: 100 }, (_, i) => `valor_${i + 1} = ${i}`).join('\n'));
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await expect(page.locator('#pos-cursor')).toHaveText('100:15');
  await expect.poll(() => page.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  const scroll = await page.locator('.cm-scroller').evaluate(el => el.scrollTop);
  await page.locator('#tabs-archivos button', { hasText: /^helpers\.py$/ }).click();
  await page.locator('#tabs-archivos button', { hasText: /^main\.py$/ }).click();
  await expect(page.locator('#pos-cursor')).toHaveText('100:15');
  await expect.poll(() => page.locator('.cm-scroller').evaluate(el => el.scrollTop)).toBeGreaterThan(scroll - 5);
});

test('los ajustes cambian tema, fuente e indentación y persisten al recargar', async ({ page, request }) => {
  await proyecto(page, request, 'micropython', 'if True:');
  await page.locator('#act-ajustes').click();
  await page.locator('#dlg-ajustes').getByRole('button', { name: 'Ajustes del editor', exact: true }).click();
  const settings = page.locator('#dlg-editor-preferences');
  await expect(settings).toBeVisible();
  await page.locator('#editor-theme').selectOption('light');
  await page.locator('#editor-font-size').fill('18');
  await page.locator('#editor-indent-width').selectOption('2');
  await page.screenshot({ path: '/tmp/editor-preferences.png' });
  await settings.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '18px');
  await expect(page.locator('.cm-editor')).not.toHaveClass(/cm-dark/);
  await page.screenshot({ path: '/tmp/editor-light.png' });
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('pass');
  await expect(page.locator('#editor')).toHaveValue('if True:\n  pass');
  const saved = page.waitForResponse(r => r.url().endsWith('/files/main.py') && r.request().method() === 'PUT');
  await page.keyboard.press('Control+s');
  expect((await saved).ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '18px');
  await expect(page.locator('.cm-editor')).not.toHaveClass(/cm-dark/);
  await page.locator('#act-ajustes').click();
  await page.locator('#dlg-ajustes').getByRole('button', { name: 'Ajustes del editor', exact: true }).click();
  await expect(page.locator('#editor-theme')).toHaveValue('light');
  await expect(page.locator('#editor-font-size')).toHaveValue('18');
  await expect(page.locator('#editor-indent-width')).toHaveValue('2');
  await settings.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('valor = 1');
  await expect(page.locator('#editor')).toHaveValue('if True:\n  pass\n  valor = 1');
});

async function formatear(page: Page) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Shift+p');
  await page.locator('#pc-entrada').fill('formatear');
  await page.locator('#pc-lista li[role="option"]').filter({ hasText: /Formatear/ }).first().click();
  await expect(page.locator('#dlg-buscar')).toBeHidden();
}

test('formatea Python con Ruff en worker, autoguarda y permite deshacer', async ({ page, request }) => {
  const original = 'x=1+2\nprint( x )';
  const formatted = 'x = 1 + 2\nprint(x)\n';
  const name = await proyecto(page, request, 'micropython', original);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Shift+i');
  await expect(page.locator('#editor')).toHaveValue(formatted);
  await expect.poll(async () => (await (await request.get(`/api/projects/${name}/files/main.py`)).json()).content).toBe(formatted);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await expect(page.locator('#editor')).toHaveValue(original);
  await expect.poll(async () => (await (await request.get(`/api/projects/${name}/files/main.py`)).json()).content).toBe(original);
});

test('formatear código inválido informa el error y conserva el archivo', async ({ page, request }) => {
  const original = 'if True\n    print(1)';
  const name = await proyecto(page, request, 'micropython', original);
  await formatear(page);
  await expect(page.locator('#lista-notificaciones')).toContainText(/formate|sintaxis/i);
  await expect(page.locator('#editor')).toHaveValue(original);
  expect((await (await request.get(`/api/projects/${name}/files/main.py`)).json()).content).toBe(original);
});

test('una respuesta tardía de formato conserva lo escrito mientras el worker trabajaba', async ({ page, request }) => {
  await page.addInitScript(() => {
    const Orig = window.Worker;
    window.Worker = class extends Orig {
      postMessage(message: any, transferOrOptions?: any) {
        (window as any).__formatterPosts = ((window as any).__formatterPosts ?? 0) + 1;
        super.postMessage(message, transferOrOptions);
      }
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        let callback: ((event: MessageEvent) => void) | null = null;
        Object.defineProperty(this, 'onmessage', { configurable: true, get: () => callback, set: value => { callback = value; } });
        this.addEventListener('message', event => {
          (window as any).__formatterResponseReady = true;
          (window as any).__releaseFormatter = () => callback?.call(this, event);
        });
      }
    };
  });
  await proyecto(page, request, 'micropython', 'x=1+2');
  await formatear(page);
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__formatterResponseReady))).toBe(true);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Shift+i');
  expect(await page.evaluate(() => (window as any).__formatterPosts)).toBe(1);
  await escribir(page, 'x=3+4 # cambio nuevo');
  await page.evaluate(() => (window as any).__releaseFormatter());
  await expect(page.locator('#lista-notificaciones')).toContainText('se conservaron tus cambios');
  await expect(page.locator('#editor')).toHaveValue('x=3+4 # cambio nuevo');
});
