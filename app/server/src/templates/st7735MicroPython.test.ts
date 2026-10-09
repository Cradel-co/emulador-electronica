import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { st7735MicroPython } from './st7735MicroPython.js';

const arnes = String.raw`
import json, sys, types
entrada = json.loads(sys.stdin.read())
class Pin:
    OUT = 1
    def __init__(self, n, mode=1): self.n, self.v = n, 1
    def value(self, v=None):
        if v is not None: self.v = v
        return self.v
class SPI:
    def __init__(self): self.cs = None; self.dc = None; self.escrituras = []
    def write(self, datos): self.escrituras.append((self.cs.v, self.dc.v, bytes(datos)))
spi = SPI()
pin_cs, pin_dc, pin_rst = Pin(14), Pin(15), Pin(16)
spi.cs, spi.dc = pin_cs, pin_dc
maquina = types.ModuleType('machine')
maquina.Pin, maquina.SPI = Pin, SPI
sys.modules['machine'] = maquina
tiempo = types.ModuleType('time')
tiempo.sleep_ms = lambda _: None
sys.modules['time'] = tiempo
espacio = {}
exec(compile(entrada['fuente'], '<st7735>', 'exec'), espacio)
p = espacio['ST7735'](spi, pin_cs, pin_dc, pin_rst)
p.iniciar()
p.dibujar_rgb565(bytes((i & 255 for i in range(128 * 96 * 2))), 0, 32, 128, 96)
comandos = [d[0] for cs, dc, d in spi.escrituras if cs == 0 and dc == 0 and len(d) == 1]
indice_ramwr = max(i for i, (cs, dc, d) in enumerate(spi.escrituras) if cs == 0 and dc == 0 and d == b'\x2c')
imagen = [d for cs, dc, d in spi.escrituras[indice_ramwr + 1:] if cs == 0 and dc == 1]
print(json.dumps({'comandos': comandos, 'pixeles': sum(map(len, imagen)), 'bloques': len(imagen), 'cs_alto': pin_cs.v, 'rst_alto': pin_rst.v}))
`;

const Python = spawnSync('python3', ['--version']).status === 0;

describe.skipIf(!Python)('driver MicroPython de la TFT ST7735', () => {
  it('inicializa el panel y transmite la ventana RGB565 en bloques con CS y D/C correctos', () => {
    const r = spawnSync('python3', ['-c', arnes], {
      input: JSON.stringify({ fuente: st7735MicroPython }), encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    expect(r.status).toBe(0);
    const datos = JSON.parse(r.stdout) as { comandos: number[]; pixeles: number; bloques: number; cs_alto: number; rst_alto: number };
    expect(datos.comandos).toEqual(expect.arrayContaining([0x01, 0x11, 0x3a, 0x36, 0x29, 0x2a, 0x2b, 0x2c]));
    expect(datos.pixeles).toBe(128 * 96 * 2);
    expect(datos.bloques).toBeGreaterThan(1);
    expect(datos.cs_alto).toBe(1);
    expect(datos.rst_alto).toBe(1);
  });
});
