import { beforeAll, describe, expect, it } from 'vitest';
import { ModuleDefSchema, type Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito } from './analisis.js';
let catalogo: ModuloCatalogo[];
const capacitor = {
  ...ModuleDefSchema.parse({ type: 'prueba-capacitor-dc', name: 'Capacitor', category: 'Pruebas', svg: 'c.svg', pins: [{ name: 'A', x: 0, y: 0, kind: 'other' }, { name: 'B', x: 0, y: 1, kind: 'other' }] }),
  modeloCodigo: `module.exports = { circuito(ctx) { ctx.capacitor(ctx.pin('A'), ctx.pin('B'), 1e-6, {}, 'c'); } };`,
};
const buscar = (tipo: string) => tipo === capacitor.type ? capacitor : catalogo.find(m => m.type === tipo);
beforeAll(async () => { catalogo = await loadCatalog(); });
const proyecto = (board = 'esp32-s3-devkitc-1'): Project => ({
  schemaVersion: 1, name: 'fidelidad', board, language: 'micropython',
  modules: [{ id: 'board', type: board, x: 0, y: 0, props: { usb: true } }], wires: [],
  sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false },
});
const resistor = (id: string) => ({ id, type: 'resistor', x: 0, y: 0, props: { ohms: 1000 } });
describe('regresiones independientes de fidelidad DC', () => {
  it.each([{ a: 'A4', b: 'SDA', gpio: 18 }, { a: 'A5', b: 'SCL', gpio: 19 }])('alias $a/$b son un mismo pad, cualquiera sea el orden', async ({ a, b, gpio }) => {
    const resultados: number[] = [];
    for (const invertir of [false, true]) {
      const p = proyecto('arduino-uno');
      p.modules.push(resistor('r1'), resistor('r2'));
      const cables = [{ from: `board.${a}`, to: 'r1.1' }, { from: `board.${b}`, to: 'r2.1' }];
      if (invertir) cables.reverse();
      p.wires = [...cables, { from: 'r1.2', to: 'board.GND' }, { from: 'r2.2', to: 'board.GND' }];
      const r = await analizarCircuito(p, buscar, { direcciones: new Map([[gpio, { salida: true }]]), niveles: new Map([[gpio, 1]]) });
      expect(r.tensiones[`board.${a}`]).toBeCloseTo(r.tensiones[`board.${b}`] ?? NaN, 9);
      expect(r.tensiones['r1.1']).toBeCloseTo(5 * 500 / 525, 1);
      resultados.push(r.tensiones['r1.1'] ?? NaN);
    }
    expect(resultados[0]).toBeCloseTo(resultados[1] ?? NaN, 9);
  });
  it.each(['capacitor', 'resistencia-colgante'])('%s no determina una entrada en continua', async tipo => {
    const p = proyecto();
    if (tipo === 'capacitor') {
      p.modules.push({ id: 'c', type: capacitor.type, x: 0, y: 0, props: {} });
      p.wires = [{ from: 'board.GPIO6', to: 'c.A' }, { from: 'c.B', to: 'board.GND' }];
    } else {
      p.modules.push(resistor('r'));
      p.wires = [{ from: 'board.GPIO6', to: 'r.1' }];
    }
    const r = await analizarCircuito(p, buscar, { direcciones: new Map([[6, { salida: false }]]) });
    expect(r.entradas).toContainEqual(expect.objectContaining({ gpio: 6, flotante: true, nivel: null }));
    expect(r.avisos.some(a => a.pin === 6 && /flotando/.test(a.mensaje))).toBe(true);
  });
  it('una cadena resistiva hasta GND sí fija una entrada, aunque tenga corriente cero', async () => {
    const p = proyecto();
    p.modules.push(resistor('r1'), resistor('r2'));
    p.wires = [{ from: 'board.GPIO6', to: 'r1.1' }, { from: 'r1.2', to: 'r2.1' }, { from: 'r2.2', to: 'board.GND' }];
    const r = await analizarCircuito(p, buscar, { direcciones: new Map([[6, { salida: false }]]) });
    expect(r.entradas).toContainEqual(expect.objectContaining({ gpio: 6, flotante: false, nivel: 0 }));
  });
  it('retirar drivers por brownout no convierte la alimentación en OK ni oculta la causa', async () => {
    const p = proyecto();
    p.modules[0]!.props.usb = false;
    p.modules.push({ id: 'f', type: 'fuente-regulable', x: 0, y: 0, props: { voltage: 3.3, currentLimitMa: 130 } });
    p.wires = [{ from: 'f.V', to: 'board.3V3' }, { from: 'f.GND', to: 'board.GND' }, { from: 'board.GPIO7', to: 'board.GND' }];
    const r = await analizarCircuito(p, buscar, { direcciones: new Map([[7, { salida: true }]]), niveles: new Map([[7, 1]]) });
    expect(r.chipEncendido).toBe(false);
    expect(r.alimentacion.estado).toBe('baja');
    expect(r.avisos.some(a => /brownout|baja tensión/i.test(a.mensaje))).toBe(true);
    expect(r.avisos.some(a => a.pin === 7 && /cortocircuito|corriente/i.test(a.mensaje))).toBe(true);
  });
  it('un módulo desconocido invalida el análisis en lugar de borrar su carga', async () => {
    const p = proyecto();
    p.modules.push({ id: 'carga', type: 'no-existe-en-catalogo', x: 0, y: 0, props: {} });
    const r = await analizarCircuito(p, buscar);
    expect(r.chipEncendido).toBe(false);
    expect(r.avisos.some(a => /no-existe-en-catalogo/.test(a.mensaje) && a.severidad === 'peligro')).toBe(true);
    expect(r.elementos).toHaveLength(0);
  });
});
