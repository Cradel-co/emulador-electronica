import { describe, expect, it } from 'vitest';
import { PerfilAnalogicoAvrSchema, type PerfilAnalogicoAvr } from '@emu/shared';
import { AdquisicionAdc, type MuestraAdc } from './adquisicionAdc.js';

const perfil = (): Extract<PerfilAnalogicoAvr, { tipo: 'rc-no-ideal' }> => ({
  tipo: 'rc-no-ideal', id: 'rc-sintetico', fuente: 'Oráculo RC analítico, parámetros sintéticos',
  condiciones: 'Fuente DC constante durante adquisición; capacitor ideal sin fuga', rangoVEntrada: { min: 0, max: 5 },
  capacitanciaF: 1e-9, resistenciaInterruptorOhm: 0, resistenciasFuenteOhm: { 0: 10_000, 1: 10_000 },
  adquisicionS: 10e-6, voltajeInicialV: 0, ganancia: 1, offsetLsb: 0, ruido: null,
});
const muestra = (voltaje: number | null = 5): MuestraAdc => ({ canal: '0', voltaje, referencia: 5, avcc: 5, ventanaS: 12e-6 });

describe('adquisición ADC RC explícita con memoria', () => {
  it('preserva perfil ideal y cuantización predeterminados', () => {
    expect(new AdquisicionAdc().convertir(muestra(2.5))).toMatchObject({ perfil: 'ideal-10bits', voltajeRetenido: 2.5, cuenta: 512 });
  });
  it('a una y dos constantes de tiempo coincide con valores analíticos independientes', () => {
    const adc = new AdquisicionAdc(perfil());
    // Solución de dV/dt=(5-V)/tau: V(tau)=3.160602794, V(2tau)=4.323323584.
    expect(adc.convertir(muestra()).voltajeRetenido).toBeCloseTo(3.1606027941427883, 12);
    expect(adc.convertir(muestra()).voltajeRetenido).toBeCloseTo(4.323323583816936, 12);
  });
  it('la carga del canal anterior persiste al multiplexar y recupera asentamiento', () => {
    const p = perfil(); p.voltajeInicialV = 5;
    const adc = new AdquisicionAdc(p);
    const baja = { ...muestra(0), canal: '1' as const };
    expect(adc.convertir(baja).voltajeRetenido).toBeCloseTo(1.8393972058572117, 12);
    expect(adc.convertir(baja).voltajeRetenido).toBeCloseTo(0.6766764161830635, 12);
    for (let i = 0; i < 10; i++) adc.convertir(baja);
    expect(adc.convertir(baja).cuenta).toBe(0);
  });
  it('suma impedancia de fuente e interruptor; duplicar tau conserva más error', () => {
    const p = perfil(); p.resistenciaInterruptorOhm = 10_000;
    expect(new AdquisicionAdc(p).convertir(muestra()).voltajeRetenido).toBeCloseTo(1.9673467014368329, 12);
  });
  it('tiempo cero conserva carga; impedancia cero y tiempo positivo asienta completamente', () => {
    const p = perfil(); p.adquisicionS = 0; p.voltajeInicialV = 2;
    expect(new AdquisicionAdc(p).convertir(muestra()).voltajeRetenido).toBe(2);
    p.adquisicionS = 1e-6; p.resistenciasFuenteOhm[0] = 0;
    expect(new AdquisicionAdc(p).convertir(muestra()).voltajeRetenido).toBe(5);
  });
  it('aplica ganancia y offset antes de cuantización y saturación', () => {
    const p = perfil(); p.resistenciasFuenteOhm[0] = 0; p.ganancia = 1.1; p.offsetLsb = -3;
    const adc = new AdquisicionAdc(p);
    expect(adc.convertir(muestra(2.5)).cuenta).toBe(560);
    expect(adc.convertir(muestra(0)).cuenta).toBe(0);
    expect(adc.convertir(muestra(5)).cuenta).toBe(1023);
  });
  it('ruido uniforme con semilla reproduce un vector conocido sin aleatoriedad global', () => {
    const p = perfil(); p.resistenciasFuenteOhm[0] = 0;
    p.ruido = { tipo: 'uniforme', amplitudLsb: 8, semilla: 1 };
    const adc = new AdquisicionAdc(p);
    const obtener = (a: AdquisicionAdc) => Array.from({ length: 4 }, () => a.convertir(muestra(2.5)).cuenta);
    expect(obtener(adc)).toEqual([507, 509, 512, 515]);
    expect(obtener(new AdquisicionAdc(p))).toEqual([507, 509, 512, 515]);
  });
  it('un dato desconocido no consume ruido ni modifica la siguiente conversión', () => {
    const p = perfil(); p.resistenciasFuenteOhm[0] = 0;
    p.ruido = { tipo: 'uniforme', amplitudLsb: 8, semilla: 1 };
    const adc = new AdquisicionAdc(p);
    expect(() => adc.convertir(muestra(null))).toThrow(/desconocido/);
    expect(adc.convertir(muestra(2.5)).cuenta).toBe(507);
  });
  it.each([null, NaN, Infinity, -0.1, 5.1])('rechaza VIN inválido %s sin modificar la carga', voltaje => {
    const adc = new AdquisicionAdc(perfil());
    expect(() => adc.convertir(muestra(voltaje))).toThrow(/ADC/);
    expect(adc.convertir(muestra()).voltajeRetenido).toBeCloseTo(3.1606027941427883, 12);
  });
  it('rechaza impedancia desconocida, referencia ausente y adquisición fuera de ventana', () => {
    const p = perfil(); p.resistenciasFuenteOhm[0] = null;
    expect(() => new AdquisicionAdc(p).convertir(muestra())).toThrow(/impedancia/);
    expect(() => new AdquisicionAdc(perfil()).convertir({ ...muestra(), canal: 'bandgap' })).toThrow(/impedancia/);
    expect(() => new AdquisicionAdc(perfil()).convertir({ ...muestra(), referencia: null })).toThrow(/referencia/);
    expect(() => new AdquisicionAdc(perfil()).convertir({ ...muestra(), ventanaS: 1e-6 })).toThrow(/ventana/);
  });
  it('respeta rango declarado y rechaza estado inicial sobre AVCC', () => {
    const p = perfil(); p.rangoVEntrada = { min: 1, max: 4 };
    expect(() => new AdquisicionAdc(p).convertir(muestra())).toThrow(/rango/);
    p.voltajeInicialV = 6;
    expect(() => new AdquisicionAdc(p).convertir(muestra(2))).toThrow(/retenido/);
  });
  it('congela parámetros y rechaza tau no representable', () => {
    const p = perfil(); const adc = new AdquisicionAdc(p);
    p.resistenciasFuenteOhm[0] = 0;
    expect(adc.convertir(muestra()).voltajeRetenido).toBeCloseTo(3.1606027941427883, 12);
    p.resistenciasFuenteOhm[0] = 1e308; p.capacitanciaF = 1e308;
    expect(() => new AdquisicionAdc(p).convertir(muestra())).toThrow(/constante/);
  });
  it.each([
    { capacitanciaF: 0 }, { resistenciaInterruptorOhm: -1 }, { adquisicionS: NaN }, { ganancia: 0 },
    { offsetLsb: Infinity }, { resistenciasFuenteOhm: { 8: 100 } }, { ruido: { tipo: 'uniforme', amplitudLsb: -1, semilla: 0 } },
    { ruido: { tipo: 'uniforme', amplitudLsb: 1, semilla: 4294967296 } }, { fuente: '' }, { rangoVEntrada: { min: 2, max: 1 } },
  ])('valida parámetros declarados %j', invalido => {
    expect(PerfilAnalogicoAvrSchema.safeParse({ ...perfil(), ...invalido }).success).toBe(false);
  });
});
