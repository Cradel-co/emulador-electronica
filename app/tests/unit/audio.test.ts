import { describe, expect, it } from 'vitest';
import { armonicosDePulso, dbAPorTension, eventoPorNivel, eventoPorPwm, gananciaPorTension, sonidosDelCircuito, type SalidaSonido } from '../../shared/src/audio.js';

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

  it('i2s no genera evento: sin el flujo de muestras no hay nada que sintetizar', () => {
    const porI2s = (): SalidaSonido[] => [{ ...TMB12A05, fuente: 'i2s' }];
    expect(sonidosDelCircuito([inst('bz1')], porI2s, { 'bz1.IN': 5, 'bz1.GND': 0 })).toEqual([]);
  });

  it('pwm sin PWM declarado suena en silencio, no inventa un tono', () => {
    const porPwm = (): SalidaSonido[] => [{ ...TMB12A05, fuente: 'pwm' }];
    const r = sonidosDelCircuito([inst('bz1')], porPwm, { 'bz1.IN': 5, 'bz1.GND': 0 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ modulo: 'bz1', sonando: false, ganancia: 0 });
  });

  it('varias instancias del mismo módulo son eventos independientes', () => {
    const r = sonidosDelCircuito([inst('bz1'), inst('bz2')], salidasDe, {
      'bz1.IN': 5, 'bz1.GND': 0, 'bz2.IN': 3, 'bz2.GND': 0,
    });
    expect(r.map((e) => [e.modulo, e.sonando, Number(e.ganancia.toFixed(1))]))
      .toEqual([['bz1', true, 1], ['bz2', true, 0.6]]);
  });
});

describe('sonidosDelCircuito: quién decide si suena', () => {
  const salidasDe = (t: string) => (t === 'buzzer-activo' ? [TMB12A05] : undefined);
  const inst = (id: string, type = 'buzzer-activo') => ({ id, type });
  const T = { 'bz1.IN': 5, 'bz1.GND': 0 };

  /**
   * El umbral vive en el modelo del módulo, que además tiene histéresis y ve la corriente real.
   * `umbralV` solo puede aproximarlo, así que cuando el modelo opinó, su veredicto manda: si no,
   * el módulo puede prender su SVG y quedarse callado, o al revés.
   */
  it('el modelo manda: dice que conduce aunque la tensión no llegue al umbral declarado', () => {
    const r = sonidosDelCircuito([inst('bz1')], salidasDe, { 'bz1.IN': 2.44, 'bz1.GND': 0 }, () => ({ on: true }));
    expect(r[0]!.sonando).toBe(true);
    expect(r[0]!.ganancia).toBeCloseTo(2.44 / 5, 3);
  });

  it('el modelo manda también al revés: no conduce aunque la tensión alcance el umbral', () => {
    const r = sonidosDelCircuito([inst('bz1')], salidasDe, { 'bz1.IN': 2.5, 'bz1.GND': 0 }, () => ({ on: false }));
    expect(r[0]!.sonando).toBe(false);
    expect(r[0]!.ganancia).toBe(0);
  });

  it('sin veredicto del modelo cae al umbral declarado', () => {
    expect(sonidosDelCircuito([inst('bz1')], salidasDe, T, () => undefined)[0]!.sonando).toBe(true);
    expect(sonidosDelCircuito([inst('bz1')], salidasDe, T)[0]!.sonando).toBe(true);
    expect(sonidosDelCircuito([inst('bz1')], salidasDe, { 'bz1.IN': 2, 'bz1.GND': 0 }, () => ({}))[0]!.sonando).toBe(false);
  });

  it('un ui sin `on` no es un veredicto: no obliga a callar', () => {
    expect(sonidosDelCircuito([inst('bz1')], salidasDe, T, () => ({ brillo: 0.5 }))[0]!.sonando).toBe(true);
  });
});

