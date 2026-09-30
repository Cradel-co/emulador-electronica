import { describe, expect, it } from 'vitest';
import { diffDiagramVsCode, scanPins } from './pinScan.js';
import type { Project } from '@emu/shared';

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
  sim: { wifiSsid: 'a', wifiPassword: 'b' },
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
