/** Datos inventados para probar el contrato: nunca mediciones de hardware. */
export function fixtureSintetico() {
  return {
    schema: 1,
    id: 'divisor-sintetico', origen: 'sintetico', uso: 'validacion',
    identidad: { modelo: 'R-ideal-v1', solver: 'analitico-v1', firmware: 'no-aplica', hardware: 'NO-HARDWARE', fixture: 'divisor-inventado-v1' },
    procedimiento: 'Generación aritmética de valores inventados para tests.',
    instrumento: { id: 'NO-INSTRUMENTO', calibracion: 'NO-CALIBRACION: sintético' },
    registradoEn: '2026-10-04T12:00:00Z',
    dominio: { fenomeno: 'dc', magnitud: 'tension', unidad: 'V', condiciones: { temperatura: { unidad: 'degC', min: 20, max: 30 }, tiempo: { unidad: 's', min: 0, max: 10 } } },
    condiciones: { temperatura: { unidad: 'degC', valor: 25 }, tiempo: { unidad: 's', valor: 1 } },
    medicion: { unidad: 'V', valor: 2.5, incertidumbreEstandar: 0.01, presupuesto: 'Inventado: u=0.01 V para probar decisiones.' },
    prediccion: { unidad: 'V', valor: 2.51, incertidumbreEstandar: 0.01, presupuesto: 'Inventado: u=0.01 V para probar decisiones.', fenomeno: 'dc' },
    correlacion: { rho: 0, justificacion: 'Independencia supuesta solo en este fixture sintético.' },
    regla: { tipo: 'intervalo-guardado', limiteAbsoluto: 0.1, k: 2, justificacion: 'Criterio inventado de test; no tolerancia de hardware.', definidoEn: '2026-10-03T12:00:00Z', fuente: 'fixture-sintetico-v1' },
  };
}
