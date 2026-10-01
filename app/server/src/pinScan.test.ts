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
  it('con Wire (o una librería que lo incluye) cuenta A4/A5 del bus del Uno', () => {
    expect(scanPins('arduino', '#include <Wire.h>\n#include <Adafruit_BME280.h>\nvoid setup(){}', uno)).toEqual([18, 19]);
    expect(scanPins('arduino', 'void setup(){ Wire.begin(); }', uno)).toEqual([18, 19]);
  });
  it('sin Wire no (y un Wire comentado tampoco)', () => {
    expect(scanPins('arduino', 'void setup(){ pinMode(13, OUTPUT); }', uno)).toEqual([13]);
    expect(scanPins('arduino', '// #include <Wire.h>\nvoid setup(){}', uno)).toEqual([]);
  });
});
