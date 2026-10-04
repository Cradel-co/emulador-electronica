import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { microPythonSimbridgePara } from './templates/micropythonBridge.js';
import { PuenteAnalogicoEsp, estadoAnalogicoEspDesdeCircuito, type EstadoAnalogicoEsp } from './analogicoEsp.js';
import type { PerfilAnalogicoEsp } from '@emu/shared';
import { perfilEspPrueba, proyectoEspPrueba } from './fixtures/analogicoEsp.js';
import { loadCatalog } from './catalog.js';
import { analizarCircuito } from './sim/analisis.js';

/** Ejecuta el shim que se sube al dispositivo; UART stdin/stdout contra el puente real.
 * CPython sólo valida el contrato del shim: no acredita timing ni firmware nativo ESP.
 */
async function correr(programa: string, perfil: PerfilAnalogicoEsp | undefined, estado: EstadoAnalogicoEsp, chip = 'esp32s3') {
  const shim = microPythonSimbridgePara({ chip, uart: 1, tx: 17, rx: 18, gpioOutRegs: [0x60004004] });
  const arnes = `
import sys, os, types, time, select, json
m = types.ModuleType('machine')
entrada = [b'']
class UART:
    def __init__(self, *a, **kw): pass
    def write(self, s): sys.stdout.write(s); sys.stdout.flush()
    def any(self):
        while select.select([0], [], [], 0)[0]:
            b = os.read(0, 65536)
            if not b: break
            entrada[0] += b
        return len(entrada[0])
    def read(self, n):
        b = entrada[0][:n]; entrada[0] = entrada[0][n:]; return b
class Pin:
    IN = 1; OUT = 3; PULL_UP = 2; IRQ_FALLING = 2; IRQ_RISING = 1
    def __init__(self, n, *a, **kw): self.n = n
    def value(self, *a): return 0
class ADCNativo:
    def __init__(self, *a, **kw): raise RuntimeError('ADC nativo sin modelo')
m.UART = UART; m.Pin = Pin; m.ADC = ADCNativo; m.ADCBlock = ADCNativo; m.mem32 = {}
sys.modules['machine'] = m
sys.modules['utime'] = types.SimpleNamespace(ticks_us=lambda: int(time.monotonic()*1e6), ticks_ms=lambda: int(time.monotonic()*1e3), ticks_diff=lambda a,b: a-b, sleep_ms=lambda n: time.sleep(n/1000))
sys.modules['micropython'] = types.SimpleNamespace(schedule=lambda f,a: None)
ns = {}
exec(${JSON.stringify(shim)}, ns)
ns['start']()
from machine import ADC, ADCBlock, Pin
out = {}
try:
${programa.split('\n').map(l => `    ${l}`).join('\n')}
except Exception as e:
    out['error'] = repr(e)
sys.stderr.write('RESULTADO ' + json.dumps(out) + '\\n'); sys.stderr.flush()
os._exit(0)
`;
  const py = spawn('python3', ['-u', '-c', arnes]);
  const lineas: string[] = [], respuestas: string[] = [];
  const adc = new PuenteAnalogicoEsp(chip, perfil, l => { respuestas.push(l); py.stdin.write(`${l}\n`); });
  adc.actualizar(estado);
  let resto = '', errores = '';
  py.stdout.setEncoding('utf8');
  py.stdout.on('data', (d: string) => {
    resto += d;
    let i: number;
    while ((i = resto.indexOf('\n')) >= 0) {
      const l = resto.slice(0, i); resto = resto.slice(i + 1); lineas.push(l); adc.recibir(l);
    }
  });
  py.stderr.on('data', (d: Buffer) => { errores += d.toString(); });
  const limite = setTimeout(() => py.kill('SIGKILL'), 8000);
  try { await new Promise<void>((resolve, reject) => { py.on('close', () => resolve()); py.on('error', reject); }); }
  finally { clearTimeout(limite); }
  const texto = /RESULTADO (.*)/.exec(errores)?.[1];
  if (!texto) throw new Error(`Shim no terminó: ${errores}`);
  return { out: JSON.parse(texto) as Record<string, unknown>, lineas, respuestas };
}

