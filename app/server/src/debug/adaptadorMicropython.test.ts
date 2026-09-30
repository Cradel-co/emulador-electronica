import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdaptadorMicropython, ArmadorRespuestas, type CanalPuente } from './adaptadorMicropython.js';
import { microPythonSimbridge } from '../templates/micropythonBridge.js';

/** Arma las líneas @VARS que manda simbridge.py (JSON → base64 → trozos de 180). */
function lineasVars(id: string, obj: unknown, trozo = 180): string[] {
  const b64 = Buffer.from(JSON.stringify(obj)).toString('base64');
  const n = Math.ceil(b64.length / trozo);
  return Array.from({ length: n }, (_, i) => `@VARS ${id} ${i + 1}/${n} ${b64.slice(i * trozo, (i + 1) * trozo)}`);
}

/** Puente de mentira: contesta @DUMP/@EVAL como el firmware, con retardo y en trozos. */
class PuenteFalso implements CanalPuente {
  oyentes = new Set<(l: string) => void>();
  enviadas: string[] = [];
  mudo = false;
  constructor(private readonly responder: (tag: string, id: string, arg: string | undefined) => unknown) {}
  enviarLinea(linea: string): boolean {
    this.enviadas.push(linea);
    const [tag, id, arg] = linea.slice(1).split(' ') as [string, string, string | undefined];
    if (!this.mudo) {
      setTimeout(() => {
        // Se intercalan líneas de otros mensajes del puente, como en la realidad.
        for (const o of this.oyentes) o('@OUT 7 1');
        for (const l of lineasVars(id, this.responder(tag, id, arg), 40)) for (const o of this.oyentes) o(l);
      }, 5);
    }
    return true;
  }
  escucharLineas(fn: (l: string) => void): () => void {
    this.oyentes.add(fn);
    return () => this.oyentes.delete(fn);
  }
}

const volcado = {
  vars: [
    ['contador', 'int', '30', null, false],
    ['estado', 'dict', "{'modo': 'auto', 'historial': [1, 2, 3]}", 2, true],
    ['sensor', 'Sensor', '<Sensor object at 3c1a2bb0>', null, true],
  ],
  funcs: [['paso', 'function']],
  mem_free: 8293824,
  mem_alloc: 27712,
  ticks_ms: 4159,
  entradas: [[6, 0]],
  vigilados: [[7, 1]],
  hilo_puente: 1,
  plataforma: 'esp32',
  version: '3.4.0',
};

describe('ArmadorRespuestas', () => {
  it('junta los trozos (aunque lleguen desordenados) y decodifica el JSON', () => {
    const a = new ArmadorRespuestas();
    const lineas = lineasVars('9', { hola: 'mundo', n: [1, 2, 3] }, 8);
    expect(lineas.length).toBeGreaterThan(3);
    const [primera, ...resto] = lineas;
    for (const l of resto.reverse()) expect(a.push(l)).toBeNull();
    expect(a.push(primera!)).toEqual(['9', { hola: 'mundo', n: [1, 2, 3] }]);
    expect(a.push('@OUT 7 1')).toBeNull();
    expect(a.push('@VARS 3 1/1 esto-no-es-base64-json')?.[1]).toMatchObject({ error: expect.stringContaining('ilegible') });
  });
});

