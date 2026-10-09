import { describe, expect, it, vi } from 'vitest';
import { evaluarCanalRf, transmitirPorCanalRf, type CanalRf, type PresupuestoRf } from './canalRf.js';
import { enlaceRfDePrueba } from './canalRf.fixture.js';

function presupuesto(entrada: unknown): PresupuestoRf {
  const r = evaluarCanalRf(entrada);
  if (r.modo !== 'friis-espacio-libre') throw new Error(`No calculó el presupuesto: ${JSON.stringify(r)}`);
  return r;
}

describe('canal RF declarado, sin atribución a radios comerciales', () => {
  it('contrasta Friis en dB contra densidad de flujo y apertura efectiva en vatios', () => {
    const r = presupuesto(enlaceRfDePrueba());
    // Oráculo independiente en unidades lineales: 1 mW / superficie de esfera por apertura λ²/(4π).
    const flujoWPorM2 = 0.001 / (4 * Math.PI * 100 ** 2);
    const aperturaM2 = 1 / (4 * Math.PI); // λ=1 m exactamente.
    expect(r.potenciaRecibidaW / (flujoWPorM2 * aperturaM2)).toBeCloseTo(1, 12);
    expect(r.potenciaRecibidaDbm).toBeCloseTo(-61.984197280441926, 10);
    expect(r).toMatchObject({ modo: 'friis-espacio-libre', estado: 'sobre-umbral', permitirRecepcion: true });
  });

  it('duplicar distancia o frecuencia agrega 6,020599913 dB; el ejemplo TI a 2445 MHz/100 m da 80,2 dB', () => {
    const c = enlaceRfDePrueba(), r = presupuesto(c);
    expect(presupuesto({ ...c, distanciaM: 200 }).perdidaEspacioLibreDb - r.perdidaEspacioLibreDb).toBeCloseTo(6.020599913, 8);
    expect(presupuesto({ ...c, frecuenciaHz: c.frecuenciaHz * 2 }).perdidaEspacioLibreDb - r.perdidaEspacioLibreDb).toBeCloseTo(6.020599913, 8);
    expect(presupuesto({ ...c, frecuenciaHz: 2445e6 }).perdidaEspacioLibreDb).toBeCloseTo(80.2, 1);
  });

  it.each([{ valor: 0, unidad: 'dBm' }, { valor: 1, unidad: 'mW' }, { valor: 0.001, unidad: 'W' }])('convierte $valor $unidad sin confundir vatios y milivatios', potencia => {
    const c = enlaceRfDePrueba();
    const r = presupuesto({ ...c, transmisor: { ...c.transmisor, potencia } });
    expect(r.potenciaTransmitidaDbm).toBe(0);
    expect(r.potenciaRecibidaDbm).toBeCloseTo(-61.984197280441926, 10);
  });

  it('suma ganancias en dBi, resta pérdidas y aplica cos² solo a polarización lineal ideal', () => {
    const c = enlaceRfDePrueba(), base = presupuesto(c);
    c.transmisor.gananciaDbi = 3; c.receptor.gananciaDbi = 2;
    c.transmisor.perdidasDb = 1; c.receptor.perdidasDb = 0.5; c.polarizacion.anguloGrados = 60;
    const r = presupuesto(c);
    expect(r.eirpDbm).toBe(2);
    expect(r.perdidaPolarizacionDb).toBeCloseTo(6.020599913, 8);
    expect(r.potenciaRecibidaW / base.potenciaRecibidaW).toBeCloseTo(10 ** (3.5 / 10) * 0.25, 12);
    const declarado = presupuesto({ ...c, polarizacion: { tipo: 'perdida-declarada', perdidaDb: 3, fuente: 'medición sintética' } });
    expect(declarado.perdidaPolarizacionDb).toBe(3);
  });

  it('polarización ortogonal ideal significa cero señal y es serializable sin Infinity/NaN', () => {
    const c = enlaceRfDePrueba(); c.polarizacion.anguloGrados = 90;
    const r = presupuesto(c);
    expect(r).toMatchObject({ estado: 'polarizacion-ortogonal', permitirRecepcion: false, potenciaRecibidaW: 0, potenciaRecibidaDbm: null, perdidaPolarizacionDb: null });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it.each([{ angulo: 45, perdida: 3.0103 }, { angulo: 30, perdida: 1.2494 }])('contrasta polarización $angulo° con el ejemplo publicado de MathWorks', ({ angulo, perdida }) => {
    const c = enlaceRfDePrueba(); c.polarizacion.anguloGrados = angulo;
    expect(presupuesto(c).perdidaPolarizacionDb).toBeCloseTo(perdida, 4);
  });

  it('solo decide recepción con umbral declarado y usa el mayor entre sensibilidad y ruido+SNR', () => {
    const c: CanalRf = enlaceRfDePrueba();
    delete c.receptor.sensibilidadDbm;
    expect(presupuesto(c)).toMatchObject({ estado: 'sin-criterio', umbralDbm: null, permitirRecepcion: false });
    c.receptor.ruido = { potenciaDbm: -80, snrMinimoDb: 10, fuente: 'ruido de banco sintético', condiciones: 'BW=10 kHz' };
    expect(presupuesto(c)).toMatchObject({ umbralDbm: -70, permitirRecepcion: true });
    c.receptor.sensibilidadDbm = -60;
    expect(presupuesto(c)).toMatchObject({ umbralDbm: -60, estado: 'bajo-umbral', permitirRecepcion: false });
  });

  it('el límite de recepción es inclusivo y no redondea el margen antes de decidir', () => {
    const c = enlaceRfDePrueba();
    const nivel = presupuesto(c).potenciaRecibidaDbm;
    if (nivel === null) throw new Error('El caso sintético debe tener señal');
    c.receptor.sensibilidadDbm = nivel;
    expect(presupuesto(c)).toMatchObject({ margenDb: 0, permitirRecepcion: true });
    c.receptor.sensibilidadDbm += 1e-8;
    expect(presupuesto(c).permitirRecepcion).toBe(false);
  });

  it('rechaza potencia lineal negativa, datos sin fuente y pérdidas negativas, sin inventar sensibilidad', () => {
    const c = enlaceRfDePrueba();
    for (const transmisor of [
      { ...c.transmisor, potencia: { valor: -1, unidad: 'W' } },
      { ...c.transmisor, fuente: '' },
      { ...c.transmisor, perdidasDb: -1 },
    ]) expect(evaluarCanalRf({ ...c, transmisor })).toMatchObject({ estado: 'datos-invalidos', permitirRecepcion: false });
  });

  it('no confunde underflow/overflow numérico con una señal física cero', () => {
    const c = enlaceRfDePrueba();
    for (const valor of [-1e6, 1e6]) expect(evaluarCanalRf({ ...c, transmisor: { ...c.transmisor, potencia: { valor, unidad: 'dBm' } } }))
      .toMatchObject({ modo: 'no-resuelto', estado: 'datos-invalidos', permitirRecepcion: false });
  });

  it.each(['espacioLibre', 'lineaDeVista', 'campoLejano', 'sinMultitrayecto', 'sinInterferencias'] as const)('rechaza fuera de dominio: %s=false sin fallback funcional', condicion => {
    const c = enlaceRfDePrueba(); c.dominio[condicion] = false;
    expect(evaluarCanalRf(c)).toMatchObject({ modo: 'no-resuelto', estado: 'fuera-dominio', permitirRecepcion: false });
  });

  it('rechaza el campo cercano aunque se declare campo lejano, usando ambas dimensiones y 10λ', () => {
    const c = enlaceRfDePrueba(); c.distanciaM = 1;
    expect(evaluarCanalRf(c)).toMatchObject({ estado: 'fuera-dominio', permitirRecepcion: false });
    c.distanciaM = 100; c.receptor.dimensionAntenaM = 10; // 2D²/λ=200 m.
    expect(evaluarCanalRf(c)).toMatchObject({ estado: 'fuera-dominio', permitirRecepcion: false });
    c.distanciaM = 201;
    expect(presupuesto(c).distanciaMinimaCampoLejanoM).toBe(200);
  });

  it.each([null, {}, { frecuenciaHz: 433e6 }, { ...enlaceRfDePrueba(), distanciaM: 0 }, { ...enlaceRfDePrueba(), frecuenciaHz: Infinity }])('no convierte una configuración inválida en recepción funcional: %#', entrada => {
    expect(evaluarCanalRf(entrada)).toMatchObject({ modo: 'no-resuelto', estado: 'datos-invalidos', permitirRecepcion: false });
  });

  it('sin modelo mantiene únicamente la recepción funcional explícita; debajo del umbral no inyecta', async () => {
    const enviar = vi.fn(() => true);
    expect(await transmitirPorCanalRf('101', 1, undefined, enviar)).toMatchObject({ entregado: true, evaluacion: { modo: 'funcional', estado: 'sin-modelo' } });
    const c = enlaceRfDePrueba(); c.receptor.sensibilidadDbm = -50;
    expect(await transmitirPorCanalRf('000', 1, c, enviar)).toMatchObject({ entregado: false, evaluacion: { estado: 'bajo-umbral' } });
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar).toHaveBeenCalledWith('101', 1, undefined);
  });
  it('pasa el canal completo al adaptador de entrega para validar destino y alimentación', async () => {
    const c = enlaceRfDePrueba(), enviar = vi.fn(async () => false);
    expect(await transmitirPorCanalRf('101', 1, c, enviar)).toMatchObject({ entregado: false });
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar).toHaveBeenCalledWith('101', 1, c);
  });
});
