import { expect, it } from 'vitest';
import { ModeloTermicoRcSchema, RespuestaVistaTransitorio } from '@emu/shared';
import { formularioTermicoVacio, modeloDesdeFormulario } from '../../web/termica-fisica.js';
import { seriesFisicas } from '../../web/analisis-fisico.js';
const modelo = { id: 'sintetico', fuente: 'Oráculo de test; sin caracterización', condiciones: 'Un cuerpo y ambiente constante',
  resistenciaKPorW: 40, capacidadJPorK: 0.01, ambienteC: 25, inicialC: 25, rangoDeclaradoC: [0, 100] };
it('los campos vacíos nunca se convierten en valores físicos por defecto', () => {
  expect(() => modeloDesdeFormulario(formularioTermicoVacio())).toThrow(/Completá/);
  const f = { id: 'sintetico', fuente: 'Test', condiciones: 'Ambiente fijo', resistenciaKPorW: '40', capacidadJPorK: '0.01', ambienteC: '25', inicialC: '25', minimoC: '0', maximoC: '100' };
  expect(modeloDesdeFormulario(f).resistenciaKPorW).toBe(40);
  expect(() => modeloDesdeFormulario({ ...f, ambienteC: '' })).toThrow(/Completá/);
});
it.each([
  { resistenciaKPorW: 0 }, { capacidadJPorK: -1 }, { fuente: '' }, { condiciones: ' ' },
  { rangoDeclaradoC: [100, 0] }, { ambienteC: 101 }, { inicialC: -300 },
  { resistenciaKPorW: 1e308, capacidadJPorK: 1e308 },
])('rechaza parámetros sin validez térmica %j', cambios => {
  expect(ModeloTermicoRcSchema.safeParse({ ...modelo, ...cambios }).success).toBe(false);
});
it('conserva el modelo y temperaturas emparejadas; no acepta éxito incompleto o fuera del rango', () => {
  const r = { revisionProyecto: 'r', fechaUtc: '2026-10-11T00:00:00.000Z', resuelto: true,
    perfil: 'transitorio-diseno-gpio-fijos', t: [0, 1], pines: {}, elementos: { 'r.r': { tipo: 'R', v: [5, 5], i: [0.05, 0.05], p: [0.25, 0.25] } },
    parametros: { pasoS: 0.01, duracionS: 1, inicializacion: 'equilibrio' }, advertencias: [],
    unidades: { t: 's', v: 'V', i: 'A', p: 'W', temperaturaC: '°C', energia: 'J' },
    termica: { 'r.r': { perfil: 'termico-rc-unidireccional', caracterizadoEnLaboratorio: false, modelo, inicioS: 0,
      temperaturaC: [25, 34], energiaDisipadaJ: 0.25, energiaAlmacenadaDeltaJ: 0.09, energiaEvacuadaJ: 0.16 } } };
  const valido = RespuestaVistaTransitorio.parse(r);
  expect(seriesFisicas(valido)[0]?.unidad).toBe('°C');
  expect(valido.termica?.['r.r']?.modelo.fuente).toContain('sin caracterización');
  for (const temperaturaC of [[25], [25, 101]]) {
    expect(RespuestaVistaTransitorio.safeParse({ ...r, termica: { 'r.r': { ...r.termica['r.r'], temperaturaC } } }).success).toBe(false);
  }
  expect(RespuestaVistaTransitorio.safeParse({ ...r, termica: { 'c.c': r.termica['r.r'] } }).success).toBe(false);
});
