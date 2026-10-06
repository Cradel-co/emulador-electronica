import { describe, expect, it } from 'vitest';
import { calcularTermicaRc, type ModeloTermicoRc } from './termica.js';

const modelo: ModeloTermicoRc = {
  id: 'equivalente-sintetico', fuente: 'Caso analítico, no medición de laboratorio',
  condiciones: 'Un cuerpo isotermo, ambiente fijo, parámetros constantes',
  resistenciaKPorW: 10, capacidadJPorK: 2, ambienteC: 25, inicialC: 25,
  rangoDeclaradoC: [-20, 150],
};

describe('térmica RC unidireccional', () => {
  it('resuelve el calentamiento y enfriamiento exponenciales con tau=RC', () => {
    const caliente = calcularTermicaRc(modelo, [0, 20], [3, 3]);
    expect(caliente.temperaturaC[1]).toBeCloseTo(25 + 30 * (1 - Math.exp(-1)), 12);
    const frio = calcularTermicaRc({ ...modelo, inicialC: 75 }, [0, 20], [0, 0]);
    expect(frio.temperaturaC[1]).toBeCloseTo(25 + 50 * Math.exp(-1), 12);
    expect(frio.energiaEvacuadaJ).toBeCloseTo(100 * (1 - Math.exp(-1)), 12);
    expect(frio.energiaAlmacenadaDeltaJ).toBeCloseTo(-frio.energiaEvacuadaJ, 12);
  });

  it('integra exactamente una rampa lineal de potencia y no depende del muestreo', () => {
    const a = calcularTermicaRc(modelo, [0, 20], [0, 3]);
    const b = calcularTermicaRc(modelo, [0, 2, 7, 11, 20], [0, 0.3, 1.05, 1.65, 3]);
    expect(a.temperaturaC[1]).toBeCloseTo(25 + 30 / Math.E, 12);
    expect(b.temperaturaC.at(-1)).toBeCloseTo(25 + 30 / Math.E, 12);
    expect(a.energiaDisipadaJ).toBe(30);
    expect(a.energiaAlmacenadaDeltaJ + a.energiaEvacuadaJ).toBeCloseTo(30, 12);
  });

  it('no confunde trabajo eléctrico de un capacitor con calor disipado', () => {
    expect(() => calcularTermicaRc(modelo, [0, 1], [0, -1])).toThrow(/disipada/);
  });

  it('mantiene precisión ante pasos muy pequeños y equilibrio de muy largo plazo', () => {
    const corto = calcularTermicaRc(modelo, [0, 1e-9], [0, 3]);
    expect(corto.temperaturaC[1]).toBeCloseTo(25 + 7.5e-10, 12);
    const largo = calcularTermicaRc(modelo, [0, 1e6], [3, 3]);
    expect(largo.temperaturaC[1]).toBeCloseTo(55, 12);
  });

  it('exige datos de procedencia y dominio; nunca acredita hardware automáticamente', () => {
    const r = calcularTermicaRc(modelo, [1e-9, 1], [0, 0]);
    expect(r.perfil).toBe('termico-rc-unidireccional');
    expect(r.caracterizadoEnLaboratorio).toBe(false);
    expect(r.inicioS).toBe(1e-9);
    expect(() => calcularTermicaRc({ ...modelo, fuente: '' }, [0, 1], [0, 0])).toThrow(/fuente/);
    expect(() => calcularTermicaRc({ ...modelo, rangoDeclaradoC: [0, 26] }, [0, 20], [3, 3])).toThrow(/dominio/);
  });

  it.each([
    { ...modelo, resistenciaKPorW: 0 }, { ...modelo, capacidadJPorK: -1 },
    { ...modelo, ambienteC: NaN }, { ...modelo, inicialC: -300 },
    { ...modelo, resistenciaKPorW: Number.MAX_VALUE, capacidadJPorK: 2 },
  ])('rechaza parámetros inválidos %j', m => {
    expect(() => calcularTermicaRc(m, [0, 1], [0, 0])).toThrow();
  });

  it.each([
    [[0, 0], [1, 1]], [[1, 0], [1, 1]], [[0, 1], [1]],
    [[0, Infinity], [1, 1]], [[0, 1], [1, NaN]], [[-1, 0], [1, 1]],
  ])('rechaza traza inválida %j', (t, p) => {
    expect(() => calcularTermicaRc(modelo, t, p)).toThrow();
  });
});
