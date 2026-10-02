import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { modulo, seleccionarModulo } from './helpers';

/**
 * Un BME280 (módulo de Adafruit) cableado al I2C de un Arduino Uno: el panel muestra el chip y
 * los controles de su entorno; con E2E_EMU=1 además se compila con la librería de Adafruit (se
 * instala sola), corre el firmware real y el entorno movido desde la UI llega al programa.
 */

const SKETCH = `#include <Wire.h>
#include <Adafruit_BME280.h>
Adafruit_BME280 bme;
void setup() {
  Serial.begin(115200);
  if (!bme.begin(0x77)) { Serial.println("BME280 no encontrado"); while (1) delay(10); }
  Serial.println("BME280 OK");
}
void loop() {
  Serial.print("T="); Serial.println(bme.readTemperature(), 2);
  delay(250);
}
`;

async function proyectoConBme(page: Page, request: APIRequestContext): Promise<string> {
  const name = `e2e-chips-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, language: 'arduino', board: 'arduino-uno' } })).ok()).toBeTruthy();
  const { project } = await (await request.get(`/api/projects/${name}`)).json();
  // La placa con el USB conectado (si no, ▶ no arranca: "sin alimentación", como en la vida real).
  const placa = project.modules.find((m: { id: string }) => m.id === 'board');
  const modules = [{ ...placa, props: { ...placa.props, usb: true } }, { id: 'bme1', type: 'bme280-adafruit', x: 760, y: 120, props: {} }];
  const wires = [
    { from: 'bme1.VIN', to: 'board.5V' }, { from: 'bme1.GND', to: 'board.GND' },
    { from: 'bme1.SCK', to: 'board.A5' }, { from: 'bme1.SDI', to: 'board.A4' },
  ];
  expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules, wires } })).ok()).toBeTruthy();
  expect((await request.put(`/api/projects/${name}/files/sketch.cpp`, { data: { content: SKETCH } })).ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await expect(page.locator('#proyecto')).toHaveValue(name);
  await expect(modulo(page, 'bme1')).toBeVisible();
  return name;
}

test('el panel del BME280 muestra el chip, su entorno y lo que no se emula', async ({ page, request }) => {
  const name = await proyectoConBme(page, request);
  await seleccionarModulo(page, 'bme1');
  const panel = page.locator('#panel-modulo');
  await expect(panel).toContainText('Con chip');
  await expect(panel).toContainText('BME280');
  await expect(panel).toContainText('Bosch Sensortec');
  await expect(panel).toContainText('BST-BME280-DS001');
  await expect(panel.locator('[data-entorno]')).toHaveCount(3);
  await expect(panel.locator('[data-entorno="temperatura"]')).toHaveValue('22');
  await expect(panel.locator('details.insp-limites')).toContainText('Qué no se emula');
  // 3VO es la salida del regulador: no se pide cablearla. Y Wire usa A4/A5: no son pines "sin usar".
  await expect(panel).not.toContainText('Sin alimentación');
  await expect(page.locator('#avisos-dibujo')).not.toContainText('que el código no usa');
  await page.screenshot({ path: 'test-results/chips-panel.png' });
  await panel.locator('details.insp-limites').evaluate((d) => { (d as HTMLDetailsElement).open = true; d.scrollIntoView(); });
  await panel.screenshot({ path: 'test-results/chips-panel-entorno.png' });

  // Mover el control guarda el entorno en el proyecto (sin simulación corriendo).
  await panel.locator('[data-entorno-num="temperatura"]').fill('31.5');
  await panel.locator('[data-entorno-num="temperatura"]').press('Enter');
  await expect.poll(async () => (await (await request.get(`/api/projects/${name}/chips`)).json()).chips[0].entorno.temperatura).toBe(31.5);
  await expect(panel.locator('[data-entorno="temperatura"]')).toHaveValue('31.5');

  // Fuera de rango, la API lo rechaza con el rango de la hoja.
  const malo = await request.put(`/api/projects/${name}/modules/bme1/entorno`, { data: { valores: { temperatura: 200 } } });
  expect(malo.status()).toBe(400);
  expect((await malo.json()).error).toMatch(/-40 a 85/);
});

test('con la simulación: compila con la librería de Adafruit, lee el entorno y lo sigue en vivo', async ({ page, request }) => {
  test.skip(!process.env.E2E_EMU, 'necesita Docker: correr con E2E_EMU=1');
  test.setTimeout(10 * 60_000);
  await proyectoConBme(page, request);
  await page.locator('#ejecutar').click();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge', { timeout: 9 * 60_000 });
  await page.locator('.consola-tabs [data-tab="emu"]').click();
  const consola = page.locator('#consola');
  await expect(consola).toContainText('BME280 OK', { timeout: 30_000 });
  await expect(consola).toContainText('T=22.0', { timeout: 30_000 });

  await seleccionarModulo(page, 'bme1');
  const num = page.locator('#panel-modulo [data-entorno-num="temperatura"]');
  await num.fill('-7.3');
  await num.press('Enter');
  await expect(consola).toContainText('T=-7.3', { timeout: 30_000 });
  await page.screenshot({ path: 'test-results/chips-corriendo.png' });
  await page.locator('#parar').click();
});

const SKETCH_OLED = `#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
void setup() {
  Serial.begin(115200);
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { Serial.println("sin pantalla"); while (1) delay(10); }
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(2);
  oled.setCursor(4, 4);
  oled.print("Hola!");
  oled.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  oled.fillCircle(100, 40, 12, SSD1306_WHITE);
  oled.display();
  Serial.println("listo");
}
void loop() {}
`;

test('pantalla OLED SSD1306: el dibujo muestra lo que dibuja el programa', async ({ page, request }) => {
  test.skip(!process.env.E2E_EMU, 'necesita Docker: correr con E2E_EMU=1');
  test.setTimeout(10 * 60_000);
  const name = `e2e-oled-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, language: 'arduino', board: 'arduino-uno' } })).ok()).toBeTruthy();
  const { project } = await (await request.get(`/api/projects/${name}`)).json();
  const placa = project.modules.find((m: { id: string }) => m.id === 'board');
  const modules = [{ ...placa, props: { ...placa.props, usb: true } }, { id: 'oled1', type: 'oled-ssd1306-128x64', x: 760, y: 80, props: { color: 'amarillo-azul' } }];
  const wires = [
    { from: 'oled1.VCC', to: 'board.5V' }, { from: 'oled1.GND', to: 'board.GND' },
    { from: 'oled1.SCL', to: 'board.A5' }, { from: 'oled1.SDA', to: 'board.A4' },
  ];
  expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules, wires } })).ok()).toBeTruthy();
  expect((await request.put(`/api/projects/${name}/files/sketch.cpp`, { data: { content: SKETCH_OLED } })).ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await expect(modulo(page, 'oled1')).toBeVisible();
  // Sin simulación: el vidrio apagado, sin imagen.
  await expect(modulo(page, 'oled1').locator('image.pantalla-chip')).not.toHaveAttribute('href', /.+/);
  await page.locator('#ejecutar').click();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge', { timeout: 9 * 60_000 });
  await page.locator('.consola-tabs [data-tab="emu"]').click();
  await expect(page.locator('#consola')).toContainText('listo', { timeout: 30_000 });
  await expect(modulo(page, 'oled1').locator('image.pantalla-chip')).toHaveAttribute('href', /^data:image\/png/, { timeout: 10_000 });
  await modulo(page, 'oled1').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/oled-corriendo.png' });
  await modulo(page, 'oled1').screenshot({ path: 'test-results/oled-modulo.png' });
  await page.locator('#parar').click();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'stopped', { timeout: 15_000 });
  // Sin alimentación la pantalla se apaga.
  await expect(modulo(page, 'oled1').locator('image.pantalla-chip')).not.toHaveAttribute('href', /.+/);
});

