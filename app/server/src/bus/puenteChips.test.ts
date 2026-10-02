import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { microPythonSimbridge } from '../templates/micropythonBridge.js';
import { cargarChips } from './catalogoChips.js';
import { entornoDe, type ChipEnBus } from './proyectoChips.js';
import { PuenteChips } from './puenteChips.js';

/**
 * Chips en un ESP32 con MicroPython: el simbridge.py DE VERDAD (el que se sube al chip) corre en
 * CPython con módulos de MicroPython de mentira; su UART es stdin/stdout de este proceso, y del
 * otro lado está PuenteChips con los chips del catálogo. El programa de prueba usa machine.I2C y
 * machine.SPI como en una placa real. (Contra MicroPython en esp-emu: tests/e2e/chips.spec.ts.)
 */

const catalogo = cargarChips();
function chip(id: string, inst: string, o: Partial<ChipEnBus>): ChipEnBus {
  const c = catalogo.find((x) => x.id === id)!;
  return { id: inst, instancia: inst, chip: id, nombre: c.nombre, codigo: c.codigo, props: {}, entorno: entornoDe(c), alimentado: true, pinesGpio: {}, pullUps: [], ...o };
}

const ARNES = (dir: string, programa: string) => `
import sys, os, types, time, select, binascii, json
m = types.ModuleType('machine')
_entrada = [b'']
class UART:
    def __init__(self, *a, **k): pass
    def write(self, s):
        sys.stdout.write(s); sys.stdout.flush()
    def any(self):
        while select.select([0], [], [], 0)[0]:
            b = os.read(0, 65536)
            if not b: break
            _entrada[0] += b
        return len(_entrada[0])
    def read(self, n):
        b = _entrada[0][:n]; _entrada[0] = _entrada[0][n:]; return b
class Pin:
    IN = 1; OUT = 3; PULL_UP = 2; IRQ_FALLING = 2; IRQ_RISING = 1
    def __init__(self, n, *a, **k): self.n = n; self.v = k.get('value', 0)
    def init(self, *a, **k): pass
    def value(self, *a):
        if a: self.v = a[0]
        return self.v
m.UART = UART; m.Pin = Pin; m.mem32 = {}
sys.modules['machine'] = m
_t0 = time.monotonic()
def ticks_us(): return int((time.monotonic() - _t0) * 1e6) & (2**30 - 1)
def ticks_ms(): return int((time.monotonic() - _t0) * 1e3)
sys.modules['utime'] = types.SimpleNamespace(ticks_us=ticks_us, ticks_ms=ticks_ms, ticks_diff=lambda a, b: a - b,
    sleep_ms=lambda n: time.sleep(n / 1000), sleep_us=lambda n: time.sleep(n / 1e6))
sys.modules['micropython'] = types.SimpleNamespace(schedule=lambda f, a: None)
sys.modules['ubinascii'] = binascii
sys.path.insert(0, ${JSON.stringify(dir)})
import simbridge
simbridge.start()
import utime
from machine import I2C, SoftI2C, SPI, Pin
while not simbridge._estado['chips']:
    utime.sleep_ms(5)
out = {}
try:
${programa.split('\n').map((l) => `    ${l}`).join('\n')}
except Exception as e:
    out['error'] = repr(e)
sys.stderr.write('RESULTADO ' + json.dumps(out) + '\\n'); sys.stderr.flush()
os._exit(0)
`;

/** Corre el programa con los chips del otro lado del puente. */
async function correr(chips: ChipEnBus[], programa: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'puente-chips-'));
  writeFileSync(path.join(dir, 'simbridge.py'), microPythonSimbridge);
  const py = spawn('python3', ['-u', '-c', ARNES(dir, programa)]);
  const salidas = new Map<string, Record<string, unknown>>();
  const lineas: string[] = [];
  const puente = new PuenteChips(chips, {
    enviar: (l) => py.stdin.write(`${l}\n`),
    alSalida: (id, s) => salidas.set(id, s),
    alLog: (l) => lineas.push(l),
  });
  let resto = '';
  py.stdout.setEncoding('utf8');
  py.stdout.on('data', (d: string) => {
    resto += d;
    let i: number;
    while ((i = resto.indexOf('\n')) !== -1) {
      const l = resto.slice(0, i);
      resto = resto.slice(i + 1);
      lineas.push(l);
      puente.recibir(l);
    }
  });
  let err = '';
  py.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  await new Promise((r) => py.on('close', r));
  const m = /RESULTADO (.*)/.exec(err);
  if (!m) throw new Error(`el programa no terminó bien:\n${err}`);
  return { out: JSON.parse(m[1]!) as Record<string, unknown>, salidas, lineas, puente };
}

