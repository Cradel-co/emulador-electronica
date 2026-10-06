import { describe, expect, it } from 'vitest';
import { diffDiagramVsCode, direccionesDeCodigo, scanPins } from './pinScan.js';
import { esphomeMainYamlPara } from './templates/esphome.js';
import { arduinoSketchPara, idfCMainCPara, idfCMainCppPara, micropythonMainPara } from './templates/languages.js';
import { readFileSync } from 'node:fs';
import { BoardDescriptorSchema, type Project } from '@emu/shared';

const project = {
  schemaVersion: 1 as const,
  name: 'p',
  board: 'esp32-s3-devkitc-1' as const,
  language: 'esphome' as const,
  modules: [],
  wires: [
    { from: 'board.6', to: 'module:boton:SIGNAL' },
    { from: 'board.7', to: 'module:led:IN' },
  ],
  sim: { wifiSsid: 'a', wifiPassword: 'b', autoReload: false },
} satisfies Project;

describe('scanPins', () => {
  it('lee number: GPIO6 del YAML de ESPHome', () => {
    expect(scanPins('esphome', '    pin:\n      number: GPIO6\n')).toContain(6);
  });

  it('lee GPIO_NUM_7 y gpio_set_level de C', () => {
    const pins = scanPins('idf-c', 'gpio_config(GPIO_NUM_7); gpio_set_level(GPIO_NUM_7, 1);');
    expect(pins).toContain(7);
  });

  it('lee digitalWrite de Arduino', () => {
    expect(scanPins('arduino', 'void loop(){ digitalWrite(7, digitalRead(6)); }').sort()).toEqual([6, 7]);
  });

  it('lee Pin(6) y Pin("GPIO7") de MicroPython', () => {
    expect(scanPins('micropython', 'b=Pin(6, Pin.IN)\nl=Pin("GPIO7", Pin.OUT)').sort()).toEqual([6, 7]);
  });

  it('no se cuelga con un archivo grande y no inventa pines imposibles', () => {
    const big = 'pin:\n  number: GPIO6\n'.repeat(2000) + '  number: 99\n';
    expect(scanPins('esphome', big)).toEqual([6]);
  });
});

describe('diffDiagramVsCode', () => {
  it('avisa de un pin del código sin módulo en el dibujo', () => {
    const w = diffDiagramVsCode(project, [6, 7, 4]);
    expect(w.map((x) => x.kind)).toContain('code-pin-unwired');
    expect(w.find((x) => x.pin === 4)!.message).toContain('pin GPIO4');
  });

  it('avisa de un módulo cableado a un pin que el código no usa', () => {
    const w = diffDiagramVsCode(project, [6]);
    expect(w.map((x) => x.kind)).toContain('module-pin-unused');
    expect(w.find((x) => x.pin === 7)).toBeTruthy();
  });

  it('no avisa cuando el dibujo y el código coinciden', () => {
    expect(diffDiagramVsCode(project, [6, 7])).toEqual([]);
  });

  it('entiende el formato de cable de la guía (btn1.OUT → board.GPIO6)', () => {
    const conGuia = {
      ...project,
      wires: [
        { from: 'btn1.OUT', to: 'board.GPIO6' },
        { from: 'led1.IN', to: 'board.GPIO7' },
        { from: 'rx1.VCC', to: 'board.5V' },
      ],
    } satisfies Project;
    expect(diffDiagramVsCode(conGuia, [6, 7])).toEqual([]);
  });
});

