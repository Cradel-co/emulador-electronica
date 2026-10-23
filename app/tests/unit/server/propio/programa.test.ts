import { describe, expect, it } from 'vitest';
import { compilarProgramaPropio, EjecutorProgramaPropio } from '../../../../server/src/propio/programa.js';
import { micropythonMainPara } from '../../../../server/src/templates/languages.js';

describe('programa funcional propio, sin ejecutar Python/JS del host', () => {
  it('ejecuta la plantilla existente del editor con entradas reales entregadas por el adaptador', () => {
    let entrada: 0 | 1 | null = 1; const salidas: unknown[] = [], logs: string[] = [];
    const p = compilarProgramaPropio(micropythonMainPara(6, 7));
    expect(p.pines).toEqual([{ gpio: 6, salida: false, pull: 'up' }, { gpio: 7, salida: true }]);
    const e = new EjecutorProgramaPropio(p, { leer: () => entrada, escribir: (p, n) => salidas.push([p, n]), log: l => logs.push(l) }, new Set([6, 7]));
    expect(e.avanzar()).toMatchObject({ esperaMs: 50, terminado: false }); expect(salidas.at(-1)).toEqual([7, 0]);
    entrada = 0; e.avanzar(); expect(salidas.at(-1)).toEqual([7, 1]); expect(logs).toContain('Boton PRESIONADO -> LED 1');
    entrada = null; expect(() => e.avanzar()).toThrow(/GPIO6.*X/);
  });
  it('compila constantes, blink, condicionales, on/off y temporización sin reevaluar imports', () => {
    const p = compilarProgramaPropio('from machine import Pin\nfrom time import sleep_ms\nLED = 7\nled = Pin(LED, Pin.OUT)\nwhile True:\n    led.value(not led.value())\n    sleep_ms(100)\n');
    const salidas: number[] = [], e = new EjecutorProgramaPropio(p, { leer: () => null, escribir: (_, n) => salidas.push(n), log() {} }, new Set([7]));
    expect(e.avanzar().esperaMs).toBe(100); expect(salidas).toEqual([0, 1]);
    e.avanzar(); expect(salidas.at(-1)).toBe(0);
  });
  it('resuelve if/elif/else, break, continue, aritmética y booleanos', () => {
    const logs: string[] = [];
    const p = compilarProgramaPropio('n = 0\nwhile True:\n    n = n + 1\n    if n == 1:\n        continue\n    elif n == 2:\n        print(2)\n    else:\n        break\nprint(True == 1)\n');
    const e = new EjecutorProgramaPropio(p, { leer: () => null, escribir() {}, log: l => logs.push(l) }, new Set());
    expect(e.avanzar().terminado).toBe(true); expect(logs).toEqual(['2', 'True']);
  });
  it.each([
    'import os\nos.system("pwd")', 'from machine import PWM', 'for i in range(3):\n    print(i)',
    'def f():\n    pass', 'x = [1, 2]', 'x = 1\nimport time',
    'from machine import Pin\nwhile True:\n    p = Pin(6, Pin.OUT)',
    'from machine import Pin\na = Pin(7, Pin.OUT)\nb = Pin(7, Pin.IN)',
    'if True\n    pass',
  ])('rechaza construcciones no soportadas con línea de main.py: %s', fuente => expect(() => compilarProgramaPropio(fuente)).toThrow(/main.py:\d+/));
  it.each(['while True:\n    pass', 'import time\ntime.sleep_ms(0)', 'import time\ntime.sleep_ms(1)', 'x = 1 / 0', 'print(open("archivo"))'])('limita el trabajo y rechaza accesos externos: %s', fuente => {
    const e = new EjecutorProgramaPropio(compilarProgramaPropio(fuente), { leer: () => null, escribir() {}, log() {} }, new Set());
    expect(() => e.avanzar()).toThrow(/main.py:\d+/);
  });
});
