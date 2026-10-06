import { describe, expect, it } from 'vitest';
import { dbAPorTension, eventoPorNivel, gananciaPorTension, sonidosDelCircuito, type SalidaSonido } from '../../shared/src/audio.js';

/**
 * Lógica pura del audio: de la tensión que el motor calculó a lo que el navegador tiene que
 * sintetizar. Sin DOM, sin AudioContext y sin motor: todo entra por parámetro.
 *
 * La frecuencia NO se calcula, sale de la hoja de datos (el oscilador es interno al buzzer).
 * Lo que sí se deriva de la tensión es la amplitud, con la regla de la acústica: la presión
 * sonora es proporcional a la tensión, así que la mitad de tensión son −6 dB.
 */

// TMB12A05, el buzzer activo más común: 5 V, 85 dBA a 10 cm, 2,4 kHz, no arranca bajo 2,5 V.
const TMB12A05: SalidaSonido = {
  tipo: 'sonido',
  fuente: 'nivel',
  pins: ['IN', 'GND'],
  hz: 2400,
  umbralV: 2.5,
  dbA: 85,
  referencia: { v: 5, cm: 10 },
};

describe('gananciaPorTension', () => {
  it('a la tensión de la hoja de datos da la amplitud máxima', () => {
    expect(gananciaPorTension(5, 5)).toBe(1);
  });

  it('es proporcional a la tensión', () => {
    expect(gananciaPorTension(2.5, 5)).toBeCloseTo(0.5, 6);
    expect(gananciaPorTension(4, 5)).toBeCloseTo(0.8, 6);
  });

  it('no pasa de 1 aunque le sobre tensión: más allá del máximo distorsiona, no suena más fuerte', () => {
    expect(gananciaPorTension(12, 5)).toBe(1);
  });

  it('sin tensión o al revés, cero (nunca una ganancia negativa)', () => {
    expect(gananciaPorTension(0, 5)).toBe(0);
    expect(gananciaPorTension(-5, 5)).toBe(0);
  });
});

describe('dbAPorTension', () => {
  it('a la tensión de referencia, el dBA de la hoja de datos', () => {
    expect(dbAPorTension(85, 5, 5)).toBeCloseTo(85, 6);
  });

  it('la mitad de tensión son 6 dB menos', () => {
    expect(dbAPorTension(85, 2.5, 5)).toBeCloseTo(79, 1);
  });

  it('el doble de tensión son 6 dB más (el dBA estimado no se recorta: informa, no reproduce)', () => {
    expect(dbAPorTension(85, 10, 5)).toBeCloseTo(91, 1);
  });
});

describe('eventoPorNivel', () => {
  it('con la tensión nominal zumba a la frecuencia de la hoja de datos', () => {
    const e = eventoPorNivel('bz1', TMB12A05, 5);
    expect(e).toMatchObject({ modulo: 'bz1', sonando: true, hz: 2400, ganancia: 1 });
    expect(e.dbA).toBeCloseTo(85, 6);
  });

  it('por debajo del umbral el oscilador no arranca: silencio, no un zumbido flojo', () => {
    const e = eventoPorNivel('bz1', TMB12A05, 2);
    expect(e.sonando).toBe(false);
    expect(e.ganancia).toBe(0);
  });

  it('justo en el umbral ya arranca', () => {
    expect(eventoPorNivel('bz1', TMB12A05, 2.5).sonando).toBe(true);
  });

  it('al revés no zumba', () => {
    expect(eventoPorNivel('bz1', TMB12A05, -5).sonando).toBe(false);
  });

  it('sin umbral declarado, cualquier tensión positiva lo hace sonar', () => {
    const sinUmbral: SalidaSonido = { ...TMB12A05, umbralV: undefined };
    expect(eventoPorNivel('bz1', sinUmbral, 0.1).sonando).toBe(true);
    expect(eventoPorNivel('bz1', sinUmbral, 0).sonando).toBe(false);
  });

  it('sin referencia declarada no inventa una ganancia: suena a amplitud plena', () => {
    const sinRef: SalidaSonido = { ...TMB12A05, referencia: undefined, dbA: undefined };
    const e = eventoPorNivel('bz1', sinRef, 3);
    expect(e.ganancia).toBe(1);
    expect(e.dbA).toBeUndefined();
  });
});

describe('sonidosDelCircuito', () => {
  const salidasDe = (t: string) => (t === 'buzzer-activo' ? [TMB12A05] : undefined);
  const inst = (id: string, type = 'buzzer-activo') => ({ id, type });

  it('saca la tensión de los dos pines declarados y arma el evento', () => {
    const r = sonidosDelCircuito([inst('bz1')], salidasDe, { 'bz1.IN': 5, 'bz1.GND': 0 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ modulo: 'bz1', sonando: true, hz: 2400, ganancia: 1 });
  });

  it('usa la diferencia, no la tensión absoluta: 5 V sobre 3 V no alcanza el umbral', () => {
    const r = sonidosDelCircuito([inst('bz1')], salidasDe, { 'bz1.IN': 5, 'bz1.GND': 3 });
    expect(r[0]!.sonando).toBe(false);
  });

  it('un módulo sin cablear no suena: si no hay tensión medida, silencio', () => {
    const r = sonidosDelCircuito([inst('bz1')], salidasDe, {});
    expect(r[0]).toMatchObject({ modulo: 'bz1', sonando: false, ganancia: 0 });
  });

  it('los módulos que no declaran sonido no generan eventos', () => {
    expect(sonidosDelCircuito([inst('led1', 'led')], salidasDe, { 'led1.IN': 5 })).toEqual([]);
  });

  it('todavía no reproduce pwm ni i2s: no inventa un evento que no puede sintetizar', () => {
    const porPwm = (): SalidaSonido[] => [{ ...TMB12A05, fuente: 'pwm' }];
    expect(sonidosDelCircuito([inst('bz1')], porPwm, { 'bz1.IN': 5, 'bz1.GND': 0 })).toEqual([]);
  });

  it('varias instancias del mismo módulo son eventos independientes', () => {
    const r = sonidosDelCircuito([inst('bz1'), inst('bz2')], salidasDe, {
      'bz1.IN': 5, 'bz1.GND': 0, 'bz2.IN': 3, 'bz2.GND': 0,
    });
    expect(r.map((e) => [e.modulo, e.sonando, Number(e.ganancia.toFixed(1))]))
      .toEqual([['bz1', true, 1], ['bz2', true, 0.6]]);
  });
});
