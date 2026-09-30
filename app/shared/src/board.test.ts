import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BoardDescriptorSchema, chequearDescriptor, gpioDePin, lenguajesDe, motivoReservado, nombreDePin } from './board.js';
import { ModuleDefSchema } from './module.js';
import { defaultProject, ProjectSchema } from './project.js';

/** module.json real de una placa del catálogo de fábrica. */
function placa(tipo: string) {
  const raw = JSON.parse(readFileSync(new URL(`../../../modules/${tipo}/module.json`, import.meta.url), 'utf8'));
  return ModuleDefSchema.parse(raw);
}

const PLACAS = ['esp32-s3-devkitc-1', 'esp32-c3-devkitm-1', 'esp32-c6-devkitc-1', 'arduino-uno'];

describe('descriptores de las placas de fábrica', () => {
  it.each(PLACAS)('%s: es programable, tiene "board" y pasa los chequeos', (tipo) => {
    const def = placa(tipo);
    expect(def.programmable).toBe(true);
    expect(def.board).toBeDefined();
    expect(chequearDescriptor(def.board!, def.pins.map((p) => p.name))).toEqual([]);
    expect(def.board!.demo).toBeDefined();
  });

  it('ESP32-S3: los mismos pines reservados de siempre y el puente en UART1 (17/18)', () => {
    const d = placa('esp32-s3-devkitc-1').board!;
    expect(Object.keys(d.reservedPins).map(Number).sort((a, b) => a - b)).toEqual([17, 18, 43, 44]);
    expect(d.io).toEqual({ mode: 'bridge-uart', uart: 1, tx: 17, rx: 18 });
    expect(d.backend).toEqual({ engine: 'esp-emu', options: { chip: 'esp32s3' } });
    expect(lenguajesDe(d)).toEqual(['esphome', 'idf-c', 'idf-cpp', 'arduino', 'micropython']);
    expect(d.logicVoltage).toBe(3.3);
  });

  it('C3 y C6: puente en GPIO0/1, consola reservada y chip de esp-emu', () => {
    const c3 = placa('esp32-c3-devkitm-1').board!;
    expect(c3.backend.options.chip).toBe('esp32c3');
    expect(c3.io).toMatchObject({ mode: 'bridge-uart', tx: 0, rx: 1 });
    expect(Object.keys(c3.reservedPins).sort()).toEqual(['0', '1', '20', '21']);
    const c6 = placa('esp32-c6-devkitc-1').board!;
    expect(c6.backend.options.chip).toBe('esp32c6');
    expect(Object.keys(c6.reservedPins).sort()).toEqual(['0', '1', '16', '17']);
    // Ninguno de los dos simula RF todavía.
    expect(c3.features).not.toContain('rf433');
    expect(c6.features).not.toContain('rf433');
  });

  it('Arduino Uno: 5 V, nativo (avr8js), solo Arduino, D13 = PB5, A0 = 14 = PC0', () => {
    const d = placa('arduino-uno').board!;
    expect(d.logicVoltage).toBe(5);
    expect(d.io).toEqual({ mode: 'native' });
    expect(d.backend.engine).toBe('avr8js');
    expect(lenguajesDe(d)).toEqual(['arduino']);
    expect(d.pins.D13).toMatchObject({ gpio: 13, port: 'B', bit: 5 });
    expect(d.pins.A0).toMatchObject({ gpio: 14, port: 'C', bit: 0 });
    expect(d.pins.D2).toMatchObject({ gpio: 2, port: 'D', bit: 2 });
    const def = placa('arduino-uno');
    const tipo = (n: string) => def.pins.find((p) => p.name === n)?.kind;
    expect([tipo('5V'), tipo('3V3'), tipo('VIN'), tipo('GND'), tipo('D13'), tipo('A0')]).toEqual([
      'power', 'power', 'power', 'ground', 'digital-io', 'digital-io',
    ]);
  });
});