describe('eventoPorPwm: la frecuencia la pone el micro', () => {
  /** Piezo pasivo de 3,3 V: no tiene oscilador, así que no declara `hz`. */
  const PIEZO: SalidaSonido = {
    tipo: 'sonido', fuente: 'pwm', pins: ['IN', 'GND'],
    dbA: 80, referencia: { v: 3.3, cm: 10 }, forma: 'cuadrada',
  };

  it('toma la frecuencia del PWM, no de la hoja de datos', () => {
    const e = eventoPorPwm('bz1', PIEZO, 3.3, { hz: 440, duty: 0.5 });
    expect(e).toMatchObject({ sonando: true, hz: 440 });
  });

  it('al 50 % de duty da la amplitud plena de su tensión', () => {
    expect(eventoPorPwm('bz1', PIEZO, 3.3, { hz: 440, duty: 0.5 }).ganancia).toBeCloseTo(1, 3);
  });

  /**
   * La amplitud del fundamental de una onda cuadrada va con sen(π·duty): máxima al 50 % y nula
   * en los extremos, donde la señal es continua y un piezo no mueve nada.
   */
  it('fuera del 50 % baja según sen(pi·duty)', () => {
    expect(eventoPorPwm('bz1', PIEZO, 3.3, { hz: 440, duty: 0.25 }).ganancia).toBeCloseTo(Math.SQRT1_2, 3);
    expect(eventoPorPwm('bz1', PIEZO, 3.3, { hz: 440, duty: 0.75 }).ganancia).toBeCloseTo(Math.SQRT1_2, 3);
  });

  /**
   * La firma de sen(π·duty) es la simetría alrededor del 50 %: 5 % y 95 % dan lo mismo, igual que
   * 25 % y 75 %. Verificado también con el firmware corriendo, con estos mismos valores.
   */
  it('es simétrica alrededor del 50 %: 5 % y 95 % suenan igual', () => {
    const g = (duty: number) => eventoPorPwm('bz1', PIEZO, 3.3, { hz: 440, duty }).ganancia;
    expect(g(0.05)).toBeCloseTo(g(0.95), 6);
    expect(g(0.05)).toBeCloseTo(0.156, 3);
    expect(g(0.25)).toBeCloseTo(g(0.75), 6);
  });

  it('con duty 0 o 1 la señal es continua: no suena', () => {
    expect(eventoPorPwm('bz1', PIEZO, 3.3, { hz: 440, duty: 0 }).sonando).toBe(false);
    expect(eventoPorPwm('bz1', PIEZO, 3.3, { hz: 440, duty: 1 }).sonando).toBe(false);
  });

  it('sin PWM configurado no suena, en vez de inventar una frecuencia', () => {
    const e = eventoPorPwm('bz1', PIEZO, 3.3, undefined);
    expect(e.sonando).toBe(false);
    expect(e.hz).toBeUndefined();
  });

  it('una frecuencia no usable no suena', () => {
    expect(eventoPorPwm('bz1', PIEZO, 3.3, { hz: 0, duty: 0.5 }).sonando).toBe(false);
  });

  it('sin tensión no suena aunque el PWM esté configurado', () => {
    expect(eventoPorPwm('bz1', PIEZO, 0, { hz: 440, duty: 0.5 }).sonando).toBe(false);
  });

  it('la mitad de tensión, la mitad de amplitud y 6 dB menos', () => {
    const entera = eventoPorPwm('bz1', PIEZO, 3.3, { hz: 440, duty: 0.5 });
    const mitad = eventoPorPwm('bz1', PIEZO, 1.65, { hz: 440, duty: 0.5 });
    expect(mitad.ganancia).toBeCloseTo(entera.ganancia / 2, 3);
    expect(entera.dbA! - mitad.dbA!).toBeCloseTo(6, 1);
  });

  it('el duty también cuenta para los dB: al 25 % se pierden 3 dB', () => {
    const medio = eventoPorPwm('bz1', PIEZO, 3.3, { hz: 440, duty: 0.5 });
    const cuarto = eventoPorPwm('bz1', PIEZO, 3.3, { hz: 440, duty: 0.25 });
    expect(medio.dbA! - cuarto.dbA!).toBeCloseTo(3, 1);
  });

  it('sonidosDelCircuito usa el PWM del pin que corresponde', () => {
    const salidasDe = (t: string) => (t === 'buzzer-pasivo' ? [PIEZO] : undefined);
    const pwmDe = (id: string, pin: string) => (id === 'bz1' && pin === 'IN' ? { hz: 880, duty: 0.5 } : undefined);
    const r = sonidosDelCircuito([{ id: 'bz1', type: 'buzzer-pasivo' }], salidasDe,
      { 'bz1.IN': 3.3, 'bz1.GND': 0 }, undefined, pwmDe);
    expect(r[0]).toMatchObject({ modulo: 'bz1', sonando: true, hz: 880 });
  });
});

