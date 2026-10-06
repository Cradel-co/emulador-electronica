import { beforeAll, expect, it } from 'vitest';
import type { Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito, analizarTransitorioCircuito } from './analisis.js';
import { precalentar } from './spice.js';

let catalogo: ModuloCatalogo[] = [];
beforeAll(async () => { catalogo = await loadCatalog(); await precalentar(); }, 60_000);
const buscar = (tipo: string) => catalogo.find(m => m.type === tipo);
const proyecto = (): Project => ({
  schemaVersion: 1, name: 'transitorio del proyecto', board: null, language: null,
  sim: { wifiSsid: '', wifiPassword: '', autoReload: false },
  modules: [
    { id: 'f', type: 'fuente-regulable', x: 0, y: 0, props: { voltage: 5, currentLimitMa: 1000 } },
    { id: 'r', type: 'resistor', x: 0, y: 0, props: { ohms: 1000 } },
  ],
  wires: [{ from: 'f.V', to: 'r.1' }, { from: 'r.2', to: 'f.GND' }],
});

it('el wrapper usa los modelos y conexiones del proyecto y entrega el equilibrio DC', async () => {
  const p = proyecto();
  const dc = await analizarCircuito(p, buscar);
  const r = await analizarTransitorioCircuito(p, buscar, {}, { pasoS: 0.001, duracionS: 0.005, inicializacion: 'equilibrio' });
  expect(dc.resuelto).toBe(true);
  expect(r.perfil).toBe('transitorio-diseno-gpio-fijos');
  expect(r.advertencias.join(' ')).toMatch(/no ejecuta firmware/);
  expect(Object.keys(r.pines).sort()).toEqual(['f.GND', 'f.V', 'r.1', 'r.2']);
  for (const [pin, valores] of Object.entries(r.pines)) {
    expect(valores).toHaveLength(r.t.length);
    // DC conserva su tolerancia original; el transitorio solicita reltol=1e-5.
    expect(valores.at(-1)).toBeCloseTo(dc.tensiones[pin] ?? NaN, 3);
  }
  for (const el of dc.elementos) {
    const serie = r.elementos[el.id];
    expect(serie?.i.at(-1)).toBeCloseTo(el.i, 6);
    expect(serie?.p.at(-1)).toBeCloseTo(el.p, 5);
  }
});

it('la descarga aislada conserva medidas relativas y omite voltajes absolutos sin tierra física', async () => {
  const p = proyecto();
  p.modules = [
    { id: 'r', type: 'resistor', x: 0, y: 0, props: { ohms: 1000 } },
    { id: 'c', type: 'capacitor', x: 0, y: 0, props: { faradios: 1e-6, inicialV: 1 } },
  ];
  p.wires = [{ from: 'r.1', to: 'c.1' }, { from: 'r.2', to: 'c.2' }];
  const r = await analizarTransitorioCircuito(p, buscar, {}, { pasoS: 1e-5, duracionS: 0.005, inicializacion: 'explicita' });
  expect(r.pines).toEqual({});
  expect(r.advertencias.join(' ')).toMatch(/Sin referencia física de tierra/);
  for (const [k, t] of r.t.entries()) expect(r.elementos['c.c']?.v[k]).toBeCloseTo(Math.exp(-t / 0.001), 3);
});

it('una fuente en otra isla no vuelve absolutos los voltajes de una RC aislada', async () => {
  const p = proyecto();
  p.modules.push(
    { id: 'aislada', type: 'resistor', x: 0, y: 0, props: { ohms: 1000 } },
    { id: 'c', type: 'capacitor', x: 0, y: 0, props: { faradios: 1e-6, inicialV: 1 } },
  );
  p.wires.push({ from: 'aislada.1', to: 'c.1' }, { from: 'aislada.2', to: 'c.2' });
  const r = await analizarTransitorioCircuito(p, buscar, {}, { pasoS: 1e-5, duracionS: 0.005, inicializacion: 'explicita' });
  expect(Object.keys(r.pines).sort()).toEqual(['f.GND', 'f.V', 'r.1', 'r.2']);
  expect(r.advertencias.join(' ')).toMatch(/Sin referencia física de tierra.*aislada\.1/);
  for (const [k, t] of r.t.entries()) expect(r.elementos['c.c']?.v[k]).toBeCloseTo(Math.exp(-t / 0.001), 3);
});
