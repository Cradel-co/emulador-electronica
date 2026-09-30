import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ModuleDefSchema, defaultProject, type ModuleDef, type Project } from '@emu/shared';
import { buscarPlaca, listarPlacas, nivelDeclarado, validarPlaca } from './boardRegistry.js';
import { esquemaJsonPlaca } from './boardSchema.js';
import { ENGINES } from './engines/index.js';
import { TOOLCHAINS } from './toolchains/index.js';
import { extractArduinoErrors } from './toolchains/arduinoCli.js';
import { placaEsphome } from './toolchains/esphome.js';
import { buildSimYaml } from './yamlSim.js';
import { conectar, desconectar, gpioDe, normalizarRef } from './diagramOps.js';
import { analizarCircuito } from './circuitPhysics.js';
import { diffDiagramVsCode, scanPins } from './pinScan.js';
import { lenguajeParaCertificar } from './certificacion.js';

const moduloJson = (tipo: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../modules/${tipo}/module.json`, import.meta.url), 'utf8'));
const def = (tipo: string): ModuleDef => ModuleDefSchema.parse(moduloJson(tipo));
const catalogo = new Map(['arduino-uno', 'esp32-s3-devkitc-1', 'esp32-c3-devkitm-1', 'button', 'led', 'resistor'].map((t) => [t, def(t)]));
const buscar = (t: string) => catalogo.get(t);

describe('registro de placas (sale del catálogo)', () => {
  it('lista las cuatro placas de fábrica como datos', async () => {
    const ids = (await listarPlacas()).map((p) => p.id).sort();
    expect(ids).toEqual(expect.arrayContaining(['arduino-uno', 'esp32-c3-devkitm-1', 'esp32-c6-devkitc-1', 'esp32-s3-devkitc-1']));
    const uno = await buscarPlaca('arduino-uno');
    expect(uno?.nombre).toBe('Arduino Uno R3');
    expect(uno?.desc.backend.engine).toBe('avr8js');
    expect(await buscarPlaca('no-existe')).toBeUndefined();
  });

  it('cada placa usa motores y toolchains registrados; nivel declarado "emula"', async () => {
    for (const p of await listarPlacas()) {
      expect(ENGINES[p.desc.backend.engine], p.id).toBeDefined();
      for (const l of Object.values(p.desc.languages)) expect(TOOLCHAINS[l!.toolchain], `${p.id} ${l!.toolchain}`).toBeDefined();
      expect(nivelDeclarado(p.desc)).toBe('emula');
    }
  });

  it('certifica con el toolchain más rápido que tenga la placa', async () => {
    expect(lenguajeParaCertificar((await buscarPlaca('arduino-uno'))!)).toBe('arduino');
    expect(lenguajeParaCertificar((await buscarPlaca('esp32-c3-devkitm-1'))!)).toBe('micropython');
  });
});

describe('validarPlaca (POST /api/boards/validate, MCP validar_placa)', () => {
  it.each(['arduino-uno', 'esp32-s3-devkitc-1', 'esp32-c3-devkitm-1', 'esp32-c6-devkitc-1'])('%s es válida', (tipo) => {
    const r = validarPlaca(moduloJson(tipo));
    expect(r.errores).toEqual([]);
    expect(r).toMatchObject({ ok: true, nivel: 'emula' });
  });

  it('una placa nueva (un "Arduino Nano" hecho con datos) valida sin tocar código', () => {
    const uno = moduloJson('arduino-uno');
    const nano = { ...uno, type: 'arduino-nano-test', name: 'Arduino Nano (prueba)' };
    expect(validarPlaca(nano)).toMatchObject({ ok: true, nivel: 'emula' });
  });

  it('errores: motor inexistente, opciones del motor, toolchain que no compila ese lenguaje', () => {
    const uno = moduloJson('arduino-uno') as { board: Record<string, unknown> };
    const conBoard = (b: Record<string, unknown>) => ({ ...uno, board: { ...uno.board, ...b } });
    expect(validarPlaca(conBoard({ backend: { engine: 'qemu-magico' } })).errores.join()).toContain('qemu-magico');
    expect(validarPlaca(conBoard({ backend: { engine: 'avr8js', options: { mcu: 'atmega2560' } } })).errores.join()).toContain('atmega2560');
    expect(validarPlaca(conBoard({ languages: { arduino: { toolchain: 'esphome' } } })).errores.join()).toContain('no compila arduino');
    expect(validarPlaca(conBoard({ languages: { arduino: { toolchain: 'arduino-cli', options: {} } } })).errores.join()).toContain('fqbn');
  });

  it('esp-emu exige un chip que exista y el puente por UART', () => {
    const s3 = moduloJson('esp32-s3-devkitc-1') as { board: Record<string, unknown> };
    const r = validarPlaca({ ...s3, board: { ...s3.board, backend: { engine: 'esp-emu', options: { chip: 'esp32' } } } });
    expect(r.ok).toBe(false);
    expect(r.errores.join()).toContain('esp32');
  });

  it('un motor sin implementar (renode) valida, con aviso y nivel "compila"/"solo-dibujo"', () => {
    const uno = moduloJson('arduino-uno') as { board: Record<string, unknown> };
    const r = validarPlaca({
      ...uno,
      board: { ...uno.board, backend: { engine: 'renode', options: { platform: 'platforms/cpus/stm32f103.repl' } } },
    });
    expect(r.ok).toBe(true);
    expect(r.nivel).toBe('compila');
    expect(r.avisos.join()).toContain('renode');
  });

  it('sin bloque board, o sin ser programable, no es una placa', () => {
    const { board: _b, ...sinBoard } = moduloJson('arduino-uno');
    expect(validarPlaca(sinBoard).errores.join()).toContain('board');
    expect(validarPlaca({ ...moduloJson('arduino-uno'), programmable: false }).errores.join()).toContain('programmable');
    expect(validarPlaca({ type: 'X X' }).ok).toBe(false);
  });

  it('GET /api/boards/schema: JSON Schema del bloque board y del module.json', () => {
    const s = esquemaJsonPlaca() as { board: { definitions?: Record<string, { properties?: Record<string, unknown> }> } };
    const board = s.board.definitions!.BoardDescriptor!;
    expect(Object.keys(board.properties!)).toEqual(expect.arrayContaining(['chip', 'backend', 'pins', 'io', 'languages', 'demo']));
  });
});

describe('dibujo, pines y Ley de Ohm con el Arduino Uno', () => {
  const unoDesc = def('arduino-uno').board!;
  const proyectoUno = (): Project => defaultProject('u', 'arduino', 'arduino-uno', unoDesc);

  it('normalizarRef entiende los nombres de la placa', () => {
    expect(normalizarRef('13', unoDesc)).toBe('board.D13');
    expect(normalizarRef('d2', unoDesc)).toBe('board.D2');
    expect(normalizarRef('A0', unoDesc)).toBe('board.A0');
    expect(normalizarRef('board.d13', unoDesc)).toBe('board.D13');
    expect(normalizarRef('btn1.OUT', unoDesc)).toBe('btn1.OUT');
    // Sin descriptor, lo de siempre (ESP32).
    expect(normalizarRef('6')).toBe('board.GPIO6');
  });

  it('gpioDe atraviesa la resistencia hasta D13; conectar/desconectar con "D3"', () => {
    const p = proyectoUno();
    expect(gpioDe(p, 'led1', 'IN', buscar)).toBe(13);
    expect(gpioDe(p, 'btn1', 'OUT', buscar)).toBe(2);
    const { project, wire } = conectar(p, 'btn1.OUT', 'D3', buscar);
    expect(wire).toEqual({ from: 'btn1.OUT', to: 'board.D3' });
    expect(desconectar(project, 'D3', undefined, buscar).quitados).toEqual([wire]);
  });

  it('en un ESP32-C3 los pines del puente (GPIO0/1) no se pueden cablear', () => {
    const c3 = def('esp32-c3-devkitm-1').board!;
    const p = defaultProject('c', 'esphome', 'esp32-c3-devkitm-1', c3);
    expect(() => conectar(p, 'btn1.OUT', 'GPIO0', buscar)).toThrow(/puente/);
  });

  it('Ley de Ohm a 5 V: con 220 Ω el LED lleva ~11.5 mA (sin aviso); directo al pin se quema', () => {
    const p = proyectoUno();
    const { ramas, avisos } = analizarCircuito(p, buscar, new Map([[13, 1]]));
    const rama = ramas.find((r) => r.origenRef === 'board.D13')!;
    expect(rama.origenV).toBe(5);
    // (5 − 2) / (220 + 15 del LED + 25 del pin del ATmega328P)
    expect(rama.amperios * 1000).toBeCloseTo((5 - 2) / 260 * 1000, 1);
    expect(avisos).toEqual([]);

    const directo: Project = {
      ...p,
      modules: p.modules.filter((m) => m.id !== 'r1'),
      wires: [...p.wires.filter((w) => !w.from.startsWith('r1.') && !w.to.startsWith('r1.')), { from: 'led1.IN', to: 'board.D13' }],
    };
    const a = analizarCircuito(directo, buscar, new Map([[13, 1]])).avisos;
    expect(a.map((x) => x.severidad)).toContain('peligro');
    expect(a.map((x) => x.mensaje).join()).toMatch(/5 V/);
  });

  it('con 5 Ω a 5 V avisa sobrecorriente con el nombre del pin (D13) y el chip (ATmega328P)', () => {
    const p = proyectoUno();
    p.modules = p.modules.map((m) => (m.id === 'r1' ? { ...m, props: { ohms: 5 } } : m));
    const a = analizarCircuito(p, buscar, new Map([[13, 1]])).avisos;
    expect(a.map((x) => x.mensaje).join()).toMatch(/D13 tendría que entregar ~67 mA.*ATmega328P/);
  });

  it('scanPins en un sketch AVR: números, A0, LED_BUILTIN y constantes', () => {
    const sketch = 'const int PIN_BOTON = 2;\n#define LED 12\nvoid setup(){ pinMode(PIN_BOTON, INPUT_PULLUP); pinMode(LED, OUTPUT); pinMode(LED_BUILTIN, OUTPUT); analogRead(A0); digitalWrite(7, 1); }';
    expect(scanPins('arduino', sketch, unoDesc)).toEqual([2, 7, 12, 13, 14]);
    // En un ESP32, "A0" no se toma como pin 14 del Uno.
    expect(scanPins('arduino', 'digitalWrite(7, 1); pinMode(6, INPUT);')).toEqual([6, 7]);
  });

  it('diffDiagramVsCode usa los nombres de la placa', () => {
    const w = diffDiagramVsCode(proyectoUno(), [2, 13, 4], unoDesc);
    expect(w.find((x) => x.pin === 4)!.message).toContain('D4');
    expect(w.some((x) => x.pin === 13)).toBe(false);
  });
});

describe('toolchains', () => {
  it('ESPHome en un C3: board/variant del C3, puente en GPIO0/1, sin RF y corrige un YAML de S3', async () => {
    const c3 = (await buscarPlaca('esp32-c3-devkitm-1'))!;
    const opciones = c3.desc.languages.esphome!.options;
    const archivos = TOOLCHAINS.esphome!.plantilla('esphome', c3, opciones);
    expect(archivos['main.yaml']).toContain('board: esp32-c3-devkitm-1');
    const proyecto = defaultProject('c', 'esphome', c3.id, c3.desc);
    const yamlDeS3 = archivos['main.yaml']!.replace('board: esp32-c3-devkitm-1', 'board: esp32-s3-devkitc-1');
    const r = buildSimYaml(proyecto, yamlDeS3.replaceAll('${name}', 'c'), { placa: placaEsphome(c3, opciones) });
    const doc = parse(r.text) as Record<string, any>;
    expect(doc.esp32.board).toBe('esp32-c3-devkitm-1');
    expect(r.warnings.join()).toContain('esp32.board era "esp32-s3-devkitc-1"');
    expect(doc.uart.at(-1)).toMatchObject({ tx_pin: 'GPIO0', rx_pin: 'GPIO1' });
    expect(doc.sim_bridge.bridge_rf_tx_channel).toBeUndefined();
    expect(doc.sim_bridge.inputs).toEqual([{ pin: 6, idle: 1 }]);
  });

  it('plantillas por placa: IDF con el target de la placa, Arduino AVR con D2/D13', async () => {
    const c6 = (await buscarPlaca('esp32-c6-devkitc-1'))!;
    const idf = TOOLCHAINS['esp-idf']!.plantilla('idf-c', c6, c6.desc.languages['idf-c']!.options);
    expect(idf['sdkconfig.defaults']).toContain('CONFIG_IDF_TARGET="esp32c6"');
    expect(idf['main/main.c']).toContain('GPIO_NUM_6');
    const uno = (await buscarPlaca('arduino-uno'))!;
    const sk = TOOLCHAINS['arduino-cli']!.plantilla('arduino', uno, uno.desc.languages.arduino!.options)['sketch.cpp']!;
    expect(sk).toContain('const int PIN_BOTON = 2;');
    expect(sk).toContain('const int PIN_LED = 13;');
  });

  it('errores de arduino-cli con archivo y línea del código del usuario', () => {
    const e = extractArduinoErrors([
      '/build/sketch/sketch.cpp: In function \'void loop()\':',
      "/build/sketch/sketch.cpp:14:1: error: expected ';' before '}' token",
      '/opt/arduino/data/packages/arduino/hardware/avr/1.8.6/cores/arduino/main.cpp:43:2: error: algo del core',
      'Error during build: exit status 1',
    ]);
    expect(e[0]).toEqual({ file: 'sketch.cpp', line: 14, message: "expected ';' before '}' token" });
    expect(e[1]).toMatchObject({ file: null, line: null });
    expect(e).toHaveLength(2);
    expect(extractArduinoErrors(["sketch.cpp:(.text+0x8): undefined reference to `foo()'"])[0]!.message).toContain('foo()');
  });
});
