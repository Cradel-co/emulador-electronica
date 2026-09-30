import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ModuleDefSchema, defaultProject, type ModuleDef, type Project } from '@emu/shared';
import { agregarModulo, conectar } from './diagramOps.js';
import { GPIO_MAX_MA, GPIO_RECOMENDADO_MA, LED_MAX_MA, analizarCircuito } from './circuitPhysics.js';

const def = (type: string, extra: Partial<ModuleDef> = {}): ModuleDef => ({
  type, name: type, category: 'x', programmable: false, passthrough: false,
  diode: false, diodeVfDefault: 2, svg: 'module.svg', width: 60, height: 50,
  pins: [], controls: [], props: {}, vars: {}, ...extra,
});

const RESISTOR = def('resistor', {
  pins: [{ name: '1', x: 0, y: 15, kind: 'other' }, { name: '2', x: 70, y: 15, kind: 'other' }],
  passthrough: true, ohmsProp: 'ohms',
  props: { ohms: { type: 'number', default: 220 } },
});
const LED = def('led', {
  pins: [{ name: 'IN', x: 10, y: 50, kind: 'digital-in' }, { name: 'GND', x: 30, y: 50, kind: 'ground' }],
  bridge: { role: 'output', pin: 'IN' },
  diode: true,
  props: { color: { type: 'string', default: 'red', enum: ['red', 'blue'] } },
  vars: { vf: { prop: 'color', map: { red: '2', blue: '3' }, default: '2' } },
});
// La placa: solo los pines que usan los tests (GPIO6/7 de la plantilla, GND, 3V3).
const PLACA = def('esp32-s3-devkitc-1', {
  programmable: true,
  pins: ['GPIO6', 'GPIO7', '3V3', 'GND'].map((name, i) => ({ name, x: 0, y: i * 10, kind: 'digital-io' as const })),
});
const CATALOGO = new Map([PLACA, RESISTOR, LED].map((d) => [d.type, d]));
const buscar = (t: string) => CATALOGO.get(t);

/** Proyecto de la plantilla, pero sin el cable directo led1.IN → GPIO7 (para meter un componente en el medio). */
function base(): Project {
  const p = defaultProject('p', 'esphome');
  return { ...p, wires: p.wires.filter((w) => !(w.from === 'led1.IN' && w.to === 'board.GPIO7')) };
}

function conProp(p: Project, id: string, prop: string, valor: string | number | boolean): Project {
  return { ...p, modules: p.modules.map((m) => (m.id === id ? { ...m, props: { ...m.props, [prop]: valor } } : m)) };
}

/** GPIO7 -> resistencia (ohms) -> led1 (color) -> GND. Devuelve también el id de la resistencia. */
function circuitoLedConResistencia(ohms: number, color = 'red'): Project {
  let p = conProp(base(), 'led1', 'color', color);
  const r = agregarModulo(p, RESISTOR);
  p = conProp(r.project, r.id, 'ohms', ohms);
  p = conectar(p, 'GPIO7', `${r.id}.1`, buscar).project;
  p = conectar(p, `${r.id}.2`, 'led1.IN', buscar).project;
  return p;
}

