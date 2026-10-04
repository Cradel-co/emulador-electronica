import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ProjectSchema } from '@emu/shared';
import { registrarRutasAnalisisFisico, type DependenciasAnalisisFisico } from './rutasAnalisisFisico.js';
import { loadCatalog } from './catalog.js';

const parametros = { pasoS: 0.01, duracionS: 1, inicializacion: 'equilibrio' };
const proyecto = ProjectSchema.parse({ name: 'analisis', board: null, language: null, modules: [], wires: [], sim: { wifiSsid: 'x', wifiPassword: 'y' } });
const resultado = {
  perfil: 'transitorio-diseno-gpio-fijos' as const, t: [0, 1], pines: { 'r.A': [1, 1] },
  elementos: { 'r.R': { tipo: 'R' as const, v: [1, 1], i: [1, 1], p: [1, 1] } },
  advertencias: ['GPIO fijos; sin reloj compartido con firmware.'],
};
const termico = {
  id: 'sintetico', fuente: 'Fixture analítico sintético', condiciones: 'Ambiente constante',
  resistenciaKPorW: 10, capacidadJPorK: 2, ambienteC: 25, inicialC: 25, rangoDeclaradoC: [0, 100],
};

async function probar(payload: unknown, resolver = vi.fn<NonNullable<DependenciasAnalisisFisico['resolver']>>().mockResolvedValue(resultado)) {
  const app = Fastify();
  const cargar = vi.fn(async () => ({ proyecto, buscar: () => undefined, opciones: {} }));
  registrarRutasAnalisisFisico(app, { cargar, resolver });
  try {
    const respuesta = await app.inject({ method: 'POST', url: '/api/projects/analisis/analysis/transient', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    return { respuesta, cargar, resolver };
  } finally { await app.close(); }
}

describe('API de análisis temporal', () => {
  it('publica perfil y trazas; procesa calor sólo con parámetros explícitos', async () => {
    const { respuesta } = await probar({ parametros, termica: { 'r.R': termico } });
    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.headers['cache-control']).toBe('no-store');
    const r = respuesta.json();
    expect(r.perfil).toBe('transitorio-diseno-gpio-fijos');
    expect(r.termica['r.R'].temperaturaC[1]).toBeCloseTo(25 + 10 * (1 - Math.exp(-0.05)), 10);
    expect(r.termica['r.R'].caracterizadoEnLaboratorio).toBe(false);
    expect(r.advertencias).toEqual(resultado.advertencias);
  });

  it.each([
    { parametros: { ...parametros, pasoS: '0.01' } },
    { parametros: { ...parametros, duracionS: -1 } },
    { parametros, netlist: '.control\nquit\n.endc' },
    { parametros, termica: { 'r.R': { ...termico, capacidadJPorK: 0 } } },
  ])('rechaza solicitudes ambiguas o inválidas antes de resolver', async payload => {
    const { respuesta, resolver, cargar } = await probar(payload);
    expect(respuesta.statusCode).toBe(400);
    expect(resolver).not.toHaveBeenCalled();
    expect(cargar).not.toHaveBeenCalled();
  });

  it('propaga errores numéricos sin publicar medidas de éxito', async () => {
    const resolver = vi.fn<NonNullable<DependenciasAnalisisFisico['resolver']>>().mockRejectedValue(new Error('No convergente'));
    const { respuesta } = await probar({ parametros }, resolver);
    expect(respuesta.statusCode).toBe(422);
    expect(respuesta.json()).toEqual({ resuelto: false, error: 'No convergente' });
  });

  it('no interpreta una fuente ni energía almacenada como calor resistivo', async () => {
    const { respuesta } = await probar({ parametros, termica: { 'capacitor.C': termico } });
    expect(respuesta.statusCode).toBe(422);
    expect(respuesta.json().resuelto).toBe(false);
  });
});

const electrotermico = {
  parametros: { duracionS: 0.1, pasoInicialS: 0.1, pasoMaximoS: 0.1, pasoMinimoS: 1e-4, toleranciaC: 0.01 },
  modelos: { 'r.r': {
    resistenciaReferenciaOhm: 100, temperaturaReferenciaC: 25, coeficientePorK: 0.02,
    dominioElectrico: { tensionMaxAbsV: 20, corrienteMaxAbsA: 1, potenciaMaxW: 5 },
    termica: { ...termico, capacidadJPorK: 0.1 },
  } },
};

it('API electro térmica rechaza contratos incompletos o excesivos antes de cargar el proyecto', async () => {
  const app = Fastify(), cargar = vi.fn(async () => ({ proyecto, buscar: () => undefined, opciones: {} }));
  registrarRutasAnalisisFisico(app, { cargar });
  try {
    for (const payload of [
      { ...electrotermico, modelos: {} },
      { ...electrotermico, parametros: { ...electrotermico.parametros, toleranciaC: 0 } },
      { ...electrotermico, netlist: '.op' },
      { ...electrotermico, modelos: { 'r.r': { ...electrotermico.modelos['r.r'], coeficientePorK: -1 } } },
    ]) {
      const r = await app.inject({ method: 'POST', url: '/api/projects/p/analysis/electrothermal', payload });
      expect(r.statusCode).toBe(400);
    }
    expect(cargar).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it('API real usa el proyecto, devuelve realimentación R(T) y no modifica sus propiedades', async () => {
  const catalogo = await loadCatalog();
  const p = ProjectSchema.parse({ name: 'calentamiento', board: null, language: null,
    modules: [
      { id: 'f', type: 'fuente-regulable', x: 0, y: 0, props: { voltage: 10, currentLimitMa: 1000 } },
      { id: 'r', type: 'resistor', x: 0, y: 0, props: { ohms: 100 } },
    ], wires: [{ from: 'f.V', to: 'r.1' }, { from: 'r.2', to: 'f.GND' }], sim: { wifiSsid: 'test', wifiPassword: '' },
  });
  const antes = structuredClone(p), app = Fastify();
  registrarRutasAnalisisFisico(app, { cargar: async () => ({ proyecto: p, buscar: tipo => catalogo.find(m => m.type === tipo), opciones: {} }) });
  try {
    const r = await app.inject({ method: 'POST', url: '/api/projects/cal/analysis/electrothermal', payload: electrotermico });
    expect(r.statusCode, r.statusCode === 200 ? '' : r.body).toBe(200);
    const body = r.json();
    expect(body.perfil).toBe('electrotermico-rc-cuasiestatico');
    expect(body.caracterizadoEnLaboratorio).toBe(false);
    const s = body.elementos['r.r'];
    expect(s.resistenciaOhm.at(-1)).toBeGreaterThan(101.8);
    expect(s.i.at(-1)).toBeLessThan(s.i[0]);
    expect(body.estadisticas.evaluacionesElectricas).toBeLessThanOrEqual(12);
    expect(p).toEqual(antes);
  } finally { await app.close(); }
}, 30_000);

it('API electro térmica devuelve 422 sin trazas parciales si falla el acoplamiento', async () => {
  const app = Fastify();
  registrarRutasAnalisisFisico(app, {
    cargar: async () => ({ proyecto, buscar: () => undefined, opciones: {} }),
    resolverElectrotermico: async () => { throw new Error('Sin convergencia térmica'); },
  });
  try {
    const r = await app.inject({ method: 'POST', url: '/api/projects/p/analysis/electrothermal', payload: electrotermico });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ resuelto: false, error: 'Sin convergencia térmica' });
  } finally { await app.close(); }
});
