import { expect, it } from 'vitest';
import { ParametrosVistaTransitorio, RespuestaVistaTransitorio } from '@emu/shared';
import { trazaFisica } from '../../web/analisis-fisico.js';

it('rechaza paso, duración y presupuesto inválidos antes de solicitar', () => {
  for (const [pasoS, duracionS] of [[0, 1], [2, 1], [NaN, 1], [1, Infinity], [1e-6, 1]]) {
    expect(ParametrosVistaTransitorio.safeParse({ pasoS, duracionS, inicializacion: 'equilibrio' }).success).toBe(false);
  }
  expect(ParametrosVistaTransitorio.safeParse({ pasoS: 1e-5, duracionS: 0.005, inicializacion: 'explicita' }).success).toBe(true);
});
it('no convierte trazas incompletas, tiempos invertidos ni valores no finitos en éxito', () => {
  const r = { revisionProyecto: 'x', fechaUtc: '2026-10-11T00:00:00.000Z', resuelto: true,
    perfil: 'transitorio-diseno-gpio-fijos', t: [0, 1], pines: { a: [0, 5] }, elementos: {}, advertencias: [],
    parametros: { pasoS: 0.01, duracionS: 1, inicializacion: 'equilibrio' }, unidades: { t: 's', v: 'V', i: 'A', p: 'W' } };
  expect(RespuestaVistaTransitorio.safeParse(r).success).toBe(true);
  expect(RespuestaVistaTransitorio.safeParse({ ...r, pines: { a: [0] } }).success).toBe(false);
  expect(RespuestaVistaTransitorio.safeParse({ ...r, t: [1, 0] }).success).toBe(false);
  expect(RespuestaVistaTransitorio.safeParse({ ...r, pines: { a: [0, Infinity] } }).success).toBe(false);
});
it('una serie constante conserva escala visible y un hueco separa la curva', () => {
  const r = trazaFisica([0, 1, 2, 3], [0, null, 0, 0]);
  expect(r.min).toBeLessThan(0); expect(r.max).toBeGreaterThan(0);
  expect(r.path.match(/M/g)).toHaveLength(2); expect(r.path).not.toMatch(/NaN|Infinity/);
  expect(trazaFisica([], []).path).toBe('');
});
it('reduce una serie grande conservando extremos breves y tiempo adaptativo', () => {
  const t = Array.from({ length: 20000 }, (_, i) => i * i / 1e9);
  const valores = t.map(() => 0); valores[105] = 7; valores[108] = -4;
  const r = trazaFisica(t, valores, 100);
  expect(r.max).toBe(7); expect(r.min).toBe(-4);
  expect(r.path).toContain('220.00'); expect(r.path).toContain('30.00');
  expect(r.path.match(/[ML]/g)?.length).toBeLessThan(450);
  expect(r.fin).toBe(t[t.length - 1]);
});

it('acepta muestras adaptativas por encima de la estimación y respeta el límite real del motor', () => {
  const respuesta = (cantidad: number) => ({ revisionProyecto: 'x', fechaUtc: '2026-10-11T00:00:00.000Z',
    resuelto: true, perfil: 'transitorio-diseno-gpio-fijos', t: Array.from({ length: cantidad }, (_, i) => i / cantidad),
    pines: { a: Array.from({ length: cantidad }, () => 5) }, elementos: {}, advertencias: [],
    parametros: { pasoS: 0.0001, duracionS: 1, inicializacion: 'equilibrio' }, unidades: { t: 's', v: 'V', i: 'A', p: 'W' } });
  expect(RespuestaVistaTransitorio.safeParse(respuesta(50000)).success).toBe(true);
  expect(RespuestaVistaTransitorio.safeParse(respuesta(50001)).success).toBe(false);
});