describe('direccionesDeCodigo: cómo configura el programa cada pin', () => {
  const sale = { salida: true };
  const pullUp = { salida: false, pull: 'up' };

  it('ESPHome: la plantilla (output: → salida; binary_sensor con pullup → entrada con pull-up)', () => {
    const d = direccionesDeCodigo('esphome', esphomeMainYamlPara('esp32-s3-devkitc-1', 6, 7));
    expect(d.get(7)).toEqual(sale);
    expect(d.get(6)).toEqual(pullUp);
  });

  it('ESPHome: switch/light gpio son salidas; pin escalar, mode en texto, pulldown', () => {
    const yaml = `
switch:
  - platform: gpio
    pin: GPIO10
light:
  - platform: binary
    output: x
binary_sensor:
  - platform: gpio
    pin:
      number: 4
      mode: INPUT_PULLDOWN
  - platform: gpio
    pin: GPIO5
`;
    const d = direccionesDeCodigo('esphome', yaml);
    expect(d.get(10)).toEqual(sale);
    expect(d.get(4)).toEqual({ salida: false, pull: 'down' });
    expect(d.get(5)).toEqual({ salida: false });
  });

  it('MicroPython: la plantilla (simbridge.pin = entrada que reposa en 1) y Pin(n, Pin.OUT/IN, PULL_*)', () => {
    const d = direccionesDeCodigo('micropython', micropythonMainPara(6, 7));
    expect(d.get(7)).toEqual(sale);
    expect(d.get(6)).toEqual(pullUp);
    const d2 = direccionesDeCodigo('micropython', 'a = machine.Pin(4, machine.Pin.IN)\nb = Pin(5, Pin.IN, Pin.PULL_DOWN)\nc = Pin(8, mode=Pin.OUT)');
    expect(d2.get(4)).toEqual({ salida: false });
    expect(d2.get(5)).toEqual({ salida: false, pull: 'down' });
    expect(d2.get(8)).toEqual(sale);
  });

  it('Arduino: la plantilla y pinMode con constantes (#define / const int)', () => {
    const d = direccionesDeCodigo('arduino', arduinoSketchPara(6, 7));
    expect(d.get(7)).toEqual(sale);
    expect(d.get(6)).toEqual(pullUp);
    const sketch = '#define BOTON 2\nconst int LED = 13;\nvoid setup() { pinMode(BOTON, INPUT); pinMode(LED, OUTPUT); pinMode(A0, INPUT_PULLUP); }';
    const d2 = direccionesDeCodigo('arduino', sketch);
    expect(d2.get(2)).toEqual({ salida: false });
    expect(d2.get(13)).toEqual(sale);
    expect(d2.get(14)).toEqual(pullUp); // A0 = 14 en el Uno
  });

  it('ESP-IDF (C y C++): gpio_config_t de la plantilla, gpio_set_direction y gpio_set_pull_mode', () => {
    for (const codigo of [idfCMainCPara(6, 7), idfCMainCppPara(6, 7)]) {
      const d = direccionesDeCodigo('idf-c', codigo);
      expect(d.get(7)).toEqual(sale);
      expect(d.get(6)).toEqual(pullUp);
    }
    const c = 'gpio_set_direction(GPIO_NUM_4, GPIO_MODE_OUTPUT);\ngpio_set_direction(5, GPIO_MODE_INPUT);\ngpio_set_pull_mode(GPIO_NUM_5, GPIO_PULLDOWN_ONLY);';
    const d2 = direccionesDeCodigo('idf-c', c);
    expect(d2.get(4)).toEqual(sale);
    expect(d2.get(5)).toEqual({ salida: false, pull: 'down' });
  });

  it('un pin que el código no configura no aparece (se deduce de otra forma)', () => {
    expect(direccionesDeCodigo('arduino', 'void setup() { digitalWrite(7, HIGH); }').has(7)).toBe(false);
  });
});

/**
 * Caso real: en la plantilla de MicroPython se comenta el LED para probar solo el botón.
 * Los avisos salían justo al revés — "usa GPIO7" (la línea comentada) y "GPIO6 no lo usa
 * el código" (el `simbridge.pin(6)` que scanPins no miraba).
 */
