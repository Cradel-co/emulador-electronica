import { expect, test } from '@playwright/test';
import {
  abrirProyectoNuevo,
  caja,
  arrastrarModulo,
  cable,
  cablear,
  mitadDeCable,
  modulo,
  pin,
  seleccionarModulo,
} from './helpers';

test.describe('catálogo de módulos', () => {
  test('muestra los módulos por categoría y marca el ESP32 como programable', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    const categorias = page.locator('#lista-modulos .cat-header');
    await expect(categorias).toHaveText(['Placas', 'Entradas', 'Salidas', 'Pasivos', 'Radio 433 MHz', 'Inalámbricos', 'Sensores', 'Alimentación', 'Pantallas']);
    // 4 placas (ESP32-S3, C3, C6, Arduino Uno) + 16 módulos de fábrica (con la fuente regulable, el
    // BME280, el reloj ZS-042, la pantalla OLED, el MPU-6050 y la TFT ST7735).
    await expect(page.locator('.modulo-card')).toHaveCount(20);
    const esp32 = page.locator('.modulo-card[data-type="esp32-s3-devkitc-1"]');
    await expect(esp32.locator('.tag-programable')).toHaveText('programable');
    await expect(page.locator('.modulo-card[data-type="rxb6"] .tag-programable')).toHaveCount(0);
  });

  test('el buscador filtra', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    // "433" aparece en los 3 inalámbricos y en la categoría "Radio 433 MHz" (receptor y transmisor).
    await page.locator('#buscar-modulos').fill('433');
    await expect(page.locator('.modulo-card')).toHaveCount(5);
    await page.locator('#buscar-modulos').fill('receptor');
    await expect(page.locator('.modulo-card')).toHaveCount(1);
    await page.locator('#buscar-modulos').fill('zzz');
    await expect(page.locator('#lista-modulos')).toContainText('Sin resultados');
  });
});

test.describe('proyecto nuevo', () => {
  test('se crea desde la UI con el ESP32, un botón y un LED ya cableados', async ({ page }) => {
    await page.goto('/');
    await page.locator('#nuevo').click();
    const nombre = `e2e-ui-${Date.now().toString(36)}`;
    await page.locator('#dlg-nuevo input[name="name"]').fill(nombre);
    await page.locator('#dlg-nuevo button[value="crear"]').click();
    await expect(page.locator('#proyecto')).toHaveValue(nombre);

    for (const id of ['board', 'btn1', 'led1']) await expect(modulo(page, id)).toBeVisible();
    await expect(cable(page, 'btn1.OUT', 'board.GPIO6')).toHaveCount(1);
    await expect(cable(page, 'led1.IN', 'board.GPIO7')).toHaveCount(1);
    await expect(page.locator('#lienzo .cable')).toHaveCount(4);

    // Sin nada seleccionado se ve el código del ESP32, y el código coincide con el circuito.
    await expect(page.locator('#panel-codigo')).toBeVisible();
    await expect(page.locator('#editor')).toHaveValue(/number: GPIO6/);
    // La placa arranca desenchufada: sin energía no circula nada (ni hay nada que avisar).
    await expect(page.locator('#avisos-dibujo')).toContainText('no tiene alimentación');
    // Con el USB, el LED de la plantilla va directo al GPIO, sin resistencia: la física real lo avisa sola.
    await page.locator('#usb').click();
    await expect(page.locator('#avisos-dibujo')).toContainText('resistencia en serie');
    await expect(page.locator('.tabs button')).toHaveText(['main.yaml']);
  });
});

test.describe('proyectos', () => {
  test('al recargar vuelve al proyecto abierto', async ({ page, request }) => {
    const nombre = await abrirProyectoNuevo(page, request);
    await page.reload();
    await expect(page.locator('#proyecto')).toHaveValue(nombre);
  });

  test('cambiar de proyecto mientras carga otro no mezcla el código ni el circuito', async ({ page, request }) => {
    const a = await abrirProyectoNuevo(page, request);
    const b = await abrirProyectoNuevo(page, request);
    await page.locator('.modulo-card[data-type="rxb6"]').click(); // B tiene un receptor, A no
    await page.waitForResponse((r) => r.url().includes('/diagram') && r.ok());
    // Carga A y, sin esperar, pide B.
    await page.goto(`/#${a}`);
    await page.locator('#proyecto').selectOption(b);
    await expect(page.locator('#editor')).toHaveValue(new RegExp(`name: ${b}`));
    await expect(modulo(page, 'rx1')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator('#editor')).toHaveValue(new RegExp(`name: ${b}`));
    await expect(page.locator('#proyecto')).toHaveValue(b);
  });
});