describe('armonicosDePulso: la forma de onda del pulso', () => {
  /**
   * Los coeficientes de Fourier de un pulso de 0 a 1 con ciclo de trabajo `d`. Con ellos el
   * navegador puede sintetizar la onda REAL en vez de una cuadrada simétrica, así que el timbre
   * cambia con el duty como en un piezo de verdad.
   *
   * Para el pulso que arranca en t=0:   aₙ = (2/nπ)·sen(2πnd)   bₙ = (2/nπ)·(1−cos(2πnd))
   */
  const magnitud = (a: Float32Array, b: Float32Array, n: number) => Math.hypot(a[n] ?? 0, b[n] ?? 0);

  it('el término continuo se descarta: no produce sonido y correría la onda', () => {
    const { cos, sen } = armonicosDePulso(0.5, 8);
    expect(cos[0]).toBe(0);
    expect(sen[0]).toBe(0);
  });

  it('al 50 % da la cuadrada clásica: armónicos impares con 4/nπ y los pares en cero', () => {
    const { cos, sen } = armonicosDePulso(0.5, 8);
    for (const n of [2, 4, 6]) expect(magnitud(cos, sen, n), `armónico ${n}`).toBeCloseTo(0, 6);
    for (const n of [1, 3, 5, 7]) {
      expect(magnitud(cos, sen, n), `armónico ${n}`).toBeCloseTo(4 / (n * Math.PI), 5);
    }
  });

  it('el fundamental sigue a sen(pi·d), que es la misma ley del volumen', () => {
    for (const d of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const { cos, sen } = armonicosDePulso(d, 4);
      expect(magnitud(cos, sen, 1), `duty ${d}`).toBeCloseTo((4 / Math.PI) * Math.sin(Math.PI * d), 5);
    }
  });

  it('un duty angosto reparte más energía en los armónicos: eso es el timbre delgado', () => {
    const porDuty = (d: number) => {
      const { cos, sen } = armonicosDePulso(d, 16);
      const f = magnitud(cos, sen, 1);
      let resto = 0;
      for (let n = 2; n <= 15; n++) resto += magnitud(cos, sen, n);
      return resto / f;
    };
    // Al 50 % el fundamental domina; al 10 % los armónicos pesan bastante más.
    expect(porDuty(0.1)).toBeGreaterThan(porDuty(0.5) * 2);
  });

  it('es simétrica: el duty d y 1−d tienen los mismos armónicos en magnitud', () => {
    for (let n = 1; n <= 8; n++) {
      const a = armonicosDePulso(0.25, 8);
      const b = armonicosDePulso(0.75, 8);
      expect(magnitud(a.cos, a.sen, n), `armónico ${n}`).toBeCloseTo(magnitud(b.cos, b.sen, n), 5);
    }
  });

  it('en los extremos no hay onda: la señal es continua', () => {
    for (const d of [0, 1]) {
      const { cos, sen } = armonicosDePulso(d, 8);
      for (let n = 1; n <= 8; n++) expect(magnitud(cos, sen, n), `duty ${d}, armónico ${n}`).toBeCloseTo(0, 6);
    }
  });

  it('devuelve los dos arreglos del largo que pide Web Audio (armónicos + el continuo)', () => {
    const { cos, sen } = armonicosDePulso(0.3, 12);
    expect([cos.length, sen.length]).toEqual([13, 13]);
  });

  it('un duty fuera de rango se recorta en vez de dar NaN', () => {
    for (const d of [-1, 2, Number.NaN]) {
      const { cos, sen } = armonicosDePulso(d, 4);
      expect([...cos, ...sen].every((x) => Number.isFinite(x)), `duty ${d}`).toBe(true);
    }
  });
});
