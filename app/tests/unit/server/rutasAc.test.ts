import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { ProjectSchema, RespuestaAcSchema } from '@emu/shared';
import { loadCatalog } from '../../../server/src/catalog.js';
import { registrarRutasAnalisisFisico } from '../../../server/src/rutasAnalisisFisico.js';
import { revisionProyecto } from '../../../server/src/revisionGuardado.js';
import { analizarAcCircuito, opcionesAcCircuito } from '../../../server/src/sim/analisis.js';
const parametros = { fuente: 'f.salida', entrada: 'f.V', salida: 'c.1', inicioHz: 10, finHz: 10000, puntosPorDecada: 10 };
async function contexto() {
  const catalogo = await loadCatalog();
  const proyecto = ProjectSchema.parse({ name: 'rc-ac', board: null, language: null, sim: { wifiSsid: 'test', wifiPassword: '' }, modules: [
    { id: 'f', type: 'fuente-regulable', x: 0, y: 0, props: { voltage: 5, currentLimitMa: 1000 } },
    { id: 'r', type: 'resistor', x: 0, y: 0, props: { ohms: 1000 } },
    { id: 'c', type: 'capacitor', x: 0, y: 0, props: { faradios: 1e-6 } },
    { id: 'flotante', type: 'resistor', x: 0, y: 0, props: { ohms: 1000 } },
  ], wires: [{ from: 'f.V', to: 'r.1' }, { from: 'r.2', to: 'c.1' }, { from: 'c.2', to: 'f.GND' }] });
  return { proyecto, buscar: (tipo: string) => catalogo.find(m => m.type === tipo), opciones: {} };
}
it('API real: opciones válidas, fasores y medidas analíticas sin modificar el proyecto', async () => {
  const c = await contexto(), antes = structuredClone(c.proyecto), app = Fastify();
  registrarRutasAnalisisFisico(app, { cargar: async () => c });
  try {
    const o = await app.inject({ method: 'POST', url: '/api/projects/p/analysis/ac-options', payload: {} });
    expect(o.statusCode).toBe(200); expect(o.json().fuentes).toEqual([parametros.fuente]);
    expect(o.json().pines).toContain('c.1'); expect(o.json().pines).not.toContain('flotante.1');
    const r = await app.inject({ method: 'POST', url: '/api/projects/p/analysis/ac', payload: { parametros } });
    expect(r.statusCode, r.body).toBe(200); expect(r.headers['cache-control']).toBe('no-store');
    const datos = RespuestaAcSchema.parse(r.json());
    for (const [k, f] of datos.frecuenciaHz.entries()) expect(datos.gananciaDb[k]).toBeCloseTo(-10 * Math.log10(1 + (2 * Math.PI * f * 0.001) ** 2), 6);
    expect(c.proyecto).toEqual(antes);
    expect(RespuestaAcSchema.safeParse({ ...datos, frecuenciaHz: [10, 20] }).success).toBe(false);
  } finally { await app.close(); }
});
it('fuentes apagadas y pines flotantes no se ofrecen ni producen resultados', async () => {
  const c = await contexto();
  expect(opcionesAcCircuito(c.proyecto, c.buscar, { fuentesApagadas: true }).fuentes).toEqual([]);
  await expect(analizarAcCircuito(c.proyecto, c.buscar, {}, { ...parametros, salida: 'flotante.1' })).rejects.toThrow(/referencia/);
  await expect(analizarAcCircuito(c.proyecto, c.buscar, {}, { ...parametros, fuente: 'ajena' })).rejects.toThrow(/Fuente/);
});
it('solicitudes inválidas no cargan el proyecto ni aceptan netlists del cliente', async () => {
  const app = Fastify(), cargar = vi.fn(async () => contexto());
  registrarRutasAnalisisFisico(app, { cargar });
  try {
    for (const payload of [{ parametros: { ...parametros, inicioHz: 0 } }, { parametros, netlist: '.ac' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/projects/p/analysis/ac', payload })).statusCode).toBe(400);
    }
    expect(cargar).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
it('If-Match y cambio durante cálculo rechazan la respuesta y retiran medidas', async () => {
  const c = await contexto(), revision = revisionProyecto(c.proyecto), ajena = `"${'a'.repeat(64)}"`, app = Fastify();
  let actual = revision;
  const resolverAc = vi.fn(async (...args: Parameters<typeof analizarAcCircuito>) => { const r = await analizarAcCircuito(...args); actual = ajena; return r; });
  registrarRutasAnalisisFisico(app, { cargar: async () => ({ ...c, revision }), revisionActual: async () => actual, resolverAc });
  try {
    const url = '/api/projects/p/analysis/ac';
    expect((await app.inject({ method: 'POST', url, headers: { 'if-match': ajena }, payload: { parametros } })).statusCode).toBe(412);
    expect(resolverAc).not.toHaveBeenCalled();
    const r = await app.inject({ method: 'POST', url, headers: { 'if-match': revision }, payload: { parametros } });
    expect(r.statusCode).toBe(412); expect(r.json().frecuenciaHz).toBeUndefined();
  } finally { await app.close(); }
});
