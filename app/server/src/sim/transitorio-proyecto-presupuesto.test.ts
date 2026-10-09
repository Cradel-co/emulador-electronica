import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarTransitorioCircuito } from './analisis.js';
import { correrTransitorio } from './transitorio.js';

vi.mock('./transitorio.js', async importOriginal => ({
  ...await importOriginal<typeof import('./transitorio.js')>(), correrTransitorio: vi.fn(),
}));

let catalogo: ModuloCatalogo[] = [];
beforeAll(async () => { catalogo = await loadCatalog(); });
beforeEach(() => vi.mocked(correrTransitorio).mockReset());
const buscar = (tipo: string) => catalogo.find(m => m.type === tipo);
const proyecto = (): Project => ({
  schemaVersion: 1, name: 'pines en paralelo', board: null, language: null,
  sim: { wifiSsid: '', wifiPassword: '', autoReload: false },
  modules: [
    { id: 'f', type: 'fuente-regulable', x: 0, y: 0, props: { voltage: 5, currentLimitMa: 1000 } },
    ...Array.from({ length: 100 }, (_, k) => ({ id: `r${k}`, type: 'resistor', x: 0, y: 0, props: { ohms: 1000 } })),
  ],
  wires: Array.from({ length: 100 }, (_, k) => [{ from: 'f.V', to: `r${k}.1` }, { from: `r${k}.2`, to: 'f.GND' }]).flat(),
});

it('rechaza antes de ejecutar la expansión por pines que sí cabía como nodos y elementos', async () => {
  await expect(analizarTransitorioCircuito(proyecto(), buscar, {}, { pasoS: 0.0005, duracionS: 1, inicializacion: 'equilibrio' })).rejects.toThrow(/presupuesto|valores/i);
  expect(correrTransitorio).not.toHaveBeenCalled();
});

it('vuelve a limitar la salida por pines con la cantidad real de pasos adaptativos', async () => {
  vi.mocked(correrTransitorio).mockResolvedValue({ t: Array.from({ length: 2000 }, (_, k) => k / 1999), tensiones: new Map(), elementos: {}, advertencias: [] });
  await expect(analizarTransitorioCircuito(proyecto(), buscar, {}, { pasoS: 0.5, duracionS: 1, inicializacion: 'equilibrio' })).rejects.toThrow(/presupuesto|valores/i);
  expect(correrTransitorio).toHaveBeenCalledOnce();
});