describe('analizarCircuito', () => {
  // Sin descriptor de placa ni datos del LED: valores por defecto (los del ESP32:
  // pin de salida de 33 Ω, fuentes de 0.5 Ω; LED de 5 mm: 15 Ω internos, 20/60 mA).
  it('LED con resistencia de 220 Ω a 3.3 V: corriente segura, sin avisos', () => {
    const { ramas, avisos, leds } = analizarCircuito(circuitoLedConResistencia(220), buscar);
    expect(ramas).toHaveLength(1);
    // I = (3.3 - 2) / (220 + 15 del LED + 33 del pin) ≈ 4.85 mA
    expect(ramas[0]!.amperios * 1000).toBeCloseTo(1.3 / 268 * 1000, 2);
    expect(avisos).toEqual([]);
    expect(leds).toEqual([{ id: 'led1', mA: 4.9, estado: 'ok' }]);
  });

  it('LED rojo directo al GPIO (como trae la plantilla): sobreexigido (~27 mA), no se quema', () => {
    // defaultProject() cablea led1.IN directo a GPIO7. Un ESP32 no puede dar corriente infinita:
    // su pin tiene resistencia interna, así que el LED queda sobreexigido pero no revienta.
    const { ramas, avisos, leds } = analizarCircuito(defaultProject('p', 'esphome'), buscar);
    expect(ramas[0]!.amperios * 1000).toBeCloseTo(1.3 / 48 * 1000, 1);
    expect(leds).toEqual([{ id: 'led1', mA: 27.1, estado: 'sobreexigido' }]);
    expect(avisos.some((a) => a.severidad === 'peligro')).toBe(false);
    expect(avisos.map((a) => a.mensaje).join()).toContain('brilla de más y dura menos');
    expect(avisos.map((a) => a.mensaje).join()).not.toContain('se va a quemar');
    expect(avisos.some((a) => a.severidad === 'advertencia' && a.mensaje.includes(`${GPIO_RECOMENDADO_MA} mA`))).toBe(true);
  });

  it('GPIO a GND por una resistencia chica: supera el máximo del pin (40 mA) → peligro', () => {
    // El GPIO7 es salida (maneja el LED con su resistencia) y además tiene 10 Ω directo a GND.
    let p = circuitoLedConResistencia(220);
    const r = agregarModulo(p, RESISTOR);
    p = conProp(r.project, r.id, 'ohms', 10);
    p = conectar(p, 'GPIO7', `${r.id}.1`, buscar).project;
    p = conectar(p, `${r.id}.2`, 'board.GND', buscar).project;
    const { avisos } = analizarCircuito(p, buscar); // 3.3 / (10 + 33) ≈ 77 mA
    expect(avisos.some((a) => a.severidad === 'peligro' && a.mensaje.includes(`${GPIO_MAX_MA} mA`))).toBe(true);
  });

  it('LED con resistencia un poco chica: por encima de lo recomendado → advertencia, sin peligro', () => {
    const { avisos, leds } = analizarCircuito(circuitoLedConResistencia(10), buscar); // 1.3 / 58 ≈ 22 mA
    expect(avisos.some((a) => a.severidad === 'advertencia' && a.mensaje.includes(`${LED_MAX_MA} mA`))).toBe(true);
    expect(avisos.some((a) => a.severidad === 'peligro')).toBe(false);
    expect(leds[0]!.estado).toBe('sobreexigido');
  });

  it('LED azul (Vf 3 V) directo a 3.3 V: apenas conduce (~6 mA), sin avisos', () => {
    const p = conProp(defaultProject('p', 'esphome'), 'led1', 'color', 'blue');
    const { avisos, leds } = analizarCircuito(p, buscar);
    expect(leds[0]).toMatchObject({ estado: 'ok' });
    expect(leds[0]!.mA).toBeCloseTo(0.3 / 48 * 1000, 0);
    expect(avisos).toEqual([]);
  });

  it('resistencia de sobra: corriente chica, sin avisos', () => {
    const { ramas, avisos } = analizarCircuito(circuitoLedConResistencia(10_000), buscar);
    expect(ramas[0]!.amperios * 1000).toBeLessThan(1);
    expect(avisos).toEqual([]);
  });

  it('GPIO en bajo: no hay corriente (sin dato de simulación, se asume el peor caso; con dato real, se usa)', () => {
    const p = circuitoLedConResistencia(220);
    expect(analizarCircuito(p, buscar).ramas).toHaveLength(1); // sin datos: peor caso = alto
    expect(analizarCircuito(p, buscar, new Map([[7, 0]])).ramas).toHaveLength(0); // simulación real: está en bajo
    expect(analizarCircuito(p, buscar, new Map([[7, 0]])).leds).toEqual([{ id: 'led1', mA: 0, estado: 'ok' }]);
    expect(analizarCircuito(p, buscar, new Map([[7, 1]])).ramas).toHaveLength(1);
  });

  it('resistencia con una pata sin conectar: no hay camino, no hay corriente', () => {
    let p = base();
    const r = agregarModulo(p, RESISTOR);
    p = conectar(r.project, 'GPIO7', `${r.id}.1`, buscar).project; // la pata 2 queda al aire
    expect(analizarCircuito(p, buscar).ramas).toEqual([]);
  });

  it('dos LEDs en el mismo GPIO: cada uno bien, pero la suma se avisa', () => {
    // led1: 220 Ω → ≈4.9 mA (usa el led1 y el cableado de GND que ya trae la plantilla).
    let p = circuitoLedConResistencia(220);
    // led2: otro LED con 22 Ω (≈18.6 mA), colgado del mismo GPIO7.
    const led2 = agregarModulo(p, LED);
    p = led2.project;
    const r2 = agregarModulo(p, RESISTOR);
    p = conProp(r2.project, r2.id, 'ohms', 22);
    p = conectar(p, 'GPIO7', `${r2.id}.1`, buscar).project;
    p = conectar(p, `${r2.id}.2`, `${led2.id}.IN`, buscar).project;
    p = conectar(p, `${led2.id}.GND`, 'board.GND', buscar).project;

    const { ramas, avisos, leds } = analizarCircuito(p, buscar);
    expect(ramas).toHaveLength(2);
    expect(leds.every((l) => l.estado === 'ok')).toBe(true);
    const total = ramas.reduce((s, r) => s + r.amperios * 1000, 0);
    expect(total).toBeGreaterThan(GPIO_RECOMENDADO_MA);
    expect(avisos.some((a) => a.mensaje.includes('Entre todo lo que cuelga de GPIO7 suman'))).toBe(true);
  });

  it('3V3 cableado directo a un LED (sin pasar por el ESP32): ~84 mA, se quema', () => {
    // base() saca el cable led1.IN→GPIO7, pero deja led1.GND→GND: solo falta la fuente.
    const p = conectar(base(), 'board.3V3', 'led1.IN', buscar).project;
    const { avisos, leds } = analizarCircuito(p, buscar);
    expect(leds[0]!.estado).toBe('se-quema');
    expect(leds[0]!.mA).toBeCloseTo(1.3 / 15.5 * 1000, 0);
    expect(avisos.some((a) => a.severidad === 'peligro' && a.mensaje.includes('se va a quemar'))).toBe(true);
  });

  it('sin ningún componente eléctrico (solo el botón cableado): no hay ramas ni avisos', () => {
    const original = defaultProject('p', 'esphome');
    const p = { ...original, modules: original.modules.filter((m) => m.id !== 'led1') };
    const { ramas, avisos, leds } = analizarCircuito(p, buscar);
    expect(ramas).toEqual([]);
    expect(avisos).toEqual([]);
    expect(leds).toEqual([]);
  });
});