const SKETCH_TFT = `#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <SPI.h>
Adafruit_ST7735 tft(10, 9, 8);
void setup() {
  Serial.begin(115200);
  tft.initR(INITR_BLACKTAB);
  tft.fillScreen(ST77XX_BLACK);
  tft.fillRect(0, 0, 128, 40, ST77XX_RED);
  tft.fillRect(0, 40, 128, 40, ST77XX_GREEN);
  tft.fillRect(0, 80, 128, 40, ST77XX_BLUE);
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(2);
  tft.setCursor(8, 130);
  tft.print("Hola TFT");
  Serial.println("listo");
}
void loop() {}
`;

test('pantalla TFT ST7735 por SPI: el dibujo muestra los colores que pinta el programa', async ({ page, request }) => {
  test.skip(!process.env.E2E_EMU, 'necesita Docker: correr con E2E_EMU=1');
  test.setTimeout(10 * 60_000);
  const name = `e2e-tft-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, language: 'arduino', board: 'arduino-uno' } })).ok()).toBeTruthy();
  const { project } = await (await request.get(`/api/projects/${name}`)).json();
  const placa = project.modules.find((m: { id: string }) => m.id === 'board');
  const modules = [{ ...placa, props: { ...placa.props, usb: true } }, { id: 'tft1', type: 'tft-st7735-128x160', x: 760, y: 60, props: {} }];
  const wires = [
    { from: 'tft1.VCC', to: 'board.5V' }, { from: 'tft1.GND', to: 'board.GND' }, { from: 'tft1.LED', to: 'board.3V3' },
    { from: 'tft1.SCK', to: 'board.D13' }, { from: 'tft1.SDA', to: 'board.D11' },
    { from: 'tft1.CS', to: 'board.D10' }, { from: 'tft1.A0', to: 'board.D9' }, { from: 'tft1.RESET', to: 'board.D8' },
  ];
  expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules, wires } })).ok()).toBeTruthy();
  expect((await request.put(`/api/projects/${name}/files/sketch.cpp`, { data: { content: SKETCH_TFT } })).ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await expect(modulo(page, 'tft1')).toBeVisible();
  // SPI.h y los pines del constructor (10, 9, 8) cuentan como usados: sin avisos de pines sueltos.
  await expect(page.locator('#avisos-dibujo')).not.toContainText('que el código no usa');
  await page.locator('#ejecutar').click();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge', { timeout: 9 * 60_000 });
  await page.locator('.consola-tabs [data-tab="emu"]').click();
  // initR tarda ~1,2 s de emulación (resets y SLPOUT): "listo" sale después ("puente listo" no cuenta).
  await expect(page.locator('#consola')).toContainText(/^listo$/m, { timeout: 60_000 });
  const img = modulo(page, 'tft1').locator('image.pantalla-chip');
  // Los colores de las tres franjas, leídos de la imagen que puso la app.
  const leer = () => img.evaluate(async (el) => {
    const im = new Image();
    im.src = el.getAttribute('href')!;
    await im.decode();
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const g = c.getContext('2d')!;
    g.drawImage(im, 0, 0);
    const px = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { tam: [im.width, im.height], rojo: px(64, 20), verde: px(64, 60), azul: px(64, 100) };
  });
  await expect.poll(async () => (await leer()).azul[2], { timeout: 10_000 }).toBeGreaterThan(200);
  const colores = await leer();
  expect(colores.tam).toEqual([128, 160]);
  expect(colores.rojo[0]).toBeGreaterThan(200);
  expect(colores.rojo[1]! + colores.rojo[2]!).toBeLessThan(30);
  expect(colores.verde[1]).toBeGreaterThan(200);
  expect(colores.azul[2]).toBeGreaterThan(200);
  await modulo(page, 'tft1').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/tft-corriendo.png' });
  await modulo(page, 'tft1').screenshot({ path: 'test-results/tft-modulo.png' });
  await page.locator('#parar').click();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'stopped', { timeout: 15_000 });
});

const MAIN_PY_BME = `from machine import I2C, Pin
import utime
i2c = I2C(0, scl=Pin(5), sda=Pin(4), freq=400000)
print('scan', [hex(a) for a in i2c.scan()])
print('id', hex(i2c.readfrom_mem(0x77, 0xD0, 1)[0]))
c = i2c.readfrom_mem(0x77, 0x88, 6)
T1 = c[0] | c[1] << 8
T2 = c[2] | c[3] << 8
T3 = c[4] | c[5] << 8
T2 = T2 - 65536 if T2 > 32767 else T2
T3 = T3 - 65536 if T3 > 32767 else T3
while True:
    i2c.writeto_mem(0x77, 0xF4, bytes([0x21]))  # temperatura x1, forzado
    utime.sleep_ms(10)
    d = i2c.readfrom_mem(0x77, 0xFA, 3)
    adc = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4)
    v1 = (((adc >> 3) - (T1 << 1)) * T2) >> 11
    v2 = (((((adc >> 4) - T1) * ((adc >> 4) - T1)) >> 12) * T3) >> 14
    print('T=%.2f' % ((((v1 + v2) * 5 + 128) >> 8) / 100))
    utime.sleep_ms(300)
`;

test('ESP32 con MicroPython: machine.I2C le habla al BME280 del dibujo (cualquier par de pines) y sigue el entorno', async ({ page, request }) => {
  test.skip(!process.env.E2E_EMU, 'necesita esp-emu: correr con E2E_EMU=1');
  test.setTimeout(10 * 60_000);
  const name = `e2e-mpy-bme-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, language: 'micropython', board: 'esp32-s3-devkitc-1' } })).ok()).toBeTruthy();
  const { project } = await (await request.get(`/api/projects/${name}`)).json();
  const placa = project.modules.find((m: { id: string }) => m.id === 'board');
  const modules = [{ ...placa, props: { ...placa.props, usb: true } }, { id: 'bme1', type: 'bme280-adafruit', x: 760, y: 120, props: {} }];
  const wires = [
    { from: 'bme1.VIN', to: 'board.3V3' }, { from: 'bme1.GND', to: 'board.GND' },
    { from: 'bme1.SCK', to: 'board.GPIO5' }, { from: 'bme1.SDI', to: 'board.GPIO4' },
  ];
  expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules, wires } })).ok()).toBeTruthy();
  expect((await request.put(`/api/projects/${name}/files/main.py`, { data: { content: MAIN_PY_BME } })).ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await expect(modulo(page, 'bme1')).toBeVisible();
  await page.locator('#ejecutar').click();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge', { timeout: 9 * 60_000 });
  await page.locator('.consola-tabs [data-tab="emu"]').click();
  const consola = page.locator('#consola');
  await expect(consola).toContainText("scan ['0x77']", { timeout: 60_000 });
  await expect(consola).toContainText('id 0x60');
  await expect(consola).toContainText('T=22.0', { timeout: 30_000 });

  await seleccionarModulo(page, 'bme1');
  const num = page.locator('#panel-modulo [data-entorno-num="temperatura"]');
  await num.fill('31.5');
  await num.press('Enter');
  await expect(consola).toContainText('T=31.5', { timeout: 30_000 });
  await page.screenshot({ path: 'test-results/mpy-bme-corriendo.png' });
  await page.locator('#parar').click();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'stopped', { timeout: 15_000 });
});