describe('código comentado y simbridge.pin', () => {
  const soloBoton = [
    'import time',
    '#from machine import Pin',
    'import simbridge',
    '',
    'boton = simbridge.pin(6)',
    '#led = Pin(7, Pin.OUT)',
    '',
    'while True:',
    '    presionado = boton.value() == 0',
    '    #led.value(1 if presionado else 0)',
    '    time.sleep_ms(50)',
  ].join('\n');

  it('simbridge.pin(6) cuenta como uso del pin', () => {
    expect(scanPins('micropython', soloBoton)).toContain(6);
  });

  it('un Pin() comentado no cuenta', () => {
    expect(scanPins('micropython', soloBoton)).not.toContain(7);
    expect(scanPins('micropython', soloBoton)).toEqual([6]);
  });

  it('no avisa que el código no usa el pin del botón', () => {
    const avisos = diffDiagramVsCode({ ...project, language: 'micropython' }, scanPins('micropython', soloBoton));
    expect(avisos.map((a) => a.message).join(' ')).not.toContain('GPIO6');
  });

  it('el LED comentado no queda como salida', () => {
    const dirs = direccionesDeCodigo('micropython', soloBoton);
    expect(dirs.get(7)).toBeUndefined();
    expect(dirs.get(6)).toMatchObject({ salida: false, pull: 'up' });
  });

  it('en C/C++ el # de las directivas sigue contando (no es un comentario)', () => {
    const c = ['#define PIN_LED 7', '// gpio_set_level(6, 1);', 'void app_main(){ gpio_set_level(PIN_LED, 1); }'].join('\n');
    const pines = scanPins('idf-c', c);
    expect(pines).toContain(7);
    expect(pines).not.toContain(6);
  });
});

describe('scanPins: el I2C usa SDA/SCL sin nombrarlos', () => {
  const uno = BoardDescriptorSchema.parse(JSON.parse(readFileSync(new URL('../../../modules/arduino-uno/module.json', import.meta.url), 'utf8')).board);
  it('con SPI.h cuenta SCK/MOSI/MISO del bus, y los pines que se le pasan al objeto de la librería', () => {
    const tft = '#include <SPI.h>\n#include <Adafruit_ST7735.h>\nAdafruit_ST7735 tft(10, 9, 8);\nvoid setup(){}';
    expect(scanPins('arduino', tft, uno)).toEqual([8, 9, 10, 11, 12, 13]);
    expect(scanPins('arduino', 'LiquidCrystal lcd(12, 11, 5, 4, 3, 2);', uno)).toEqual([2, 3, 4, 5, 11, 12]);
    // Tamaños y punteros no son pines.
    expect(scanPins('arduino', 'Adafruit_SSD1306 oled(128, 64, &Wire, -1);', uno)).toEqual([]);
  });

  it('una pantalla SPI sin MISO cableado no avisa de D12', () => {
    const p = { wires: [13, 11, 10, 9, 8].map((d) => ({ from: 'tft.X', to: `board.D${d}` })) } as unknown as Parameters<typeof diffDiagramVsCode>[0];
    expect(diffDiagramVsCode(p, [8, 9, 10, 11, 12, 13], uno)).toEqual([]);
  });

  it('con Wire (o una librería que lo incluye) cuenta A4/A5 del bus del Uno', () => {
    expect(scanPins('arduino', '#include <Wire.h>\n#include <Adafruit_BME280.h>\nvoid setup(){}', uno)).toEqual([18, 19]);
    expect(scanPins('arduino', 'void setup(){ Wire.begin(); }', uno)).toEqual([18, 19]);
  });
  it('sin Wire no (y un Wire comentado tampoco)', () => {
    expect(scanPins('arduino', 'void setup(){ pinMode(13, OUTPUT); }', uno)).toEqual([13]);
    expect(scanPins('arduino', '// #include <Wire.h>\nvoid setup(){}', uno)).toEqual([]);
  });

  it('los argumentos de un dispositivo I2C no son pines, aunque parezcan', () => {
    // 39 es la dirección (0x27), 16 y 2 son columnas y filas. Los tres tienen forma de pin, así
    // que pedir solo eso agregaba A2 y D2 y avisaba de pines sin cablear que nadie usa.
    expect(scanPins('arduino', '#include <Wire.h>\nLiquidCrystal_I2C lcd(39, 16, 2);', uno)).toEqual([18, 19]);
    // Lo que descarta la declaración es que 39 no es un pin del Uno: con el bus I2C aparte.
    expect(scanPins('arduino', 'LiquidCrystal_I2C lcd(39, 16, 2);', uno)).toEqual([]);
  });

  it('pero sí cuenta los pines cuando todos existen en la placa', () => {
    // El caso que la heurística quiere atrapar sigue funcionando.
    expect(scanPins('arduino', 'Adafruit_ST7735 tft(10, 9, 8);', uno)).toEqual([8, 9, 10]);
  });

  it('un pin del bus nombrado a mano, sin SPI, sigue avisando si no está cableado', () => {
    const vacio = { wires: [] } as unknown as Parameters<typeof diffDiagramVsCode>[0];
    // D12 es el MISO del Uno. Sin los otros dos pines del bus, lo nombró el programa: hay aviso.
    const avisos = diffDiagramVsCode(vacio, [12], uno);
    expect(avisos.map((a) => a.kind)).toContain('code-pin-unwired');
    // Y con los tres juntos (la firma de `SPI.h`) se exime, que es lo que se quería.
    const conBus = { wires: [13, 11].map((d) => ({ from: 'x.X', to: `board.D${d}` })) } as unknown as Parameters<typeof diffDiagramVsCode>[0];
    expect(diffDiagramVsCode(conBus, [11, 12, 13], uno).filter((a) => a.pin === 12)).toEqual([]);
  });
});

