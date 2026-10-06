import { describe, expect, it } from 'vitest';
import { extraerValoresSpice, validarDiagnosticosSpice } from './validacionSpice.js';

describe('contrato de resultados ngspice', () => {
  const resultado = (v: unknown) => ({ dataType: 'real', data: [{ name: 'V(N1)', values: [v] }] });
  it('normaliza nombres y conserva el cero real', () => {
    expect(extraerValoresSpice(resultado(0), [], 'circuito').get('v(n1)')).toBe(0);
  });
  it.each([NaN, Infinity, -Infinity, undefined, '0'])('rechaza muestras no finitas o no numéricas: %s', v => {
    expect(() => extraerValoresSpice(resultado(v), [], 'circuito')).toThrow();
  });
  it.each([undefined, { dataType: 'complex', data: [] }, { dataType: 'real', data: [] }])('rechaza resultados sin punto de operación real', raw => {
    expect(() => extraerValoresSpice(raw, [], 'circuito')).toThrow();
  });
  it('no entrega valores parciales si ngspice abortó', () => {
    expect(() => extraerValoresSpice(resultado(0), ['Error: simulation aborted'], 'circuito')).toThrow(/aborted/);
  });
  it.each(['Fatal: no solution', 'DC solution failed', 'doAnalyses: OP: iteration limit reached', 'No convergence in operating point'])('rechaza fallo final: %s', mensaje => {
    expect(() => validarDiagnosticosSpice([mensaje], 'circuito')).toThrow();
  });
  it('permite advertencias de convergencia intermedia recuperada', () => {
    expect(() => validarDiagnosticosSpice(['Warning: True gmin stepping failed', 'Note: Starting source stepping', 'Note: Source stepping completed'], 'circuito')).not.toThrow();
  });
});
