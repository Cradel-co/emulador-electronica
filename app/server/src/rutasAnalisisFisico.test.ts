import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ProjectSchema } from '@emu/shared';
import { registrarRutasAnalisisFisico, type DependenciasAnalisisFisico } from './rutasAnalisisFisico.js';

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
