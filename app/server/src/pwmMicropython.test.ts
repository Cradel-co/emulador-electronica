import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { microPythonSimbridgePara } from './templates/micropythonBridge.js';
import { PuentePwm } from './pwmEsp.js';

/**
 * `machine.PWM` del shim que se sube al dispositivo, ejecutado en CPython. Valida el contrato:
 * qué `@PWM` emite y cuándo. CPython no acredita timing ni el LEDC nativo.
 *
 * El PWM es DECLARATIVO a propósito: la app no reconstruye el tono de los flancos porque el
 * puente muestrea los registros de salida. Cada cambio se avisa una vez.
 */
async function correr(programa: string, chip = 'esp32s3') {
  const shim = microPythonSimbridgePara({ chip, uart: 1, tx: 17, rx: 18, gpioOutRegs: [0x60004004] });
  const arnes = `
import sys, os, types, time, select, json
m = types.ModuleType('machine')
class UART:
    def __init__(self, *a, **kw): pass
    def write(self, s): sys.stdout.write(s); sys.stdout.flush()
    def any(self): return 0
    def read(self, n): return b''
class Pin:
    IN = 1; OUT = 3; PULL_UP = 2; IRQ_FALLING = 2; IRQ_RISING = 1
    def __init__(self, n, *a, **kw): self.n = n; self._n = n
    def value(self, *a): return 0
class PwmNativo:
    def __init__(self, *a, **kw): raise RuntimeError('PWM nativo sin modelo')
m.UART = UART; m.Pin = Pin; m.PWM = PwmNativo; m.mem32 = {}
sys.modules['machine'] = m
sys.modules['utime'] = types.SimpleNamespace(ticks_us=lambda: int(time.monotonic()*1e6), ticks_ms=lambda: int(time.monotonic()*1e3), ticks_diff=lambda a,b: a-b, sleep_ms=lambda n: time.sleep(n/1000))
sys.modules['micropython'] = types.SimpleNamespace(schedule=lambda f,a: None)
ns = {}
exec(${JSON.stringify(shim)}, ns)
ns['start']()
from machine import PWM, Pin
out = {}
try:
${programa.split('\n').map((l) => `    ${l}`).join('\n')}
except Exception as e:
    out['error'] = repr(e)
sys.stderr.write('RESULTADO ' + json.dumps(out) + '\\n'); sys.stderr.flush()
os._exit(0)
`;
  const py = spawn('python3', ['-u', '-c', arnes]);
  const lineas: string[] = [];
  let resto = '', errores = '';
  py.stdout.setEncoding('utf8');
  py.stdout.on('data', (d: string) => {
    resto += d;
    let i: number;
    while ((i = resto.indexOf('\n')) >= 0) { lineas.push(resto.slice(0, i)); resto = resto.slice(i + 1); }
  });
  py.stderr.on('data', (d: Buffer) => { errores += d.toString(); });
  const limite = setTimeout(() => py.kill('SIGKILL'), 8000);
  try { await new Promise<void>((res, rej) => { py.on('close', () => res()); py.on('error', rej); }); }
  finally { clearTimeout(limite); }
  const texto = /RESULTADO (.*)/.exec(errores)?.[1];
  if (!texto) throw new Error(`Shim no terminó: ${errores}`);
  return { out: JSON.parse(texto) as Record<string, unknown>, pwm: lineas.filter((l) => l.startsWith('@PWM')) };
}

/** `@PWM <gpio> <hz> <duty_u16> <ticks>` → los tres primeros campos, sin el reloj. */
const campos = (linea: string) => linea.split(/\s+/).slice(1, 4);