/**
 * MicroPython con constantes y periféricos. `scanPins` resolvía constantes solo en el camino de
 * Arduino AVR, así que un `PWM(Pin(GPIO_BUZZER))` —como el de la plantilla de la melodía— avisaba
 * "hay un módulo cableado al pin GPIO5 que el código no usa" siendo que sí lo usa.
 */
describe('scanPins en MicroPython: constantes y periféricos', () => {
  it('resuelve una constante de Python usada en Pin()', () => {
    expect(scanPins('micropython', 'GPIO_LED = 7\nl = Pin(GPIO_LED, Pin.OUT)')).toEqual([7]);
  });

  it('resuelve la constante de la plantilla de la melodía: PWM(Pin(CONSTANTE))', () => {
    const codigo = `from machine import PWM, Pin
GPIO_BUZZER = 5
buzzer = PWM(Pin(GPIO_BUZZER), freq=440, duty_u16=0)`;
    expect(scanPins('micropython', codigo)).toEqual([5]);
  });

  it('toma el GPIO cuando se le pasa un entero directo a PWM o a ADC', () => {
    expect(scanPins('micropython', 'p = PWM(5, freq=440)')).toEqual([5]);
    expect(scanPins('micropython', 'a = ADC(4)')).toEqual([4]);
  });

  it('resuelve una constante pasada directo a PWM, sin Pin()', () => {
    expect(scanPins('micropython', 'BZ = 9\np = PWM(BZ, freq=440)')).toEqual([9]);
  });

  it('una variable cualquiera no se vuelve un pin: solo cuenta si va a Pin, PWM o ADC', () => {
    expect(scanPins('micropython', 'duracion = 7\nvolumen = 9\nprint(duracion)')).toEqual([]);
  });

  it('una constante comentada no usa ningún pin', () => {
    expect(scanPins('micropython', 'GPIO_LED = 7\n# l = Pin(GPIO_LED, Pin.OUT)')).toEqual([]);
  });

  it('no inventa un pin que la placa no tiene', () => {
    expect(scanPins('micropython', 'X = 99\np = PWM(Pin(X))')).toEqual([]);
  });

  it('una constante que apunta a otra constante también se resuelve', () => {
    expect(scanPins('micropython', 'BASE = 5\nBZ = BASE\np = PWM(Pin(BZ))')).toEqual([5]);
  });
});
