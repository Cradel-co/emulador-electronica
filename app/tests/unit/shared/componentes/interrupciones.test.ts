import { describe, expect, it } from 'vitest';
import { ControladorInterrupciones } from '../../../../shared/src/componentes/interrupciones.js';

describe('controlador propio de interrupciones', () => {
  it.each(['ascendente', 'descendente', 'ambos'] as const)('enclava flancos %s hasta reconocerlos', modo => {
    const c = new ControladorInterrupciones([{ id: 'I', modo, habilitada: true }]);
    c.muestrear('I', modo === 'descendente' ? 1 : 0);
    expect(c.irq).toBe(false);
    c.muestrear('I', modo === 'descendente' ? 0 : 1);
    expect(c.irq).toBe(true);
    c.muestrear('I', 'X');
    expect(c.irq).toBe(true);
    c.reconocer('I'); expect(c.irq).toBe(false);
  });
  it('no inventa flancos al arrancar ni al salir de un nivel indeterminado', () => {
    const c = new ControladorInterrupciones([{ id: 'I', modo: 'ambos', habilitada: true }]);
    for (const nivel of [1, 'X', 0, 'X', 1] as const) { c.muestrear('I', nivel); expect(c.irq).toBe(false); }
    c.muestrear('I', 0); expect(c.irq).toBe(true);
  });
  it.each(['alto', 'bajo'] as const)('el nivel %s sigue pendiente tras reconocer mientras esté activo', modo => {
    const c = new ControladorInterrupciones([{ id: 'I', modo, habilitada: true }]);
    c.muestrear('I', modo === 'alto' ? 1 : 0); c.reconocer('I'); expect(c.irq).toBe(true);
    c.muestrear('I', 'X'); expect(c.irq).toBe(false);
    c.muestrear('I', modo === 'alto' ? 0 : 1); expect(c.irq).toBe(false);
  });
  it('enmascara la entrega sin perder el flanco y reconoce cada fuente por separado', () => {
    const c = new ControladorInterrupciones([{ id: 'a', modo: 'ascendente' }, { id: 'b', modo: 'ascendente', habilitada: true }]);
    for (const id of ['a', 'b']) { c.muestrear(id, 0); c.muestrear(id, 1); }
    c.reconocer('b'); expect(c.irq).toBe(false);
    expect(c.estado[0]).toMatchObject({ pendiente: true, habilitada: false });
    c.habilitar('a', true); expect(c.irq).toBe(true);
    c.reconocer('a'); expect(c.irq).toBe(false);
  });
  it('reinicia muestras, pendientes y máscaras sin compartir estado ni exponer referencias', () => {
    const config = [{ id: 'I', modo: 'alto' as const, habilitada: true }];
    const a = new ControladorInterrupciones(config), b = new ControladorInterrupciones(config);
    const original = config[0]; if (!original) throw new Error('fixture'); original.id = 'otro';
    a.muestrear('I', 1); a.habilitar('I', false);
    const copia = a.estado[0]; if (!copia) throw new Error('fixture'); copia.pendiente = false;
    expect(a.estado[0]?.pendiente).toBe(true); expect(b.irq).toBe(false);
    a.reiniciar(); expect(a.estado).toEqual([{ id: 'I', modo: 'alto', habilitada: true, nivel: 'X', pendiente: false }]);
  });
  it('rechaza configuraciones y operaciones inválidas', () => {
    expect(() => new ControladorInterrupciones([])).toThrow();
    expect(() => new ControladorInterrupciones(Array.from({ length: 65 }, (_, i) => ({ id: `i${i}`, modo: 'alto' })))).toThrow();
    expect(() => new ControladorInterrupciones([{ id: 'I', modo: 'alto' }, { id: 'I', modo: 'bajo' }])).toThrow();
    const c = new ControladorInterrupciones([{ id: 'I', modo: 'alto' }]);
    expect(() => c.muestrear('otro', 0)).toThrow();
    expect(() => c.reconocer('otro')).toThrow();
    expect(() => c.habilitar('otro', true)).toThrow();
    // @ts-expect-error Comprueba llamadas inválidas procedentes de datos sin tipar.
    expect(() => c.muestrear('I', 2)).toThrow(/Nivel/);
    // @ts-expect-error La API comprueba también los valores en ejecución.
    expect(() => c.habilitar('I', 1)).toThrow(/Máscara/);
    // @ts-expect-error Un modo desconocido no debe aceptarse desde datos externos.
    expect(() => new ControladorInterrupciones([{ id: 'I', modo: 'pulso' }])).toThrow();
  });
  it('mantiene independientes las 64 fuentes, incluidas las superiores a 32', () => {
    const c = new ControladorInterrupciones(Array.from({ length: 64 }, (_, i) => ({ id: `i${i}`, modo: 'alto', habilitada: true })));
    c.muestrear('i63', 1);
    expect(c.estado.filter(f => f.pendiente).map(f => f.id)).toEqual(['i63']);
    expect(c.irq).toBe(true);
    c.habilitar('i63', false); expect(c.irq).toBe(false);
    expect(c.estado[31]?.habilitada).toBe(true);
  });
});