describe('LED que se quema de verdad, con las placas y el LED reales del catálogo', () => {
  const real = (t: string): ModuleDef =>
    ModuleDefSchema.parse(JSON.parse(readFileSync(new URL(`../../../modules/${t}/module.json`, import.meta.url), 'utf8')));
  const cat = new Map(['esp32-s3-devkitc-1', 'arduino-uno', 'led', 'resistor', 'button'].map((t) => [t, real(t)]));
  const b = (t: string) => cat.get(t);
  const uno = () => defaultProject('u', 'arduino', 'arduino-uno', real('arduino-uno').board);
  const sinResistencia = (p: Project, pin: string): Project => ({
    ...p,
    modules: p.modules.filter((m) => m.id !== 'r1'),
    wires: [...p.wires.filter((w) => !w.from.startsWith('r1.') && !w.to.startsWith('r1.') && w.from !== 'led1.IN'), { from: 'led1.IN', to: pin }],
  });

  it('LED rojo directo a un GPIO del ESP32-S3: sobreexigido (~27 mA)', () => {
    const { leds } = analizarCircuito(defaultProject('s', 'esphome', 'esp32-s3-devkitc-1', real('esp32-s3-devkitc-1').board), b);
    expect(leds).toEqual([{ id: 'led1', mA: 27.1, estado: 'sobreexigido' }]);
  });

  it('LED rojo directo a D13 del Uno (5 V, 25 Ω de pin): ~75 mA, se quema', () => {
    const { leds, avisos } = analizarCircuito(sinResistencia(uno(), 'board.D13'), b);
    expect(leds).toEqual([{ id: 'led1', mA: 75, estado: 'se-quema' }]);
    expect(avisos.map((a) => a.mensaje).join()).toContain('se va a quemar');
    expect(avisos.some((a) => a.severidad === 'peligro' && a.mensaje.includes('D13 tendría que entregar ~75 mA') && a.mensaje.includes('ATmega328P'))).toBe(true);
  });

  it('con 220 Ω en el Uno: ~11.5 mA, ok, sin avisos', () => {
    const { leds, avisos, ramas } = analizarCircuito(uno(), b);
    expect(ramas[0]!.origenV).toBe(5);
    expect(leds).toEqual([{ id: 'led1', mA: 11.5, estado: 'ok' }]);
    expect(avisos).toEqual([]);
  });

  it('LED directo entre 3V3 y GND (sin código de por medio): se quema', () => {
    const { leds } = analizarCircuito(sinResistencia(uno(), 'board.3V3'), b);
    expect(leds[0]!.estado).toBe('se-quema');
  });
});
