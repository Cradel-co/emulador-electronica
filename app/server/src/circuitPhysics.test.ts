import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ModuleDefSchema, defaultProject, type ModuleDef, type Project } from '@emu/shared';
import { agregarModulo, conectar } from './diagramOps.js';
import { GPIO_MAX_MA, GPIO_RECOMENDADO_MA, LED_MAX_MA, analizarCircuito } from './circuitPhysics.js';

/** La placa enchufada por USB: desde que las placas del catálogo declaran `power`, sin alimentación no corre nada. */
const conUsb = (p: Project): Project => ({
  ...p,
  modules: [{ id: 'board', type: p.board, x: 0, y: 0, props: { usb: true } }, ...p.modules.filter((m) => m.id !== 'board')],
});

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
    expect(leds).toMatchObject([{ id: 'led1', mA: 4.9, estado: 'ok' }]);
  });

  it('LED rojo directo al GPIO (como trae la plantilla): sobreexigido (~27 mA), no se quema', () => {
    // defaultProject() cablea led1.IN directo a GPIO7. Un ESP32 no puede dar corriente infinita:
    // su pin tiene resistencia interna, así que el LED queda sobreexigido pero no revienta.
    const { ramas, avisos, leds } = analizarCircuito(defaultProject('p', 'esphome'), buscar);
    expect(ramas[0]!.amperios * 1000).toBeCloseTo(1.3 / 48 * 1000, 1);
    expect(leds).toMatchObject([{ id: 'led1', mA: 27.1, estado: 'sobreexigido' }]);
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
    expect(analizarCircuito(p, buscar, new Map([[7, 0]])).leds).toMatchObject([{ id: 'led1', mA: 0, estado: 'ok' }]);
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
  const uno = () => conUsb(defaultProject('u', 'arduino', 'arduino-uno', real('arduino-uno').board));
  const sinResistencia = (p: Project, pin: string): Project => ({
    ...p,
    modules: p.modules.filter((m) => m.id !== 'r1'),
    wires: [...p.wires.filter((w) => !w.from.startsWith('r1.') && !w.to.startsWith('r1.') && w.from !== 'led1.IN'), { from: 'led1.IN', to: pin }],
  });

  it('LED rojo directo a un GPIO del ESP32-S3: sobreexigido (~27 mA)', () => {
    const { leds } = analizarCircuito(conUsb(defaultProject('s', 'esphome', 'esp32-s3-devkitc-1', real('esp32-s3-devkitc-1').board)), b);
    expect(leds).toMatchObject([{ id: 'led1', mA: 27.1, estado: 'sobreexigido' }]);
  });

  it('LED rojo directo a D13 del Uno (5 V, 25 Ω de pin): ~75 mA, se quema', () => {
    const { leds, avisos } = analizarCircuito(sinResistencia(uno(), 'board.D13'), b);
    expect(leds).toMatchObject([{ id: 'led1', mA: 75, estado: 'se-quema' }]);
    expect(avisos.map((a) => a.mensaje).join()).toContain('se va a quemar');
    expect(avisos.some((a) => a.severidad === 'peligro' && a.mensaje.includes('D13 tendría que entregar ~75 mA') && a.mensaje.includes('ATmega328P'))).toBe(true);
  });

  it('con 220 Ω en el Uno: ~11.5 mA, ok, sin avisos', () => {
    const { leds, avisos, ramas } = analizarCircuito(uno(), b);
    expect(ramas[0]!.origenV).toBe(5);
    expect(leds).toMatchObject([{ id: 'led1', mA: 11.5, estado: 'ok' }]);
    expect(avisos).toEqual([]);
  });

  it('LED directo entre 3V3 y GND (sin código de por medio): se quema', () => {
    const { leds } = analizarCircuito(sinResistencia(uno(), 'board.3V3'), b);
    expect(leds[0]!.estado).toBe('se-quema');
  });
});

