import { describe, expect, it } from 'vitest';
import { defaultProject, type ModuleDef, type Project } from '@emu/shared';
import {
  agregarModulo,
  cableadosConRol,
  conectar,
  configurarModulo,
  desconectar,
  gpioDe,
  moverModulo,
  normalizarRef,
  pinesSinAlimentar,
  quitarModulo,
} from './diagramOps.js';

const def = (type: string, extra: Partial<ModuleDef> = {}): ModuleDef => ({
  type,
  name: type,
  category: 'x',
  programmable: false,
  passthrough: false,
  diode: false,
  diodeVfDefault: 2,
  svg: 'module.svg',
  width: 60,
  height: 50,
  pins: [],
  controls: [],
  props: {},
  vars: {},
  chips: [],
  salidas: [],
  ...extra,
});

const PLACA = def('esp32-s3-devkitc-1', {
  programmable: true,
  pins: ['GPIO4', 'GPIO6', 'GPIO7', 'GPIO17', '3V3', 'GND'].map((name, i) => ({ name, x: 0, y: i * 10, kind: 'digital-io' as const })),
});
const RXB6 = def('rxb6', {
  pins: [
    { name: 'DATA', x: 10, y: 50, kind: 'digital-out' },
    { name: 'VCC', x: 30, y: 50, kind: 'power' },
    { name: 'GND', x: 50, y: 50, kind: 'ground' },
  ],
  bridge: { role: 'rf-rx', pin: 'DATA' },
});

/** Cablea DATA + VCC + GND de un rxb6 al ESP32: lo deja "alimentado", como en la vida real. */
function conRxb6Alimentado(project: Project): Project {
  project = conectar(project, 'rx1.DATA', 'GPIO4', buscar).project;
  project = conectar(project, 'rx1.VCC', 'board.3V3', buscar).project;
  return conectar(project, 'rx1.GND', 'board.GND', buscar).project;
}
const LED = def('led', {
  pins: [
    { name: 'IN', x: 10, y: 50, kind: 'digital-in' },
    { name: 'GND', x: 30, y: 50, kind: 'ground' },
  ],
  bridge: { role: 'output', pin: 'IN' },
  props: { color: { type: 'string', default: 'red', enum: ['red', 'green'] } },
});
const BOTON = def('button', {
  pins: [
    { name: 'OUT', x: 10, y: 50, kind: 'digital-out' },
    { name: 'GND', x: 30, y: 50, kind: 'ground' },
  ],
  bridge: { role: 'input', pin: 'OUT', activeLevel: 0 },
});
const CATALOGO = new Map([PLACA, RXB6, LED, BOTON].map((d) => [d.type, d]));
const buscar = (t: string) => CATALOGO.get(t);