describe('AdaptadorMicropython', () => {
  const nuevo = (puente: PuenteFalso, listo = true) => new AdaptadorMicropython(puente, () => null, () => listo);

  it('ámbitos y variables desde @DUMP; hijos con @EVAL y evaluateName', async () => {
    const puente = new PuenteFalso((tag, _id, arg) => {
      if (tag === 'DUMP') return volcado;
      const expr = Buffer.from(arg ?? '', 'base64').toString();
      if (expr === 'estado') return { tipo: 'dict', repr: '…', len: 2, hijos: [["'modo'", 'str', "'auto'", 4, false], ["'historial'", 'list', '[1, 2, 3]', 3, true]] };
      if (expr === "estado['historial']") return { tipo: 'list', repr: '[1, 2, 3]', len: 3, hijos: [['0', 'int', '1', null, false]] };
      if (expr === 'sensor') return { tipo: 'Sensor', repr: '<Sensor>', hijos: [['.lecturas', 'int', '60', null, false]] };
      return { error: `NameError: name '${expr}' isn't defined` };
    });
    const a = nuevo(puente);
    const scopes = await a.scopes();
    expect(scopes.map((s) => s.name)).toEqual(['Globales de main.py', 'Funciones y clases', 'Intérprete']);
    const globales = await a.variables(scopes[0]!.variablesReference);
    expect(globales.map((v) => `${v.name}=${v.value}:${v.type}`)).toEqual(['contador=30:int', "estado={'modo': 'auto', 'historial': [1, 2, 3]}:dict [2]", 'sensor=<Sensor object at 3c1a2bb0>:Sensor']);
    const estado = globales.find((v) => v.name === 'estado')!;
    const hijos = await a.variables(estado.variablesReference);
    expect(hijos.map((h) => h.evaluateName)).toEqual(["estado['modo']", "estado['historial']"]);
    const nietos = await a.variables(hijos[1]!.variablesReference);
    expect(nietos[0]).toMatchObject({ name: '0', value: '1', evaluateName: "estado['historial'][0]" });
    const sensor = await a.variables(globales[2]!.variablesReference);
    expect(sensor[0]).toMatchObject({ name: '.lecturas', evaluateName: 'sensor.lecturas' });
    const interprete = await a.variables(scopes[2]!.variablesReference);
    expect(interprete[0]).toMatchObject({ value: '8293824 bytes' });
    // Las expresiones viajan en base64 (espacios, comillas, corchetes).
    expect(puente.enviadas.some((l) => /^@EVAL \d+ [A-Za-z0-9+/=]+$/.test(l))).toBe(true);
  });

  it('evaluate: resultado, error de Python, expresión larga, puente no listo, sin respuesta', async () => {
    const puente = new PuenteFalso((_t, _i, arg) => {
      const expr = Buffer.from(arg ?? '', 'base64').toString();
      return expr === 'contador * 2' ? { tipo: 'int', repr: '60', hijos: [] } : { error: 'ZeroDivisionError: divide by zero' };
    });
    const a = nuevo(puente);
    expect(await a.evaluate('contador * 2')).toEqual({ result: '60', type: 'int', variablesReference: 0 });
    await expect(a.evaluate('1/0')).rejects.toThrow('ZeroDivisionError');
    await expect(a.evaluate('x'.repeat(200))).rejects.toThrow(/demasiado larga/);
    await expect(nuevo(puente, false).evaluate('1')).rejects.toThrow(/no está listo/);
    puente.mudo = true;
    const antes = Date.now();
    await expect(a.evaluate('contador')).rejects.toThrow(/no contestó/);
    expect(Date.now() - antes).toBeGreaterThanOrEqual(2900);
  }, 10_000);

  it('no hay breakpoints ni pausa, y lo dice', async () => {
    const a = nuevo(new PuenteFalso(() => volcado));
    const bps = await a.setBreakpoints(new Map([['main.py', [3]]]), ['paso']);
    expect(bps.every((b) => !b.verified && /settrace/.test(b.message ?? ''))).toBe(true);
    await expect(a.control()).rejects.toThrow(/no se puede pausar/);
    expect(a.capacidades).toMatchObject({ pause: false, lineBreakpoints: false, variables: true, evaluate: true });
  });
});

/**
 * El código Python de verdad (simbridge.py, el que se sube al ESP32): se corre en CPython
 * con módulos de MicroPython de mentira (machine, utime, micropython, ubinascii, gc) y se
 * verifica que lo que responde a @DUMP/@EVAL lo entienda el lado Node.
 * (La verificación contra MicroPython real en esp-emu está en docs/depuracion.md.)
 */
