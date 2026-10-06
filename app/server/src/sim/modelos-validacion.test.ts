import { beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito } from './analisis.js';
import { modeloPorFlags } from './modelos.js';
import { precalentar } from './spice.js';

let catalogo: ModuloCatalogo[] = [];
beforeAll(async () => { catalogo = await loadCatalog(); await precalentar(); }, 60_000);
// Incluye datos corruptos de importación intencionalmente, aunque no satisfagan el esquema UI.
function proyecto(propsR: Record<string, unknown> = { ohms: 1000 }, propsF: Record<string, unknown> = { voltage: 5, currentLimitMa: 1000 }): Project {
  return { schemaVersion: 1, name: 'flags-invalidos', board: null, language: null,
    sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false },
    modules: [{ id: 'f', type: 'fuente-regulable', props: propsF as Project['modules'][number]['props'], x: 0, y: 0 }, { id: 'r', type: 'resistor', props: propsR as Project['modules'][number]['props'], x: 0, y: 0 }],
    wires: [{ from: 'f.V', to: 'r.1' }, { from: 'r.2', to: 'f.GND' }] };
}
function buscar(tipo: string): ModuloCatalogo | undefined {
  const d = catalogo.find(d => d.type === tipo);
  return d ? { ...d, modeloCodigo: undefined } : undefined;
}
describe('flags legacy no fabrican medidas válidas con propiedades inválidas', () => {
  it.each([0, -1, NaN, Infinity, 'abc', null, false, ''])('resistencia inválida %s invalida análisis', async ohms => {
    const r = await analizarCircuito(proyecto({ ohms }), buscar);
    expect(r.resuelto).toBe(false);
    expect(r.fuentes).toEqual([]);
    expect(r.avisos.some(a => /modelo eléctrico falló/.test(a.mensaje))).toBe(true);
  });
  it.each([NaN, Infinity, 'abc', null, false, ''])('tensión inválida %s no se transforma en 0 V', async voltage => {
    const r = await analizarCircuito(proyecto(undefined, { voltage, currentLimitMa: 1000 }), buscar);
    expect(r.resuelto).toBe(false);
    expect(r.fuentes).toEqual([]);
  });
  it.each([0, -1, NaN, Infinity, 'abc', null, false, '', undefined])('límite inválido %s no produce fuente ilimitada', async currentLimitMa => {
    const r = await analizarCircuito(proyecto(undefined, { voltage: 5, currentLimitMa }), buscar);
    expect(r.resuelto).toBe(false);
    expect(r.fuentes).toEqual([]);
  });
  it('conserva los valores nominales y fuente ideal sólo cuando el descriptor no declara límite', async () => {
    const r = await analizarCircuito(proyecto(), buscar);
    expect(r.resuelto).toBe(true);
    expect(r.fuentes[0]?.mA).toBeCloseTo(5, 2);
    const def = buscar('fuente-regulable');
    if (!def?.source) throw new Error('Falta fuente');
    const ideal = modeloPorFlags({ ...def, source: { ...def.source, currentProp: undefined }, electrical: undefined });
    expect(ideal.circuito({ pines: ['V', 'GND'], props: { voltage: 5 }, vars: {}, estado: {}, control: true })[0]).toMatchObject({ voltios: 5, limiteA: undefined });
  });
});
