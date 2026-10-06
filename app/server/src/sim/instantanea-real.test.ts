import { beforeAll, expect, it } from 'vitest';
import type { Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito } from './analisis.js';
import { precalentar } from './spice.js';
let cat: ModuloCatalogo[];
beforeAll(async () => { cat = await loadCatalog(); await precalentar(); }, 60_000);
const buscar = (tipo: string) => cat.find(m => m.type === tipo);
const base = (): Project => ({ schemaVersion: 1, name: 'instantanea', board: 'esp32-s3-devkitc-1', language: 'micropython',
  sim: { wifiSsid: '', wifiPassword: '', autoReload: false },
  modules: [{ id: 'board', type: 'esp32-s3-devkitc-1', x: 0, y: 0, props: { usb: true } },
    { id: 'r', type: 'resistor', x: 0, y: 0, props: { ohms: 1000 } },
    { id: 'led', type: 'led', x: 0, y: 0, props: { color: 'red' } }],
  wires: [{ from: 'board.GPIO7', to: 'r.1' }, { from: 'r.2', to: 'led.IN' }, { from: 'led.GND', to: 'board.GND' }],
});
it('antes del primer nivel runtime un OUTPUT no se inventa en alto', async () => {
  const r = await analizarCircuito(base(), buscar, { nivelesReales: true, direcciones: new Map([[7, { salida: true }]]) });
  expect(r.leds[0]?.mA).toBeLessThan(0.001);
  expect(r.elementos.some(e => e.local === 'gpio7')).toBe(false);
});
it('un LED entre dos GPIO depende de la diferencia de niveles, no de todos-altos', async () => {
  const p = base(); p.wires[2] = { from: 'led.GND', to: 'board.GPIO6' };
  for (const retorno of [0, 1] as const) {
    const r = await analizarCircuito(p, buscar, { nivelesReales: true,
      niveles: new Map([[7, 1], [6, retorno]]), direcciones: new Map([[7, { salida: true }], [6, { salida: true }]]) });
    expect(r.leds[0]?.mA ?? NaN)[retorno === 0 ? 'toBeGreaterThan' : 'toBeLessThan'](0.5);
  }
});
it('open-drain alto libera el pad y bajo absorbe corriente del pull-up externo', async () => {
  const p = base(); p.modules = p.modules.filter(m => m.id !== 'led');
  p.wires = [{ from: 'board.3V3', to: 'r.1' }, { from: 'r.2', to: 'board.GPIO7' }];
  for (const nivel of [0, 1] as const) {
    const r = await analizarCircuito(p, buscar, { nivelesReales: true, niveles: new Map([[7, nivel]]), direcciones: new Map([[7, { salida: true, openDrain: true }]]) });
    if (nivel === 1) {
      expect(r.tensiones['board.GPIO7']).toBeCloseTo(3.3, 1);
      expect(r.elementos.some(e => e.local === 'gpio7')).toBe(false);
    } else expect(r.tensiones['board.GPIO7']).toBeLessThan(0.15);
  }
});
it('un corto en 3V3 del Uno se diagnostica con su límite propio, no el de ESP32', async () => {
  const p = base(); p.board = 'arduino-uno'; p.modules = [{ ...p.modules[0]!, type: 'arduino-uno' }];
  p.wires = [{ from: 'board.3V3', to: 'board.GND' }];
  const r = await analizarCircuito(p, buscar, { nivelesReales: true });
  expect(r.chipEncendido).toBe(true);
  expect(r.avisos.some(a => /3V3.*cortocircuito/.test(a.mensaje))).toBe(true);
});