const python = spawnSync('python3', ['--version']).status === 0;
describe.skipIf(!python)('simbridge.py (CPython con módulos de MicroPython simulados)', () => {
  it('@DUMP y @EVAL responden @VARS que el adaptador entiende; evaluate bloquea import/sleep', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'simbridge-'));
    writeFileSync(path.join(dir, 'simbridge.py'), microPythonSimbridge);
    const arnes = `
import sys, types, binascii, json
m = types.ModuleType('machine')
class UART:
    def __init__(self, *a, **k): pass
    def write(self, s): pass
    def any(self): return 0
class Pin:
    IN = 1; OUT = 3; PULL_UP = 2; IRQ_FALLING = 2; IRQ_RISING = 1
    def __init__(self, *a, **k): pass
m.UART = UART; m.Pin = Pin; m.mem32 = {}
sys.modules['machine'] = m
sys.modules['utime'] = types.SimpleNamespace(ticks_ms=lambda: 4242, sleep_ms=lambda n: None)
sys.modules['micropython'] = types.SimpleNamespace(schedule=lambda f, a: None)
sys.modules['ubinascii'] = binascii
import gc as _gc
gc = types.ModuleType('gc'); gc.mem_free = lambda: 1000; gc.mem_alloc = lambda: 200; gc.collect = _gc.collect
sys.modules['gc'] = gc
sys.path.insert(0, ${JSON.stringify(dir)})
import simbridge
salida = []
simbridge._send = lambda l: salida.append(l)
# "main.py" del usuario: globales de este módulo (__main__)
contador = 30
estado = {'modo': 'auto', 'historial': [1, 2, 3]}
class Sensor:
    def __init__(self): self.lecturas = 60
sensor = Sensor()
def paso(): pass
simbridge._handle('@DUMP 1')
simbridge._handle('@EVAL 2 ' + binascii.b2a_base64(b"estado['historial'][1] + contador").decode().strip())
simbridge._handle('@EVAL 3 ' + binascii.b2a_base64(b'import os').decode().strip())
simbridge._handle('@EVAL 4 ' + binascii.b2a_base64(b'utime.sleep_ms(10)').decode().strip())
simbridge._handle('@EVAL 5 ' + binascii.b2a_base64(b'sensor').decode().strip())
print(json.dumps(salida))
`;
    const r = spawnSync('python3', ['-c', arnes], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    const lineas = JSON.parse(r.stdout) as string[];
    expect(lineas.every((l) => l.length < 256)).toBe(true); // el protocolo del puente es de líneas < 256
    const armador = new ArmadorRespuestas();
    const respuestas = new Map<string, Record<string, unknown>>();
    for (const l of lineas) {
      const x = armador.push(l);
      if (x) respuestas.set(x[0], x[1] as Record<string, unknown>);
    }
    const dump = respuestas.get('1')!;
    const vars = Object.fromEntries((dump.vars as [string, string, string][]).map(([n, t, rep]) => [n, `${rep} (${t})`]));
    expect(vars).toMatchObject({ contador: '30 (int)', estado: "{'modo': 'auto', 'historial': [1, 2, 3]} (dict)" });
    expect(vars.sensor).toMatch(/Sensor object/);
    expect(dump.funcs).toEqual(expect.arrayContaining([['paso', 'function'], ['Sensor', 'type']]));
    expect(dump).toMatchObject({ mem_free: 1000, mem_alloc: 200, ticks_ms: 4242 });
    expect(respuestas.get('2')).toMatchObject({ tipo: 'int', repr: '32' });
    expect(respuestas.get('3')).toMatchObject({ error: expect.stringContaining('import') });
    expect(respuestas.get('4')).toMatchObject({ error: expect.stringContaining('sleep_ms') });
    expect(respuestas.get('5')).toMatchObject({ tipo: 'Sensor', hijos: [['.lecturas', 'int', '60', null, false]] });
  });
});