test.describe('código por módulo', () => {
  test('el ESP32 muestra el editor; un módulo sin código muestra sus pines', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);

    await seleccionarModulo(page, 'btn1');
    await expect(page.locator('#panel-codigo')).toBeHidden();
    const panel = page.locator('#panel-modulo');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.insp-badge')).toContainText('Sin código');
    await expect(panel.locator('.insp-pines')).toContainText('OUT');
    await expect(panel.locator('.insp-pines')).toContainText('→ ESP32-S3 DevKitC-1 · GPIO6');

    await seleccionarModulo(page, 'board');
    await expect(page.locator('#panel-codigo')).toBeVisible();
    await expect(panel).toBeHidden();
  });

  test('un módulo inalámbrico no tiene pines ni código', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('.modulo-card[data-type="remote-433"]').click();
    await expect(modulo(page, 'control1')).toBeVisible();
    const panel = page.locator('#panel-modulo');
    await expect(panel.locator('.insp-badge')).toContainText('Inalámbrico');
    await expect(panel.locator('.insp-pines')).toHaveCount(0);
    await expect(panel.locator('input[data-prop="codeA"]')).toHaveValue(/^[01]{24}$/);
  });

  test('agrega un segundo ESP32 con su lenguaje sin modificar el código de la primera placa', async ({ page, request }) => {
    const name = await abrirProyectoNuevo(page, request);
    const original = (await (await request.get(`/api/projects/${name}/files/main.yaml`)).json()).content;
    await page.locator('.modulo-card[data-type="esp32-s3-devkitc-1"]').click();
    await expect(page.locator('#dlg-placa')).toBeVisible();
    await page.locator('#placa-lenguaje').selectOption('micropython');
    await page.locator('#dlg-placa button[value="agregar"]').click();
    await expect(page.locator('#lienzo .modulo.programable')).toHaveCount(2);
    const { project } = await (await request.get(`/api/projects/${name}`)).json();
    expect(project.boards.map((b: { language: string }) => b.language)).toEqual(['esphome', 'micropython']);
    expect((await (await request.get(`/api/projects/${name}/files/main.yaml`)).json()).content).toBe(original);
    expect((await request.get(`/api/projects/${name}/files/main.py?boardId=board2`)).ok()).toBeTruthy();
  });
});