const MAIN_PY_TFT = `from machine import SPI, Pin
import utime
spi = SPI(1, baudrate=10000000, polarity=0, phase=0, sck=Pin(12), mosi=Pin(11))
cs = Pin(10, Pin.OUT, value=1)
dc = Pin(9, Pin.OUT, value=0)
rst = Pin(8, Pin.OUT, value=1)
def cmd(c, datos=b''):
    cs.off()
    dc.off()
    spi.write(bytes([c]))
    if datos:
        dc.on()
        spi.write(datos)
    cs.on()
rst(0); utime.sleep_ms(10); rst(1); utime.sleep_ms(120)
cmd(0x11); utime.sleep_ms(120)
cmd(0x3A, b'\\x05'); cmd(0x36, b'\\xC0'); cmd(0x29)
def franja(y0, y1, color):
    cmd(0x2A, bytes([0, 0, 0, 127])); cmd(0x2B, bytes([0, y0, 0, y1]))
    cmd(0x2C, bytes([color >> 8, color & 0xFF]) * (128 * (y1 - y0 + 1)))
t = utime.ticks_ms()
franja(0, 52, 0xF800); franja(53, 105, 0x07E0); franja(106, 159, 0x001F)
print('pintado en', utime.ticks_diff(utime.ticks_ms(), t), 'ms')
`;

