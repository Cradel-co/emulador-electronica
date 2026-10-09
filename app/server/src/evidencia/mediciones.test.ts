import { describe, expect, it } from 'vitest';
import { evaluarMedicion } from './mediciones.js';
import { fixtureSintetico } from './fixtureSintetico.js';

describe('evidencia de mediciones declaradas', () => {
  it('acepta dentro del margen sin acreditar laboratorio', () => {
    const r = evaluarMedicion(fixtureSintetico());
    expect(r.estado).toBe('aceptado');
    expect(r.clasificacion).toBe('sintetico');
    expect(r.certificacion).toBe(false);
    expect(r.incertidumbreDiferencia).toBeCloseTo(Math.sqrt(0.0002));
  });
  it('rechaza discrepancia fuera de todo el intervalo', () => {
    const f = fixtureSintetico(); f.prediccion.valor = 3;
    expect(evaluarMedicion(f).estado).toBe('rechazado');
  });
  it('conserva zona indeterminada aunque la diferencia nominal cumpla', () => {
    const f = fixtureSintetico(); f.prediccion.valor = 2.59;
    expect(evaluarMedicion(f).estado).toBe('indeterminado');
  });
  it('usa correlación explícita y no inventa independencia', () => {
    const f = fixtureSintetico(); f.correlacion.rho = 1;
    expect(evaluarMedicion(f).incertidumbreDiferencia).toBe(0);
    expect(evaluarMedicion({ ...f, correlacion: undefined }).estado).toBe('no-evaluable');
  });
  it.each([NaN, Infinity, -Infinity])('rechaza datos no finitos %s', valor => {
    const f = fixtureSintetico(); f.medicion.valor = valor;
    expect(evaluarMedicion(f).estado).toBe('no-evaluable');
  });
  it.each([-1.01, 1.01])('rechaza correlación fuera de rango %s', rho => {
    const f = fixtureSintetico(); f.correlacion.rho = rho;
    expect(evaluarMedicion(f).estado).toBe('no-evaluable');
  });
  it('no admite incertidumbre cero sin justificación específica', () => {
    const f = fixtureSintetico(); f.medicion.incertidumbreEstandar = 0;
    expect(evaluarMedicion(f).estado).toBe('no-evaluable');
    expect(evaluarMedicion({ ...f, medicion: { ...f.medicion, justificacionCero: 'Exactitud aritmética sintética.' } }).estado).toBe('aceptado');
  });
  it('requiere todas las condiciones y unidades, y rechaza extras sin dominio', () => {
    const f = fixtureSintetico();
    expect(evaluarMedicion({ ...f, condiciones: {} }).estado).toBe('no-evaluable');
    expect(evaluarMedicion({ ...f, condiciones: { ...f.condiciones, frecuencia: { unidad: 'Hz', valor: 1 } } }).estado).toBe('no-evaluable');
    f.condiciones.tiempo.unidad = 'ms';
    expect(evaluarMedicion(f).estado).toBe('no-evaluable');
  });
  it('no extrapola dominio ni usa DC para validar transitorio', () => {
    const f = fixtureSintetico(); f.condiciones.temperatura.valor = 31;
    expect(evaluarMedicion(f).estado).toBe('fuera-de-dominio');
    f.condiciones.temperatura.valor = 25; f.prediccion.fenomeno = 'transitorio';
    expect(evaluarMedicion(f).estado).toBe('fuera-de-dominio');
  });
  it('exige regla antes de comparar, fecha UTC real y k positivo', () => {
    const f = fixtureSintetico();
    expect(evaluarMedicion({ ...f, regla: undefined }).estado).toBe('no-evaluable');
    f.regla.k = 0; expect(evaluarMedicion(f).estado).toBe('no-evaluable');
    f.regla.k = 2; f.regla.definidoEn = '2026-10-05T12:00:00Z';
    expect(evaluarMedicion(f).estado).toBe('no-evaluable');
    f.regla.definidoEn = '2026-02-30T12:00:00Z';
    expect(evaluarMedicion(f).estado).toBe('no-evaluable');
  });
  it('metadata de laboratorio y calibración no certifica ni admite datos de ajuste', () => {
    const f = fixtureSintetico();
    const r = evaluarMedicion({ ...f, origen: 'laboratorio' });
    expect(r.clasificacion).toBe('datos-declarados'); expect(r.certificacion).toBe(false);
    expect(evaluarMedicion({ ...f, uso: 'ajuste' }).estado).toBe('no-evaluable');
  });
  it('rechaza payloads vacíos, versiones y aritmética desbordada', () => {
    expect(evaluarMedicion(null).estado).toBe('no-evaluable');
    expect(evaluarMedicion({ ...fixtureSintetico(), schema: 2 }).estado).toBe('no-evaluable');
    const f = fixtureSintetico(); f.medicion.incertidumbreEstandar = 1e308;
    expect(evaluarMedicion(f).estado).toBe('no-evaluable');
  });
  it('respeta límites inclusivos y no transforma unidades implícitamente', () => {
    const f = fixtureSintetico();
    f.regla.limiteAbsoluto = 0; f.prediccion.valor = 2.5; f.correlacion.rho = 1;
    expect(evaluarMedicion(f).estado).toBe('aceptado');
    f.condiciones.tiempo.valor = 10;
    expect(evaluarMedicion(f).estado).toBe('aceptado');
    f.medicion.unidad = 'mV';
    expect(evaluarMedicion(f).estado).toBe('no-evaluable');
  });
  it('exige identidad, fecha, fuente y presupuesto documentados', () => {
    const f = fixtureSintetico();
    expect(evaluarMedicion({ ...f, instrumento: { id: '', calibracion: '' } }).estado).toBe('no-evaluable');
    expect(evaluarMedicion({ ...f, identidad: { ...f.identidad, modelo: '' } }).estado).toBe('no-evaluable');
    expect(evaluarMedicion({ ...f, medicion: { ...f.medicion, presupuesto: '' } }).estado).toBe('no-evaluable');
    expect(evaluarMedicion({ ...f, regla: { ...f.regla, fuente: '' } }).estado).toBe('no-evaluable');
    expect(evaluarMedicion({ ...f, registradoEn: 'ayer' }).estado).toBe('no-evaluable');
    expect(evaluarMedicion({ ...f, dominio: { ...f.dominio, condiciones: { temperatura: f.dominio.condiciones.temperatura } }, condiciones: { temperatura: f.condiciones.temperatura } }).estado).toBe('no-evaluable');
  });
  it('rechaza presupuesto negativo y rangos invertidos', () => {
    const f = fixtureSintetico(); f.prediccion.incertidumbreEstandar = -0.01;
    expect(evaluarMedicion(f).estado).toBe('no-evaluable');
    f.prediccion.incertidumbreEstandar = 0.01; f.dominio.condiciones.tiempo.min = 11;
    expect(evaluarMedicion(f).estado).toBe('no-evaluable');
  });

  it('correlación perfecta no desborda al cancelar incertidumbres idénticas enormes', () => {
    const f = fixtureSintetico(); f.medicion.incertidumbreEstandar = 1e308;
    f.prediccion.incertidumbreEstandar = 1e308; f.correlacion.rho = 1;
    expect(evaluarMedicion(f).incertidumbreDiferencia).toBe(0);
    expect(evaluarMedicion(f).estado).toBe('aceptado');
  });

});