describe('machine.ADC MicroPython → UART → snapshot del solver', () => {
  it('ejecuta read/read_u16 sobre un divisor SPICE y usa atenuación explícita', async () => {
    const catalogo = await loadCatalog(), p = proyectoEspPrueba();
    const buscar = (t: string) => catalogo.find(m => m.type === t);
    const desc = buscar(p.board ?? '')?.board; if (!desc) throw new Error('Falta placa');
    const e = estadoAnalogicoEspDesdeCircuito('board', desc, await analizarCircuito(p, buscar));
    const { out, lineas, respuestas } = await correr(`
a = ADC(Pin(4), atten=ADC.ATTN_11DB)
out['raw'] = a.read()
out['u16'] = a.read_u16()
a.atten(ADC.ATTN_0DB)
out['saturado'] = a.read()
`, perfilEspPrueba(), e);
    expect(out.error).toBeUndefined();
    expect(Math.abs(Number(out.raw) - 2112)).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(out.u16) - 33800)).toBeLessThanOrEqual(17);
    expect(out.saturado).toBe(4095);
    expect(lineas.filter(l => l.startsWith('@ADC'))).toEqual(['@ADC 1 4 3', '@ADC 2 4 3', '@ADC 3 4 0']);
    expect(respuestas[2]).toBe('@ADCR 3 4095');
  });
  it('default sin perfil y entrada desconocida producen OSError, nunca cero', async () => {
    const programa = `
a = ADC(4)
out['errores'] = []
for accion in [a.read, a.read_u16]:
    try:
        out['errores'].append(accion())
    except OSError as e:
        out['errores'].append([e.args[0], e.args[1]])
`;
    for (const [perfil, codigo] of [[undefined, 'SIN_MODELO'], [perfilEspPrueba(), 'ENTRADA_DESCONOCIDA']] as const) {
      const { out } = await correr(programa, perfil, { resuelto: true, vcc: 3.3, canales: { 4: null } });
      expect(out.error).toBeUndefined(); expect(out.errores).toEqual([[5, `ADC MicroPython: ${codigo}`], [5, `ADC MicroPython: ${codigo}`]]);
    }
  });
  it('rechaza ADC2, calibración, ADCBlock, adquisición temporal y anchos no modelados', async () => {
    const { out, lineas } = await correr(`
a = ADC(4)
a.width(ADC.WIDTH_12BIT)
a.init(atten=ADC.ATTN_6DB)
out['errores'] = []
for accion in [lambda: ADC(11), lambda: ADC(4, sample_ns=100), lambda: a.atten(4), lambda: a.width(13), a.read_uv, a.block, lambda: ADCBlock(1), a.deinit]:
    try:
        accion()
        out['errores'].append('sin error')
    except Exception as e:
        out['errores'].append(type(e).__name__)
`, perfilEspPrueba(), { resuelto: true, vcc: 3.3, canales: { 4: 1.6 } });
    expect(out.error).toBeUndefined();
    expect(out.errores).toEqual(['ValueError', 'TypeError', 'ValueError', 'NotImplementedError', 'NotImplementedError', 'NotImplementedError', 'NotImplementedError', 'NotImplementedError']);
    expect(lineas.filter(l => l.startsWith('@ADC'))).toEqual([]);
  });
  it.each(['esp32c3', 'esp32c6'] as const)('mapea GPIO0 ADC1 en %s y comparte atenuación por pad', async chip => {
    const perfil = perfilEspPrueba(); perfil.chip = chip; perfil.canales = perfil.canales.map(c => ({ ...c, gpio: 0 }));
    const { out } = await correr(`
a = ADC(0)
b = ADC(Pin(0), atten=ADC.ATTN_0DB)
out['raw'] = a.read()
b.init(atten=ADC.ATTN_11DB)
out['u16'] = a.read_u16()
`, perfil, { resuelto: true, vcc: 3.3, canales: { 0: 0.5 } }, chip);
    expect(out.error).toBeUndefined(); expect(out.raw).toBe(2048); expect(out.u16).toBe(10242);
  });
});