describe('consultas sobre un descriptor', () => {
  const uno = placa('arduino-uno').board!;

  it('gpioDePin / nombreDePin con descriptor (Uno) y sin él (GPIOn de siempre)', () => {
    expect(gpioDePin(uno, 'D13')).toBe(13);
    expect(gpioDePin(uno, 'A5')).toBe(19);
    expect(gpioDePin(uno, 'GND')).toBeNull();
    expect(gpioDePin(uno, 'GPIO13')).toBeNull();
    expect(nombreDePin(uno, 18)).toBe('A4'); // no "SDA": el primero que lo tiene
    expect(gpioDePin(undefined, 'GPIO7')).toBe(7);
    expect(nombreDePin(undefined, 7)).toBe('GPIO7');
  });

  it('motivoReservado', () => {
    const s3 = placa('esp32-s3-devkitc-1').board!;
    expect(motivoReservado(s3, 17)).toContain('puente');
    expect(motivoReservado(s3, 6)).toBeNull();
    expect(motivoReservado(uno, 0)).toBeNull(); // D0 es advertencia, no reservado
  });
});

describe('chequearDescriptor: errores que un tercero puede cometer', () => {
  const def = placa('arduino-uno');
  const pines = def.pins.map((p) => p.name);
  const con = (cambio: Record<string, unknown>) => BoardDescriptorSchema.parse({ ...def.board!, ...cambio });

  it('pin del descriptor que no existe en el módulo', () => {
    const d = con({ pins: { ...def.board!.pins, D99: { gpio: 99, port: 'B', bit: 7 } } });
    expect(chequearDescriptor(d, pines).join()).toContain('D99');
  });

  it('modo nativo sin port/bit', () => {
    const d = con({ pins: { ...def.board!.pins, D2: { gpio: 2 } } });
    expect(chequearDescriptor(d, pines).join()).toContain('port y bit');
  });

  it('puente UART en pines que no están reservados', () => {
    const d = con({ io: { mode: 'bridge-uart', uart: 1, tx: 5, rx: 6 } });
    expect(chequearDescriptor(d, pines).join()).toContain('reservedPins');
  });

  it('circuito de prueba en un pin reservado o sin la capacidad', () => {
    expect(chequearDescriptor(con({ reservedPins: { '2': 'x' } }), pines).join()).toContain('demo.input');
    expect(chequearDescriptor(con({ demo: { input: 'GND', output: 'D13' } }), pines).join()).toContain('demo.input');
  });

  it('motor o toolchain que no existen', () => {
    const e = chequearDescriptor(def.board!, pines, { engines: ['esp-emu'], toolchains: ['esphome'] }).join();
    expect(e).toContain('avr8js');
    expect(e).toContain('arduino-cli');
  });

  it('el esquema rechaza lenguajes desconocidos y un io.mode inventado', () => {
    expect(BoardDescriptorSchema.safeParse({ ...def.board!, languages: { rust: { toolchain: 'cargo' } } }).success).toBe(false);
    expect(BoardDescriptorSchema.safeParse({ ...def.board!, io: { mode: 'magia' } }).success).toBe(false);
  });
});

describe('defaultProject con descriptor', () => {
  it('Uno: botón en D2, LED en D13 con su resistencia de 220 Ω (a 5 V sin resistencia se quema)', () => {
    const p = defaultProject('u', 'arduino', 'arduino-uno', placa('arduino-uno').board);
    expect(p.board).toBe('arduino-uno');
    expect(p.modules.map((m) => m.id)).toEqual(['board', 'btn1', 'led1', 'r1']);
    expect(p.wires).toContainEqual({ from: 'btn1.OUT', to: 'board.D2' });
    expect(p.wires).toContainEqual({ from: 'r1.1', to: 'board.D13' });
    expect(p.wires).toContainEqual({ from: 'led1.IN', to: 'r1.2' });
    expect(ProjectSchema.parse(p)).toEqual(p);
  });

  it('una plantilla de dibujo propia de la placa gana sobre la de demo', () => {
    const d = BoardDescriptorSchema.parse({
      ...placa('arduino-uno').board!,
      templates: { arduino: { diagram: { modules: [{ id: 'led9', type: 'led', x: 1, y: 2 }], wires: [{ from: 'led9.IN', to: 'board.D9' }] } } },
    });
    const p = defaultProject('u', 'arduino', 'arduino-uno', d);
    expect(p.modules.map((m) => m.id)).toEqual(['board', 'led9']);
    expect(p.wires).toEqual([{ from: 'led9.IN', to: 'board.D9' }]);
  });
});