const python = spawnSync('python3', ['--version']).status === 0;
describe.skipIf(!python)('chips en ESP32 con MicroPython (simbridge.py real en CPython)', () => {
  it('I2C: scan, readfrom_mem, NACK con OSError 19 y una medición forzada del BME280 que da la temperatura del entorno', async () => {
    const bme = chip('bosch-bme280', 'bme', { props: { sdo: 'alto' }, entorno: { temperatura: 23.4, humedad: 50, presion: 1000 }, i2cGpio: { sda: 4, scl: 5 } });
    const { out } = await correr([bme], `
i2c = I2C(0, scl=Pin(5), sda=Pin(4), freq=400000)
out['scan'] = i2c.scan()
out['id'] = i2c.readfrom_mem(0x77, 0xD0, 1)[0]
try:
    i2c.readfrom(0x40, 1)
    out['nack'] = 'no'
except OSError as e:
    out['nack'] = e.args[0]
otro = SoftI2C(scl=Pin(7), sda=Pin(6))
out['otro_bus'] = otro.scan()
i2c.writeto_mem(0x77, 0xF2, bytes([1]))
out['acks'] = i2c.writeto(0x77, bytes([0xF4, 0x25]))
utime.sleep_ms(15)
d = i2c.readfrom_mem(0x77, 0xFA, 3)
c = i2c.readfrom_mem(0x77, 0x88, 6)
adc = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4)
T1 = c[0] | c[1] << 8
T2 = c[2] | c[3] << 8
T3 = c[4] | c[5] << 8
T2 = T2 - 65536 if T2 > 32767 else T2
T3 = T3 - 65536 if T3 > 32767 else T3
v1 = (((adc >> 3) - (T1 << 1)) * T2) >> 11
v2 = (((((adc >> 4) - T1) * ((adc >> 4) - T1)) >> 12) * T3) >> 14
out['T'] = (((v1 + v2) * 5 + 128) >> 8) / 100
`);
    expect(out.error).toBeUndefined();
    expect(out.scan).toEqual([0x77]);
    expect(out.id).toBe(0x60);
    expect(out.nack).toBe(19);
    expect(out.otro_bus).toEqual([]); // nada cableado a esos pines
    expect(out.acks).toBe(2);
    expect(out.T).toBeCloseTo(23.4, 1);
  }, 30_000);

  it('SPI: una TFT ST7735 con CS y DC como Pin del programa; la imagen llega a la app con el latido del reloj', async () => {
    const tft = chip('sitronix-st7735', 'tft', {
      spi: { csGpio: 10, dcGpio: 9, modos: [0, 3], lsbPrimero: false, soloEscritura: true, maxHz: 15e6, sck: 12, mosi: 11 },
      entradas: { 8: 'RESX' },
    });
    const { out, salidas, lineas } = await correr([tft], `
spi = SPI(1, baudrate=20000000, polarity=0, phase=0, sck=Pin(12), mosi=Pin(11))
cs = Pin(10, Pin.OUT, value=1)
dc = Pin(9, Pin.OUT, value=0)
rst = Pin(8, Pin.OUT, value=1)
def cmd(c, datos=b''):
    cs(0)
    dc(0)
    spi.write(bytes([c]))
    if datos:
        dc(1)
        spi.write(datos)
    cs(1)
for c, d in ((0x01, b''), (0x11, b''), (0x3A, b'\\x05'), (0x36, b'\\xC0'), (0x29, b''),
             (0x2A, b'\\x00\\x00\\x00\\x7F'), (0x2B, b'\\x00\\x00\\x00\\x9F')):
    cmd(c, d)
cmd(0x2C, b'\\x00\\x1F' * (128 * 160))   # todo azul
cmd(0x2A, b'\\x00\\x00\\x00\\x00'); cmd(0x2B, b'\\x00\\x00\\x00\\x00')
cmd(0x2C, b'\\xF8\\x00')                   # (0,0) rojo
utime.sleep_ms(200)
out['ok'] = 1
`);
    expect(out.error).toBeUndefined();
    expect(lineas.join('\n')).toMatch(/\[spi\] tft .*hasta 15 MHz/); // 20 MHz: se avisa, como en el Uno
    const p = salidas.get('tft') as { encendida: boolean; ancho: number; rgb565: string };
    expect(p.encendida).toBe(true);
    const px = (x: number, y: number) => Buffer.from(p.rgb565, 'base64').readUInt16BE((y * p.ancho + x) * 2);
    expect(px(0, 0)).toBe(0xf800);
    expect(px(64, 80)).toBe(0x001f);
  }, 30_000);
});