test('ESP32 con MicroPython: machine.SPI + Pin para CS/DC/RST manejan la TFT ST7735 del dibujo', async ({ page, request }) => {
  test.skip(!process.env.E2E_EMU, 'necesita esp-emu: correr con E2E_EMU=1');
  test.setTimeout(10 * 60_000);
  const name = `e2e-mpy-tft-${Date.now().toString(36)}`;
  expect((await request.post('/api/projects', { data: { name, language: 'micropython', board: 'esp32-s3-devkitc-1' } })).ok()).toBeTruthy();
  const { project } = await (await request.get(`/api/projects/${name}`)).json();
  const placa = project.modules.find((m: { id: string }) => m.id === 'board');
  const modules = [{ ...placa, props: { ...placa.props, usb: true } }, { id: 'tft1', type: 'tft-st7735-128x160', x: 760, y: 60, props: {} }];
  const wires = [
    { from: 'tft1.VCC', to: 'board.3V3' }, { from: 'tft1.GND', to: 'board.GND' }, { from: 'tft1.LED', to: 'board.3V3' },
    { from: 'tft1.SCK', to: 'board.GPIO12' }, { from: 'tft1.SDA', to: 'board.GPIO11' },
    { from: 'tft1.CS', to: 'board.GPIO10' }, { from: 'tft1.A0', to: 'board.GPIO9' }, { from: 'tft1.RESET', to: 'board.GPIO8' },
  ];
  expect((await request.put(`/api/projects/${name}/diagram`, { data: { modules, wires } })).ok()).toBeTruthy();
  expect((await request.put(`/api/projects/${name}/files/main.py`, { data: { content: MAIN_PY_TFT } })).ok()).toBeTruthy();
  await page.goto(`/#${name}`);
  await page.locator('#ejecutar').click();
  await expect(page.locator('#estado')).toHaveAttribute('data-s', 'bridge', { timeout: 9 * 60_000 });
  await page.locator('.consola-tabs [data-tab="emu"]').click();
  await expect(page.locator('#consola')).toContainText('pintado en', { timeout: 120_000 });
  const img = modulo(page, 'tft1').locator('image.pantalla-chip');
  const leer = () => img.evaluate(async (el) => {
    const im = new Image();
    im.src = el.getAttribute('href') ?? '';
    await im.decode();
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const g = c.getContext('2d')!;
    g.drawImage(im, 0, 0);
    const px = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { rojo: px(64, 20), verde: px(64, 80), azul: px(64, 140) };
  }).catch(() => null);
  await expect.poll(async () => (await leer())?.azul[2] ?? 0, { timeout: 15_000 }).toBeGreaterThan(200);
  const c = (await leer())!;
  expect(c.rojo[0]).toBeGreaterThan(200);
  expect(c.verde[1]).toBeGreaterThan(200);
  await modulo(page, 'tft1').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/mpy-tft-corriendo.png' });
  console.log((await page.locator('#consola').innerText()).split('\n').filter((l) => /pintado|chips|spi/.test(l)).join('\n'));
  await page.locator('#parar').click();
});