describe('alimentación de la placa y fuente regulable (placas y fuente reales del catálogo)', () => {
  const real = (t: string): ModuleDef =>
    ModuleDefSchema.parse(JSON.parse(readFileSync(new URL(`../../../modules/${t}/module.json`, import.meta.url), 'utf8')));
  const cat = new Map(['esp32-s3-devkitc-1', 'fuente-regulable', 'led', 'resistor', 'button'].map((t) => [t, real(t)]));
  const b = (t: string) => cat.get(t);
  const s3 = (): Project => defaultProject('s', 'esphome', 'esp32-s3-devkitc-1', real('esp32-s3-devkitc-1').board);
  /** La S3 alimentada por una fuente en `pin`, con `props` y (si `gnd`) su GND al de la placa. */
  const conFuente = (props: Record<string, number>, pin = 'board.5V', gnd = true): Project => {
    const p = s3();
    return {
      ...p,
      modules: [...p.modules, { id: 'f1', type: 'fuente-regulable', x: 0, y: 0, props }],
      wires: [...p.wires, { from: 'f1.V', to: pin }, ...(gnd ? [{ from: 'f1.GND', to: 'board.GND_2' }] : [])],
    };
  };

  it('sin USB ni fuente: no tiene energía y sus GPIO no entregan nada', () => {
    const { alimentacion, ramas, avisos } = analizarCircuito(s3(), b);
    expect(alimentacion.estado).toBe('sin-energia');
    expect(ramas).toEqual([]);
    expect(avisos[0]!.mensaje).toMatch(/no tiene alimentación.*USB conectado/);
  });

  it('con USB: arranca y el LED de la plantilla lleva corriente', () => {
    const p = s3();
    p.modules = [{ id: 'board', type: p.board, x: 0, y: 0, props: { usb: true } }, ...p.modules.filter((m) => m.id !== 'board')];
    const { alimentacion, leds } = analizarCircuito(p, b);
    expect(alimentacion).toMatchObject({ estado: 'ok', via: 'usb' });
    expect(leds[0]!.mA).toBeGreaterThan(0);
  });

  it('fuente de 5 V en 5V con GND: arranca, y la fuente paga la placa (~120 mA) más el LED', () => {
    const { alimentacion, fuentes } = analizarCircuito(conFuente({ voltage: 5, currentLimitMa: 500 }), b);
    expect(alimentacion).toMatchObject({ estado: 'ok', via: 'fuente', fuenteId: 'f1', pin: '5V' });
    expect(fuentes[0]).toMatchObject({ id: 'f1', modo: 'CV', vSalida: 5 });
    expect(fuentes[0]!.mA!).toBeGreaterThan(120);
  });

  it('fuente sin su GND al de la placa: el circuito no cierra', () => {
    const { alimentacion } = analizarCircuito(conFuente({ voltage: 5 }, 'board.5V', false), b);
    expect(alimentacion.estado).toBe('sin-energia');
    expect(alimentacion.mensaje).toMatch(/GND no está unido/);
  });

  it('límite de corriente menor al consumo de la placa: modo CC, la tensión cae y no arranca', () => {
    const { alimentacion, fuentes } = analizarCircuito(conFuente({ voltage: 5, currentLimitMa: 50 }), b);
    expect(alimentacion.estado).toBe('baja');
    expect(fuentes[0]).toMatchObject({ modo: 'CC', mA: 50 });
    expect(fuentes[0]!.vSalida).toBeLessThan(5);
  });

  it('tensión insuficiente (3,5 V en 5V): no arranca', () => {
    expect(analizarCircuito(conFuente({ voltage: 3.5 }), b).alimentacion.estado).toBe('baja');
  });

  it('sobretensión (12 V en 5V) o polaridad invertida: se quema', () => {
    expect(analizarCircuito(conFuente({ voltage: 12 }), b).alimentacion.estado).toBe('quema');
    const invertida = analizarCircuito(conFuente({ voltage: -5 }), b).alimentacion;
    expect(invertida.estado).toBe('quema');
    expect(invertida.mensaje).toMatch(/polaridad invertida/);
  });

  it('3,3 V directo al pin 3V3: arranca, sin chocar contra un "3V3 fijo" de la placa', () => {
    const { alimentacion, avisos } = analizarCircuito(conFuente({ voltage: 3.3 }, 'board.3V3'), b);
    expect(alimentacion).toMatchObject({ estado: 'ok', entrada: '3v3' });
    // Entra por el 3V3: ese pin deja de ser una salida de la placa, así que no es un cortocircuito.
    expect(avisos.some((a) => /cortocircuito/.test(a.mensaje))).toBe(false);
  });

  it('fuente limitada alimentando un LED sin resistencia: el LED recibe solo el límite y no se quema', () => {
    const p = s3();
    p.modules = [
      { id: 'board', type: p.board, x: 0, y: 0, props: { usb: true } },
      ...p.modules.filter((m) => m.id !== 'board' && m.id !== 'led1'),
      { id: 'led9', type: 'led', x: 0, y: 0, props: { color: 'red' } },
      { id: 'f1', type: 'fuente-regulable', x: 0, y: 0, props: { voltage: 9, currentLimitMa: 10 } },
    ];
    p.wires = [...p.wires.filter((w) => !w.from.startsWith('led1.') && !w.to.startsWith('led1.')),
      { from: 'f1.V', to: 'led9.IN' }, { from: 'led9.GND', to: 'board.GND' }, { from: 'f1.GND', to: 'board.GND_2' }];
    const { leds, fuentes } = analizarCircuito(p, b);
    expect(fuentes.find((f) => f.id === 'f1')).toMatchObject({ modo: 'CC', mA: 10 });
    expect(leds.find((l) => l.id === 'led9')).toMatchObject({ mA: 10, estado: 'ok' });
  });
});

