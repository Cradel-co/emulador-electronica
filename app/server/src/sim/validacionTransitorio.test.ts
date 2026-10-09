import { describe, expect, it } from 'vitest';
import { extraerSeriesSpice } from './validacionSpice.js';

const raw = (t: unknown[] = [0, 1], v: unknown[] = [1, 0]) => ({
  dataType: 'real', data: [{ name: 'time', values: t }, { name: 'V(A)', values: v }],
});
const extraer = (r: unknown, errores: string[] = []) => extraerSeriesSpice(r, errores, 'prueba', 1);

describe('resultado transitorio completo y finito', () => {
  it('conserva las muestras reales, incluso cero, y normaliza nombres', () => {
    const r = extraer(raw());
    expect(r.t).toEqual([0, 1]);
    expect(r.valores.get('v(a)')).toEqual([1, 0]);
  });
  it.each([NaN, Infinity, -Infinity, '0', undefined])('rechaza cualquier muestra inválida %s', valor => {
    expect(() => extraer(raw([0, 1], [valor, 0]))).toThrow();
  });
  it.each([[0, 0, 1], [0.5, 0.25, 1], [-1, 1], [0, 0.9], [0, 1.1]].map(t => ({ t })))('rechaza tiempo no monótono o ejecución incompleta', ({ t }) => {
    expect(() => extraer(raw(t, t.map(() => 0)))).toThrow();
  });
  it('rechaza longitudes distintas, tiempo ausente y vectores duplicados', () => {
    expect(() => extraer(raw([0, 0.5, 1]))).toThrow(/longitud/);
    expect(() => extraer({ dataType: 'real', data: [{ name: 'v(a)', values: [0, 1] }] })).toThrow(/tiempo/);
    const repetido = raw(); repetido.data.push({ name: 'v(a)', values: [0, 1] });
    expect(() => extraer(repetido)).toThrow(/duplicado/);
  });
  it('no acepta un barrido incompleto aunque la duración sea menor que epsilon absoluto', () => {
    expect(() => extraerSeriesSpice(raw([0, 5e-21]), [], 'prueba', 1e-20)).toThrow(/incompleto/);
  });
  it('rechaza arrays dispersos, resultados complejos y errores fatales con muestras parciales', () => {
    expect(() => extraer(raw([0, 1], Array<number>(2)))).toThrow(/finita/);
    expect(() => extraer({ ...raw(), dataType: 'complex' })).toThrow(/real/);
    expect(() => extraer(raw(), ['doAnalyses: TRAN: Timestep too small'])).toThrow();
  });
  it('limita muestras, vectores y presupuesto agregado de valores antes de transferir al servidor', () => {
    const t = Array.from({ length: 50_001 }, (_, k) => k / 50_000);
    expect(() => extraer(raw(t, t))).toThrow(/muestras/);
    expect(() => extraer({ dataType: 'real', data: Array.from({ length: 1025 }, (_, k) => ({ name: `v${k}`, values: [0, 1] })) })).toThrow(/vectores/);
    const valores = Array.from({ length: 1001 }, (_, k) => k / 1000);
    const data = Array.from({ length: 1000 }, (_, k) => ({ name: k ? `v${k}` : 'time', values: valores }));
    expect(() => extraer({ dataType: 'real', data })).toThrow(/presupuesto|valores/i);
  });
});