test.describe('cableado', () => {
  test('agregar un receptor RF, moverlo y cablearlo al ESP32; queda guardado', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('.modulo-card[data-type="rxb6"]').click();
    await expect(modulo(page, 'rx1')).toBeVisible();
    await expect(page.locator('#panel-modulo .insp-pines .sin')).toHaveCount(3);

    // Lo lleva a la derecha de la placa, lejos de todo.
    const placa = await caja(modulo(page, 'board'));
    const antes = await caja(modulo(page, 'rx1'));
    await arrastrarModulo(page, 'rx1', placa.x + placa.width + 60 - antes.x, placa.y + 40 - antes.y);
    // A la derecha de la placa puede quedar fuera del lienzo: como haría un usuario, encuadra.
    await page.locator('#zoom-ajustar').click();

    await cablear(page, 'rx1.DATA', 'board.GPIO4');
    await cablear(page, 'rx1.VCC', 'board.3V3');
    await cablear(page, 'rx1.GND', 'board.GND_2');
    await expect(cable(page, 'rx1.DATA', 'board.GPIO4')).toHaveCount(1);
    await expect(cable(page, 'rx1.VCC', 'board.3V3')).toHaveCount(1);
    await expect(page.locator('#panel-modulo .insp-pines')).toContainText('→ ESP32-S3 DevKitC-1 · GPIO4');
    await expect(page.locator('#panel-modulo .insp-pines .sin')).toHaveCount(0);

    // El código no usa GPIO4: el chequeo circuito ↔ código avisa.
    await expect(page.locator('#avisos-dibujo')).toContainText(/pin (GPIO)?4 que el código no usa/);

    const posicion = (await modulo(page, 'rx1').getAttribute('transform'))!;
    await page.reload();
    await expect(cable(page, 'rx1.DATA', 'board.GPIO4')).toHaveCount(1);
    await expect(modulo(page, 'rx1')).toHaveAttribute('transform', posicion);
  });

  test('sin GND/VCC el módulo se marca como sin alimentar, como en la vida real', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('.modulo-card[data-type="rxb6"]').click();
    // Recién agregado: ningún pin conectado, así que GND y VCC ya están marcados.
    await expect(page.locator('#panel-modulo .insp-badge.advertencia')).toContainText('VCC y GND');
    await expect(page.locator('#lienzo .pin[data-ref="rx1.VCC"]')).toHaveClass(/sin-alimentar/);
    await expect(page.locator('#lienzo .pin[data-ref="rx1.GND"]')).toHaveClass(/sin-alimentar/);

    await cablear(page, 'rx1.DATA', 'board.GPIO4');
    await expect(page.locator('#panel-modulo .insp-badge.advertencia')).toContainText('VCC y GND'); // DATA no alcanza

    await cablear(page, 'rx1.VCC', 'board.3V3');
    await expect(page.locator('#panel-modulo .insp-badge.advertencia')).toContainText('GND');
    await expect(page.locator('#panel-modulo .insp-badge.advertencia')).not.toContainText('VCC y GND');
    await expect(page.locator('#lienzo .pin[data-ref="rx1.VCC"]')).not.toHaveClass(/sin-alimentar/);

    await cablear(page, 'rx1.GND', 'board.GND');
    await expect(page.locator('#panel-modulo .insp-badge.advertencia')).toHaveCount(0);
    await expect(page.locator('#lienzo .pin[data-ref="rx1.GND"]')).not.toHaveClass(/sin-alimentar/);
  });

  test('un módulo agregado con click no queda encima de otro', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    for (const tipo of ['rxb6', 'relay', 'stx882']) await page.locator(`.modulo-card[data-type="${tipo}"]`).click();
    const cajas = await page.locator('#lienzo .modulo .cuerpo').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, id: e.closest('.modulo')!.getAttribute('data-id') };
      }),
    );
    expect(cajas).toHaveLength(6);
    for (const a of cajas) {
      for (const b of cajas) {
        if (a.id === b.id) continue;
        const pisa = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        expect(pisa, `${a.id} pisa a ${b.id}`).toBe(false);
      }
    }
  });

  test('arrastrar un módulo del catálogo al circuito', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    const lienzo = (await page.locator('#lienzo').boundingBox())!;
    await page.locator('.modulo-card[data-type="relay"]').dragTo(page.locator('#lienzo'), {
      targetPosition: { x: lienzo.width - 120, y: 120 },
    });
    await expect(modulo(page, 'rele1')).toBeVisible();
    await expect(page.locator('#panel-modulo')).toContainText('Relé');
  });

  test('cablear arrastrando de un pin a otro', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await page.locator('.modulo-card[data-type="led"]').click();
    const placa = await caja(modulo(page, 'board'));
    const antes = await caja(modulo(page, 'led2'));
    await arrastrarModulo(page, 'led2', placa.x + placa.width + 60 - antes.x, placa.y + 150 - antes.y);
    await page.locator('#zoom-ajustar').click();
    await pin(page, 'led2.IN').dragTo(pin(page, 'board.GPIO21'));
    await expect(cable(page, 'led2.IN', 'board.GPIO21')).toHaveCount(1);
  });

  test('no deja cablear a los pines que usa la simulación', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await expect(page.locator('#lienzo .pin[data-ref="board.GPIO17"] title')).toContainText('reservado');
    await expect(page.locator('#lienzo .pin[data-ref="board.GPIO0"] title')).toContainText('strapping');
    await cablear(page, 'btn1.OUT', 'board.GPIO17');
    await expect(page.locator('#nota')).toContainText('puente de simulación');
    await expect(page.locator('#lienzo .cable[data-to="board.GPIO17"]')).toHaveCount(0);
    await pin(page, 'board.GPIO43').click();
    await expect(page.locator('#nota')).toContainText('consola del emulador');
    await expect(page.locator('#lienzo .cable-temporal')).toHaveCount(0);
  });

  test('Escape cancela un cable a medio hacer', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await pin(page, 'led1.IN').click();
    await page.mouse.move(300, 300);
    await expect(page.locator('#lienzo .cable-temporal')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#lienzo .cable-temporal')).toHaveCount(0);
  });

  test('borrar un cable (click + Supr) y un módulo con sus cables', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    const p = await mitadDeCable(page, 'btn1.OUT', 'board.GPIO6');
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('#panel-modulo')).toContainText('Cable');
    await page.keyboard.press('Delete');
    await expect(cable(page, 'btn1.OUT', 'board.GPIO6')).toHaveCount(0);
    await expect(page.locator('#avisos-dibujo')).toContainText(/pin (GPIO)?6 pero ningún módulo/);

    await seleccionarModulo(page, 'led1');
    await page.locator('#insp-eliminar').click();
    await expect(modulo(page, 'led1')).toHaveCount(0);
    await expect(page.locator('#lienzo .cable[data-from^="led1."]')).toHaveCount(0);
    await page.reload();
    await expect(modulo(page, 'led1')).toHaveCount(0);
  });

  test('desconectar desde el panel del módulo', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await seleccionarModulo(page, 'led1');
    await page.locator('#panel-modulo .conexion', { hasText: 'GPIO7' }).locator('button.quitar').click();
    await expect(cable(page, 'led1.IN', 'board.GPIO7')).toHaveCount(0);
    await expect(page.locator('#panel-modulo .insp-pines')).toContainText('sin conectar');
  });
});

