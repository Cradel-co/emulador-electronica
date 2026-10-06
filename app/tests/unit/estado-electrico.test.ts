import { describe, expect, it } from 'vitest';
import { riesgoDesdeFisica, salidaDesdeFisica } from '../../web/estado-electrico.js';

describe('indicadores derivados de la instantánea física', () => {
  it('la corriente real de un LED alimentado enciende sin depender de la ejecución del firmware', () => {
    expect(salidaDesdeFisica({ valida: true, led: { mA: 10 } })).toBe(true);
  });
  it('una corriente hipotética no enciende un LED sin corriente viva', () => {
    expect(salidaDesdeFisica({ valida: true, led: { mA: 0, mAFijo: 12 } })).toBe(false);
  });
  it('el riesgo de sobrecorriente no retira la carga ni apaga el LED del modelo vivo', () => {
    const lectura = { valida: true, led: { mA: 90, estado: 'se-quema' } };
    expect(riesgoDesdeFisica(lectura)).toBe(true);
    expect(salidaDesdeFisica(lectura)).toBe(true);
    expect(riesgoDesdeFisica({ valida: true, led: { mA: 10, estado: 'ok' } })).toBe(false);
  });
  it('un fallo de la instantánea no presenta como vigente el último encendido ni su riesgo', () => {
    const lectura = { valida: false, led: { mA: 90, estado: 'se-quema' }, modelo: { on: true } };
    expect(salidaDesdeFisica(lectura)).toBe(false);
    expect(riesgoDesdeFisica(lectura)).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity])('una corriente inválida (%s) no se convierte en encendido por el modelo', mA => {
    expect(salidaDesdeFisica({ valida: true, led: { mA }, modelo: { on: true } })).toBe(false);
    expect(riesgoDesdeFisica({ valida: true, led: { mA, estado: 'se-quema' } })).toBe(false);
  });
  it('sin lectura no inventa encendido; otros módulos conservan su observación válida', () => {
    expect(salidaDesdeFisica({ valida: true })).toBe(false);
    expect(salidaDesdeFisica({ valida: true, modelo: { on: true } })).toBe(true);
    expect(salidaDesdeFisica({ valida: true, modelo: { on: false } })).toBe(false);
  });
  it('la corriente del LED es autoritativa si el indicador del modelo discrepa', () => {
    expect(salidaDesdeFisica({ valida: true, led: { mA: 10 }, modelo: { on: false } })).toBe(true);
    expect(salidaDesdeFisica({ valida: true, led: { mA: 0 }, modelo: { on: true } })).toBe(false);
  });
  it('el riesgo actual distingue límite excedido de ausencia de dato', () => {
    expect(riesgoDesdeFisica({ valida: true, led: { mA: 25, estado: 'sobreexigido' } })).toBe(true);
    expect(riesgoDesdeFisica({ valida: true })).toBe(false);
    expect(riesgoDesdeFisica({ valida: true, led: { mA: 10 } })).toBe(false);
  });
});