describe('interruptores (pulsador, llave) como parte del circuito', () => {
  const real = (t: string): ModuleDef =>
    ModuleDefSchema.parse(JSON.parse(readFileSync(new URL(`../../../modules/${t}/module.json`, import.meta.url), 'utf8')));
  const cat = new Map(['esp32-s3-devkitc-1', 'fuente-regulable', 'led', 'resistor', 'button'].map((t) => [t, real(t)]));
  const b = (t: string) => cat.get(t);
  /** La plantilla projects/_template/circuito-continuo: fuente → pulsador → LED → 150 Ω → GND. */
  const continuo = (): Project =>
    JSON.parse(readFileSync(new URL('../../../projects/_template/circuito-continuo/project.json', import.meta.url), 'utf8'));

  it('pulsador suelto: no pasa corriente por el LED; apretado: ~18 mA desde la fuente, sin código', () => {
    expect(analizarCircuito(continuo(), b).leds[0]).toMatchObject({ mA: 0, mAFijo: 0 });
    const { leds, fuentes, alimentacion } = analizarCircuito(continuo(), b, new Map(), new Set(['btn1']));
    expect(alimentacion.estado).toBe('ok');
    expect(leds[0]!.mAFijo).toBeCloseTo((5 - 2) / (150 + 15 + 0.5) * 1000, 0);
    expect(leds[0]!.estado).toBe('ok');
    expect(fuentes[0]!.mA!).toBeCloseTo(120 + leds[0]!.mA, 0); // la placa + el LED
  });

  it('pulsador apretado entre 3V3 y GND (placa por USB): cortocircuito', () => {
    const p = defaultProject('s', 'esphome', 'esp32-s3-devkitc-1', real('esp32-s3-devkitc-1').board);
    p.modules = [{ id: 'board', type: p.board, x: 0, y: 0, props: { usb: true } }, ...p.modules.filter((m) => m.id !== 'board')];
    p.wires = [...p.wires.filter((w) => !w.from.startsWith('btn1.')), { from: 'btn1.OUT', to: 'board.3V3' }, { from: 'btn1.GND', to: 'board.GND' }];
    expect(analizarCircuito(p, b).avisos.some((a) => /cortocircuito/.test(a.mensaje))).toBe(false);
    const apretado = analizarCircuito(p, b, new Map(), new Set(['btn1'])).avisos;
    expect(apretado.some((a) => a.severidad === 'peligro' && /cortocircuito/.test(a.mensaje))).toBe(true);
  });
});