describe('machine.PWM MicroPython → @PWM', () => {
  it('se instala sobre el PWM nativo: el del shim es el que corre', async () => {
    const { out } = await correr(`
p = PWM(Pin(5), freq=440, duty=512)
out['tipo'] = type(p).__name__
`);
    expect(out.error).toBeUndefined();
    expect(out.tipo).toBe('PWM');
  });

  it('crear con frecuencia y duty avisa una sola vez', async () => {
    const { out, pwm } = await correr(`
p = PWM(Pin(5), freq=440, duty=512)
`);
    expect(out.error).toBeUndefined();
    expect(pwm).toHaveLength(1);
    const [gpio, hz, u16] = campos(pwm[0]!);
    expect([gpio, hz]).toEqual(['5', '440']);
    expect(Math.abs(Number(u16) - 32768)).toBeLessThan(100);
  });

  it('cambiar la nota avisa de nuevo, con el duty intacto', async () => {
    const { out, pwm } = await correr(`
p = PWM(Pin(5), freq=440, duty=512)
p.freq(880)
p.freq(494)
`);
    expect(out.error).toBeUndefined();
    expect(pwm.map((l) => campos(l)[1])).toEqual(['440', '880', '494']);
    expect(new Set(pwm.map((l) => campos(l)[2])).size).toBe(1);
  });

  it('los cuatro modos de duty llegan al mismo campo', async () => {
    const { out, pwm } = await correr(`
p = PWM(Pin(5), freq=1000, duty=1023)
p.duty_u16(16384)
p.duty_ns(250000)
out['duty'] = p.duty()
out['u16'] = p.duty_u16()
out['ns'] = p.duty_ns()
out['hz'] = p.freq()
`);
    expect(out.error).toBeUndefined();
    expect(campos(pwm[0]!)[2]).toBe('65535');
    expect(campos(pwm[1]!)[2]).toBe('16384');
    // 250 us sobre un período de 1 ms es el 25 %.
    expect(Math.abs(Number(campos(pwm[2]!)[2]) - 16384)).toBeLessThan(200);
    expect(Number(out.duty)).toBeGreaterThan(200);
    expect(out.hz).toBe(1000);
  });

  it('deinit avisa que el pin dejó de hacer PWM', async () => {
    const { out, pwm } = await correr(`
p = PWM(Pin(5), freq=440, duty=512)
p.deinit()
`);
    expect(out.error).toBeUndefined();
    expect(pwm).toHaveLength(2);
    expect(campos(pwm[1]!)).toEqual(['5', 'off', '0']);
  });

  it('un Pin o un entero sirven igual', async () => {
    const { out, pwm } = await correr(`
PWM(7, freq=440, duty=512)
PWM(Pin(8), freq=440, duty=512)
`);
    expect(out.error).toBeUndefined();
    expect(pwm.map((l) => campos(l)[0])).toEqual(['7', '8']);
  });

  it('rechaza lo que no sabe hacer en vez de fingirlo', async () => {
    for (const [programa, esperado] of [
      ['PWM(Pin(5), freq=-1)', 'ValueError'],
      ['PWM(Pin(5), duty=True)', 'ValueError'],
      ['PWM(Pin(5), freq=440, invert=1)', 'NotImplementedError'],
      ['PWM(Pin(5)).duty_ns(100)', 'ValueError'],
    ] as const) {
      const { out } = await correr(programa);
      expect(String(out.error), programa).toContain(esperado);
    }
  });
});

/**
 * Las dos mitades del PWM tienen que coincidir en el formato del cable: lo que escribe el shim
 * (en el dispositivo) y lo que parsea el puente (en el server). Si alguien cambia uno solo, esto
 * se rompe en vez de dejar el audio mudo en silencio.
 *
 * Es la versión automatizable de lo que se verificó a mano con el firmware corriendo.
 */
describe('el shim y el puente coinciden en el formato de @PWM', () => {
  const puenteCon = (lineas: string[]) => {
    const puente = new PuentePwm();
    for (const l of lineas) puente.recibir(l);
    return puente;
  };

  it('lo que emite el shim al poner una nota, el puente lo entiende', async () => {
    const { out, pwm } = await correr(`
p = PWM(Pin(5), freq=440, duty_u16=32768)
`);
    expect(out.error).toBeUndefined();
    const estado = puenteCon(pwm).estado();
    expect(estado.get(5)?.hz).toBe(440);
    expect(estado.get(5)?.duty).toBeCloseTo(0.5, 3);
  });

  it('un barrido de duty llega con los valores que puso el programa', async () => {
    const { out, pwm } = await correr(`
p = PWM(Pin(5), freq=440, duty_u16=0)
for u16 in (3277, 16384, 32768, 49152, 62259, 65535):
    p.init(freq=440, duty_u16=u16)
`);
    expect(out.error).toBeUndefined();
    // Cada línea deja el puente en el duty de esa etapa.
    const duties = pwm.map((l) => {
      const e = puenteCon([l]).estado().get(5);
      return e ? Number(e.duty.toFixed(3)) : null;
    });
    expect(duties).toEqual([0, 0.05, 0.25, 0.5, 0.75, 0.95, 1]);
  });

  it('después de deinit el puente no tiene PWM en ese pin: el buzzer se calla', async () => {
    const { out, pwm } = await correr(`
p = PWM(Pin(5), freq=440, duty_u16=32768)
p.deinit()
`);
    expect(out.error).toBeUndefined();
    const estado = puenteCon(pwm).estado();
    expect(estado.has(5), 'deinit tiene que liberar el pin, o queda un tono trabado').toBe(false);
  });

  it('el puente entiende todas las líneas del shim, sin descartar ninguna', async () => {
    const { out, pwm } = await correr(`
p = PWM(Pin(5), freq=440, duty=512)
p.freq(880)
p.duty_u16(16384)
p.duty_ns(250000)
p.deinit()
`);
    expect(out.error).toBeUndefined();
    const puente = new PuentePwm();
    const entendidas = pwm.map((l) => puente.recibir(l));
    expect(entendidas, `el puente descartó alguna de ${JSON.stringify(pwm)}`).toEqual(pwm.map(() => true));
  });
});
