import { describe, expect, it } from 'vitest';
import { checkMicroPythonSyntax, getMicroPythonCompletions } from '../../web/micropython-language.js';

function complete(source: string, explicit = false) {
  return getMicroPythonCompletions(source, source.length, explicit);
}
function labels(source: string) {
  return complete(source)?.options.map((option) => option.label) ?? [];
}

describe('autocompletado de MicroPython', () => {
  it('ofrece palabras clave y módulos con posición de reemplazo', () => {
    const result = complete('mach');
    expect(result?.from).toBe(0);
    expect(result?.options.some((option) => option.label === 'machine')).toBe(true);
    expect(labels('ret')).toContain('return');
    expect(complete('')).toBeNull();
    expect(complete('', true)?.options.length).toBeGreaterThan(0);
  });

  it.each([
    ['machine.', 'Pin'], ['network.', 'WLAN'], ['time.', 'sleep_ms'],
    ['esp32.', 'RMT'], ['neopixel.', 'NeoPixel'], ['dht.', 'DHT22'],
    ['onewire.', 'OneWire'], ['umqtt.', 'simple'], ['umqtt.simple.', 'MQTTClient'],
  ])('ofrece miembros del módulo %s', (source, member) => {
    expect(labels(source)).toContain(member);
  });

  it('reconoce alias de módulos y reemplaza solamente el miembro parcial', () => {
    const source = 'import machine as hw, time as clock\nhw.Pi';
    expect(complete(source)?.from).toBe(source.length - 2);
    expect(labels(source)).toContain('Pin');
    expect(labels('import machine as hw, time as clock\nclock.')).toContain('ticks_diff');
  });

  it('completa imports directos, clases importadas y sus alias', () => {
    expect(labels('from machine import Pi')).toContain('Pin');
    expect(labels('from machine import Pin, PW')).toContain('PWM');
    expect(labels('from machine import Pin as GPIO\nGPIO.')).toContain('OUT');
    expect(labels('from machine import (\n Pin as GPIO,\n PWM\n)\nGPIO.')).toContain('IRQ_RISING');
    expect(labels('from umqtt.simple import MQTTClient as Client\nClient.')).toContain('publish');
  });

  it('ofrece métodos en instancias de constructores reconocidos', () => {
    expect(labels('import machine as hw\nled = hw.Pin(2)\nled.')).toContain('value');
    expect(labels('from network import WLAN\nwlan = WLAN(0)\nwlan.')).toContain('connect');
    expect(labels('from umqtt.simple import MQTTClient\nclient = MQTTClient("esp32", "localhost")\nclient.')).toContain('subscribe');
  });

  it('no inventa métodos de objetos desconocidos', () => {
    expect(complete('unknown.')).toBeNull();
    expect(complete('x = custom()\nx.')).toBeNull();
  });

  it.each([
    '# machine.', 'text = "machine."', "text = 'machine.'", 'text = """machine.\nnetwork."""',
    'text = f"machine."',
  ])('no abre autocompletado dentro de comentarios/cadenas: %s', (source) => {
    const pos = source.startsWith('#') ? source.length : source.lastIndexOf('.') + 1;
    expect(getMicroPythonCompletions(source, pos, true)).toBeNull();
  });

  it('ignora imports escritos en comentarios y cadenas', () => {
    expect(complete('# import machine as fake\nfake.')).toBeNull();
    expect(complete('text = """\nimport machine as fake\n"""\nfake.')).toBeNull();
    expect(complete('text = "import machine as fake"\nfake.')).toBeNull();
  });

  it('procesa archivos largos con comentarios y strings manteniendo los offsets', () => {
    const source = 'import machine as hw\n' + 'text = "machine.Pin" # import machine as fake\n'.repeat(1500) + 'hw.P';
    expect(complete(source)?.from).toBe(source.length - 1);
    expect(labels(source)).toContain('Pin');
  });
});

describe('diagnóstico sintáctico local de Python', () => {
  it.each([
    'from machine import Pin\nled = Pin(2, Pin.OUT)\nwhile True:\n    led.value(1)\n',
    'def f(x):\n    return [i for i in range(x) if i % 2]\n',
    'message = "# no es un comentario"\nother = "comilla \\" y paréntesis ("\n',
    'text = """\nif True sin dos puntos\n"""\n# esto tampoco se analiza: def (\n',
  ])('acepta sintaxis válida sin backend', (source) => {
    expect(checkMicroPythonSyntax(source)).toEqual([]);
  });

  it.each(['if True\n    print(1)', 'def broken(:\n    pass', 'x = (1 +\n', 'if True:\npass\n'])('marca sintaxis inválida: %s', (source) => {
    const diagnostics = checkMicroPythonSyntax(source);
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.severity).toBe('error');
      expect(diagnostic.source).toBe('Sintaxis Python');
      expect(diagnostic.from).toBeGreaterThanOrEqual(0);
      expect(diagnostic.to).toBeLessThanOrEqual(source.length);
    }
  });

  it('no presenta análisis semántico como errores de sintaxis', () => {
    expect(checkMicroPythonSyntax('missing_name.call()\n')).toEqual([]);
  });

  it('elimina diagnósticos al corregir el código', () => {
    expect(checkMicroPythonSyntax('if True\n    pass\n').length).toBeGreaterThan(0);
    expect(checkMicroPythonSyntax('if True:\n    pass\n')).toEqual([]);
  });
});