test.describe('Ley de Ohm', () => {
  test('agregar una resistencia arregla el aviso; bajarla demasiado avisa de nuevo', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    // El proyecto nuevo trae el LED directo al GPIO7, sin resistencia. Enchufada por USB, con la
    // resistencia interna del pin del S3 no se quema al instante, pero queda sobreexigido: el motor lo avisa.
    await page.locator('#usb').click();
    await expect(page.locator('#avisos-dibujo')).toContainText('resistencia en serie');

    // Lo saca del medio y mete una resistencia (220 Ω por defecto) en serie.
    const p = await mitadDeCable(page, 'led1.IN', 'board.GPIO7');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Delete');
    await page.locator('.modulo-card[data-type="resistor"]').click();
    await cablear(page, 'board.GPIO7', 'r1.1');
    await cablear(page, 'r1.2', 'led1.IN');
    await expect(page.locator('#avisos-dibujo')).not.toContainText('resistencia en serie');
    await expect(page.locator('#avisos-dibujo div')).toHaveCount(0);

    // La baja mucho (10 Ω): sumada a la resistencia interna del pin, pasa lo recomendado (20 mA).
    await seleccionarModulo(page, 'r1');
    await page.locator('#panel-modulo input[data-prop="ohms"]').fill('10');
    await page.locator('#panel-modulo input[data-prop="ohms"]').blur();
    await expect(page.locator('#avisos-dibujo')).toContainText('mA');
    await expect(page.locator('#avisos-dibujo')).toContainText('recomendado (20 mA)');

    // La vuelve a subir: el aviso se va.
    await page.locator('#panel-modulo input[data-prop="ohms"]').fill('220');
    await page.locator('#panel-modulo input[data-prop="ohms"]').blur();
    await expect(page.locator('#avisos-dibujo div')).toHaveCount(0);
  });
});

test.describe('propiedades y controles', () => {
  test('cambiar el color del LED queda guardado', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await seleccionarModulo(page, 'led1');
    await page.locator('#panel-modulo select[data-prop="color"]').selectOption('green');
    await page.waitForResponse((r) => r.url().includes('/diagram') && r.ok());
    await page.reload();
    await seleccionarModulo(page, 'led1');
    await expect(page.locator('#panel-modulo select[data-prop="color"]')).toHaveValue('green');
  });

  test('sin simulación, los controles piden ejecutar', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await modulo(page, 'btn1').locator('.ctrl').click();
    await expect(page.locator('#nota')).toContainText('Ejecutar');
    await expect(page.locator('#panel-modulo')).toContainText('Pulsador');
  });

  test('el panel del módulo tiene un botón para "apretarlo", no solo el dibujo chico', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await expect(page.locator('#badge-modo')).toBeHidden();
    await seleccionarModulo(page, 'btn1');
    const boton = page.locator('#panel-modulo .btn-accionar');
    await expect(boton).toHaveText('Mantener presionado');
    await expect(page.locator('#panel-modulo .insp-control')).toHaveClass(/deshabilitado/);
    await expect(page.locator('#panel-modulo')).toContainText('Apretá ▶ Ejecutar');
    await boton.click();
    await expect(page.locator('#nota')).toContainText('Ejecutar');

    // Un control remoto (inalámbrico) muestra sus 4 botones A-D.
    await page.locator('.modulo-card[data-type="remote-433"]').click();
    const botones = page.locator('#panel-modulo .botonera-remoto .btn-accionar');
    await expect(botones).toHaveText(['A', 'B', 'C', 'D']);
  });

  test('sin la simulación corriendo, el control del circuito no brilla (solo cuando hay algo para tocar)', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    await expect(modulo(page, 'btn1').locator('.ctrl')).toHaveCSS('animation-name', 'none');
  });
});

test.describe('paneles', () => {
  test('el separador redimensiona el catálogo', async ({ page, request }) => {
    await abrirProyectoNuevo(page, request);
    const antes = (await page.locator('.paleta').boundingBox())!.width;
    const sep = (await page.locator('[data-resize="izq"]').boundingBox())!;
    await page.mouse.move(sep.x + 3, sep.y + 200);
    await page.mouse.down();
    await page.mouse.move(sep.x + 83, sep.y + 200, { steps: 4 });
    await page.mouse.up();
    expect((await page.locator('.paleta').boundingBox())!.width).toBeGreaterThan(antes + 60);
  });
});
