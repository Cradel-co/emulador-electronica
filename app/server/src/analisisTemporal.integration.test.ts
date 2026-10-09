import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { ProjectSchema } from '@emu/shared';
import { loadCatalog } from './catalog.js';
import { registrarRutasAnalisisFisico } from './rutasAnalisisFisico.js';

it('catálogo real y API producen carga RC; térmica usa la pérdida de R y no energía de C', async () => {
  const catalogo = await loadCatalog();
  expect(catalogo.some(m => m.type === 'capacitor')).toBe(true);
  expect(catalogo.some(m => m.type === 'inductor')).toBe(true);
  const proyecto = ProjectSchema.parse({ name: 'temporal', board: null, language: null,
    modules: [
      { id: 'fuente', type: 'fuente-regulable', x: 0, y: 0, props: { voltage: 5, currentLimitMa: 1000 } },
      { id: 'r', type: 'resistor', x: 100, y: 0, props: { ohms: 1000 } },
      { id: 'c', type: 'capacitor', x: 200, y: 0, props: { faradios: 1e-6, inicialV: 0 } },
    ], wires: [{ from: 'fuente.V', to: 'r.1' }, { from: 'r.2', to: 'c.1' }, { from: 'c.2', to: 'fuente.GND' }],
    sim: { wifiSsid: 'x', wifiPassword: 'y' },
  });
  const app = Fastify();
  registrarRutasAnalisisFisico(app, { cargar: async () => ({ proyecto, buscar: tipo => catalogo.find(m => m.type === tipo), opciones: { fuentesApagadas: false } }) });
  try {
    const respuesta = await app.inject({ method: 'POST', url: '/api/projects/temporal/analysis/transient', payload: {
      parametros: { pasoS: 1e-5, duracionS: 0.005, inicializacion: 'explicita' },
      termica: { 'r.r': { id: 'fixture-sintetico', fuente: 'Oráculo analítico de test', condiciones: 'R y C térmicas constantes inventadas', resistenciaKPorW: 10, capacidadJPorK: 0.01, ambienteC: 25, inicialC: 25, rangoDeclaradoC: [0, 100] } },
    } });
    expect(respuesta.statusCode, respuesta.statusCode === 200 ? '' : respuesta.body).toBe(200);
    const r = respuesta.json();
    const ultimo = r.t.length - 1;
    expect(r.pines['c.1'][ultimo] - r.pines['c.2'][ultimo]).toBeCloseTo(5 * (1 - Math.exp(-5)), 2);
    expect(r.termica['r.r'].temperaturaC[ultimo]).toBeGreaterThan(25);
    expect(r.termica['r.r'].caracterizadoEnLaboratorio).toBe(false);
    expect(r.elementos['c.c'].p[0]).toBeGreaterThan(0);
    expect(r.advertencias.join(' ')).toMatch(/no ejecuta firmware/);
  } finally { await app.close(); }
});