describe('diagramOps', () => {
  it('agrega con id automático y props por defecto', () => {
    const p0 = defaultProject('p', 'esphome');
    const { project, id } = agregarModulo(p0, RXB6);
    expect(id).toBe('rx1');
    expect(agregarModulo(project, RXB6).id).toBe('rx2');
    expect(agregarModulo(p0, LED).project.modules.at(-1)!.props).toEqual({ color: 'red' });
    expect(() => agregarModulo(p0, PLACA)).toThrow('ya tiene su placa');
    expect(() => agregarModulo(p0, LED, { id: 'btn1' })).toThrow('ya hay un módulo');
    expect(() => agregarModulo(p0, LED, { props: { color: 'violeta' } })).toThrow('uno de: red, green');
  });

  it('conecta aceptando "GPIO4" y deja la placa en `to`', () => {
    const { project: base } = agregarModulo(defaultProject('p', 'esphome'), RXB6);
    const r = conectar(base, 'GPIO4', 'rx1.DATA', buscar);
    expect(r.wire).toEqual({ from: 'rx1.DATA', to: 'board.GPIO4' });
    expect(gpioDe(r.project, 'rx1', 'DATA')).toBe(4);
    // Con DATA conectado pero sin alimentar todavía, no cuenta como "listo".
    expect(cableadosConRol(r.project, 'rf-rx', buscar)).toEqual([]);
    expect(cableadosConRol(conRxb6Alimentado(base), 'rf-rx', buscar).map((m) => m.id)).toEqual(['rx1']);
  });

  it('valida los pines con mensajes útiles', () => {
    const { project } = agregarModulo(defaultProject('p', 'esphome'), RXB6);
    expect(() => conectar(project, 'rx1.NOPE', 'GPIO4', buscar)).toThrow('Pines: DATA, VCC, GND');
    expect(() => conectar(project, 'zz1.DATA', 'GPIO4', buscar)).toThrow('Módulos: board');
    expect(() => conectar(project, 'rx1.DATA', 'GPIO17', buscar)).toThrow('puente de simulación');
    expect(() => conectar(project, 'rx1.DATA', 'rx1.VCC', buscar)).toThrow('mismo módulo');
    expect(() => conectar(project, 'btn1.OUT', 'GPIO6', buscar)).toThrow('ya están conectados');
    expect(() => conectar(project, 'rx1', 'GPIO4', buscar)).toThrow('módulo.PIN');
  });

  it('desconecta un cable o todos los de un pin, y quitar un módulo borra sus cables', () => {
    const p0 = defaultProject('p', 'esphome');
    expect(desconectar(p0, 'btn1.OUT', 'GPIO6').quitados).toEqual([{ from: 'btn1.OUT', to: 'board.GPIO6' }]);
    expect(desconectar(p0, 'board.GND').quitados).toHaveLength(2);
    expect(() => desconectar(p0, 'btn1.OUT', 'GPIO7')).toThrow('no hay un cable');
    const sinBoton = quitarModulo(p0, 'btn1');
    expect(sinBoton.wires.some((w) => w.from.startsWith('btn1.'))).toBe(false);
    // La placa es un módulo más: quitarla deja el proyecto sin placa (ni lenguaje) y sin sus cables.
    const sinPlaca = quitarModulo(p0, 'board');
    expect(sinPlaca.board).toBeNull();
    expect(sinPlaca.language).toBeNull();
    expect(sinPlaca.modules.some((m) => m.id === 'board')).toBe(false);
    expect(sinPlaca.wires.some((w) => w.from.startsWith('board.') || w.to.startsWith('board.'))).toBe(false);
    expect(() => quitarModulo(sinPlaca, 'board')).toThrow('no tiene placa');
  });

  it('mueve y configura', () => {
    const p0 = defaultProject('p', 'esphome');
    expect(moverModulo(p0, 'led1', 10.4, -3).modules.find((m) => m.id === 'led1')).toMatchObject({ x: 10, y: -3 });
    expect(configurarModulo(p0, 'led1', LED, { color: 'green' }).modules.find((m) => m.id === 'led1')!.props.color).toBe('green');
    expect(() => configurarModulo(p0, 'led1', LED, { brillo: 3 })).toThrow('no tiene la propiedad');
  });

  it('sin GND/VCC cableados, el módulo no cuenta como listo (como en la vida real)', () => {
    let { project } = agregarModulo(defaultProject('p', 'esphome'), RXB6);
    project = conectar(project, 'rx1.DATA', 'GPIO4', buscar).project;
    // DATA conectado, pero VCC y GND todavía no: no está "listo".
    expect(pinesSinAlimentar(project, 'rx1', RXB6)).toEqual(['VCC', 'GND']);
    expect(cableadosConRol(project, 'rf-rx', buscar)).toEqual([]);

    project = conectar(project, 'rx1.VCC', 'board.3V3', buscar).project;
    project = conectar(project, 'rx1.GND', 'board.GND', buscar).project;
    expect(pinesSinAlimentar(project, 'rx1', RXB6)).toEqual([]);
    expect(cableadosConRol(project, 'rf-rx', buscar).map((m) => m.id)).toEqual(['rx1']);
  });

  it('el proyecto por defecto ya trae GND cableado (btn1 y led1 funcionan de entrada)', () => {
    const p0 = defaultProject('p', 'esphome');
    const boton = p0.modules.find((m) => m.id === 'btn1')!;
    const led = p0.modules.find((m) => m.id === 'led1')!;
    expect(pinesSinAlimentar(p0, boton.id, CATALOGO.get(boton.type)!)).toEqual([]);
    expect(pinesSinAlimentar(p0, led.id, CATALOGO.get(led.type)!)).toEqual([]);
  });

  it('normaliza referencias de la placa', () => {
    expect(normalizarRef('6')).toBe('board.GPIO6');
    expect(normalizarRef('gpio21')).toBe('board.GPIO21');
    expect(normalizarRef('board.7')).toBe('board.GPIO7');
    expect(normalizarRef('btn1.OUT')).toBe('btn1.OUT');
  });
});

describe('dibujo con varias placas', () => {
  async function placaReal() {
    const { readFile } = await import('node:fs/promises');
    const { ModuleDefSchema } = await import('@emu/shared');
    const { PATHS } = await import('./paths.js');
    return ModuleDefSchema.parse(JSON.parse(await readFile(`${PATHS.modules}/esp32-s3-devkitc-1/module.json`, 'utf8')));
  }

  it('agrega placas con ids propios y conserva la placa histórica y sus cables', async () => {
    const { ponerPlaca, conPlaca } = await import('./diagramOps.js');
    const base = defaultProject('multi', 'micropython');
    const def = await placaReal();
    const segundo = ponerPlaca(base, def, 'micropython');
    const tercero = ponerPlaca(segundo, def, 'micropython');
    expect(segundo.boards?.map((board) => board.id)).toEqual(['board', 'board2']);
    expect(tercero.boards?.map((board) => board.id)).toEqual(['board', 'board2', 'board3']);
    expect(segundo.wires).toEqual(base.wires);
    expect(segundo.modules.find((module) => module.id === 'board')).toEqual(base.modules[0]);
    const reparado = conPlaca({ ...tercero, modules: tercero.modules.filter((module) => !module.id.startsWith('board')) });
    expect(reparado.modules.filter((module) => module.id.startsWith('board')).map((module) => module.id)).toEqual(['board', 'board2', 'board3']);
    expect(() => ponerPlaca(segundo, def, 'micropython', { id: 'board' })).toThrow('ya hay');
    expect(() => ponerPlaca(segundo, def, 'micropython', { id: '../escape' })).toThrow('inválido');
  });

  it('quitar una placa conserva las demás y limpia únicamente sus cables', async () => {
    const { ponerPlaca, sacarPlaca } = await import('./diagramOps.js');
    const base = ponerPlaca(defaultProject('multi', 'micropython'), await placaReal(), 'micropython');
    const conCable = { ...base, wires: [...base.wires, { from: 'board2.GPIO4', to: 'led1.IN' }] };
    const sinSegunda = quitarModulo(conCable, 'board2');
    expect(sinSegunda.boards?.map((board) => board.id)).toEqual(['board']);
    expect(sinSegunda.wires).toEqual(base.wires);
    const sinPrimera = sacarPlaca(conCable);
    expect(sinPrimera.boards?.map((board) => board.id)).toEqual(['board2']);
    expect(sinPrimera.board).toBe(base.board);
    expect(sinPrimera.modules.some((module) => module.id === 'board')).toBe(false);
    expect(sinPrimera.wires).toEqual([{ from: 'board2.GPIO4', to: 'led1.IN' }]);
    const vacio = sacarPlaca(sinPrimera, 'board2');
    expect(vacio.board).toBeNull();
    expect(vacio.language).toBeNull();
    expect(vacio.boards).toEqual([]);
  });

  it('resuelve GPIO y pines reservados usando la placa seleccionada', async () => {
    const { ponerPlaca, gpioDeRef } = await import('./diagramOps.js');
    const def = await placaReal();
    const buscarReal = (type: string) => type === def.type ? def : buscar(type);
    const base = ponerPlaca(defaultProject('multi', 'micropython'), def, 'micropython');
    const connected = conectar(base, 'board2.GPIO4', 'led1.IN', buscarReal).project;
    expect(gpioDe(connected, 'led1', 'IN', buscarReal, 'board2')).toBe(4);
    expect(gpioDeRef('board2.GPIO4', def.board, 'board2')).toBe(4);
    expect(() => conectar(base, 'board2.GPIO17', 'led1.IN', buscarReal)).toThrow('no se puede usar');
  });
});
