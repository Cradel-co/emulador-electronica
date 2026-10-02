import { describe, expect, it } from 'vitest';
import { cargarChips } from './catalogoChips.js';
import { MaestroVirtual } from './maestroVirtual.js';

/**
 * Bosch BME280 (chips/bosch-bme280) contra su hoja de datos, BST-BME280-DS001 rev. 1.23.
 * Los valores se decodifican con las fórmulas en punto flotante de la sección 8.1 de la hoja
 * (otro camino que las enteras de 4.2.3 que usa el chip): si coinciden, la cuenta al revés
 * del chip y la compensación del firmware cierran.
 */

const chip = cargarChips().find((c) => c.id === 'bosch-bme280')!;
const DIR = 0x77;

function nuevo(o: { sdo?: 'alto' | 'bajo'; entorno?: Record<string, number> } = {}) {
  const m = new MaestroVirtual();
  m.conectar(chip, { id: 'bme', props: { sdo: o.sdo ?? 'alto' }, entorno: o.entorno });
  m.esperar(3); // pasa el t_startup de 2 ms
  return m;
}

const r8 = (m: MaestroVirtual, reg: number) => m.leerRegistros(DIR, reg, 1)![0]!;
const w8 = (m: MaestroVirtual, reg: number, v: number) => expect(m.escribir(DIR, [reg, v])).toBe(true);

/** Coeficientes leídos del chip, armados como la librería de Adafruit (readCoefficients). */
function calibracion(m: MaestroVirtual) {
  const a = m.leerRegistros(DIR, 0x88, 26)!;
  const b = m.leerRegistros(DIR, 0xe1, 7)!;
  const u16 = (x: number[], i: number) => x[i]! | (x[i + 1]! << 8);
  const s16 = (x: number[], i: number) => { const v = u16(x, i); return v >= 0x8000 ? v - 0x10000 : v; };
  const s8 = (v: number) => (v >= 0x80 ? v - 0x100 : v);
  return {
    T1: u16(a, 0), T2: s16(a, 2), T3: s16(a, 4),
    P1: u16(a, 6), P2: s16(a, 8), P3: s16(a, 10), P4: s16(a, 12), P5: s16(a, 14), P6: s16(a, 16), P7: s16(a, 18), P8: s16(a, 20), P9: s16(a, 22),
    H1: a[25]!, H2: s16(b, 0), H3: b[2]!,
    H4: (s8(b[3]!) << 4) | (b[4]! & 0x0f),
    H5: (s8(b[5]!) << 4) | (b[4]! >> 4),
    H6: s8(b[6]!),
  };
}

/** Lee 0xF7..0xFE en ráfaga (como el ejemplo de la hoja, 4.1) y compensa en doble precisión (8.1). */
function medida(m: MaestroVirtual) {
  const c = calibracion(m);
  const d = m.leerRegistros(DIR, 0xf7, 8)!;
  const adcP = (d[0]! << 12) | (d[1]! << 4) | (d[2]! >> 4);
  const adcT = (d[3]! << 12) | (d[4]! << 4) | (d[5]! >> 4);
  const adcH = (d[6]! << 8) | d[7]!;
  let v1 = (adcT / 16384 - c.T1 / 1024) * c.T2;
  let v2 = (adcT / 131072 - c.T1 / 8192) * (adcT / 131072 - c.T1 / 8192) * c.T3;
  const tFine = Math.trunc(v1 + v2);
  const T = (v1 + v2) / 5120;
  v1 = tFine / 2 - 64000;
  v2 = (v1 * v1 * c.P6) / 32768;
  v2 = v2 + v1 * c.P5 * 2;
  v2 = v2 / 4 + c.P4 * 65536;
  v1 = ((c.P3 * v1 * v1) / 524288 + c.P2 * v1) / 524288;
  v1 = (1 + v1 / 32768) * c.P1;
  let P = 1048576 - adcP;
  P = ((P - v2 / 4096) * 6250) / v1;
  v1 = (c.P9 * P * P) / 2147483648;
  v2 = (P * c.P8) / 32768;
  P = (P + (v1 + v2 + c.P7) / 16) / 100;
  let h = tFine - 76800;
  h = (adcH - (c.H4 * 64 + (c.H5 / 16384) * h)) * ((c.H2 / 65536) * (1 + (c.H6 / 67108864) * h * (1 + (c.H3 / 67108864) * h)));
  h = Math.min(100, Math.max(0, h * (1 - (c.H1 * h) / 524288)));
  return { T, P, H: h, adcT, adcP, adcH };
}

/** Configura y dispara una medición forzada; espera lo que dice la hoja y devuelve la medida. */
function forzada(m: MaestroVirtual, osrs = { t: 1, p: 1, h: 1 }, esperarMs = 50) {
  w8(m, 0xf2, osrs.h);
  w8(m, 0xf4, (osrs.t << 5) | (osrs.p << 2) | 0b01);
  m.esperar(esperarMs);
  return medida(m);
}

describe('BME280: interfaz y registros', () => {
  it('contesta en 0x77 con SDO en alto y en 0x76 con SDO en bajo, y en ninguna otra', () => {
    const alto = nuevo({ sdo: 'alto' });
    expect(alto.sondear(0x77)).toBe(true);
    expect(alto.sondear(0x76)).toBe(false);
    const bajo = nuevo({ sdo: 'bajo' });
    expect(bajo.sondear(0x76)).toBe(true);
    expect(bajo.sondear(0x77)).toBe(false);
  });

  it('no contesta durante el t_startup (2 ms) y después sí', () => {
    const m = new MaestroVirtual();
    m.conectar(chip, { id: 'bme', props: {} });
    m.esperar(1.9);
    expect(m.sondear(DIR)).toBe(false);
    m.esperar(0.2);
    expect(m.sondear(DIR)).toBe(true);
  });

  it('chip_id 0x60 y los valores de reset de la tabla 18', () => {
    const m = nuevo();
    expect(r8(m, 0xd0)).toBe(0x60);
    expect(r8(m, 0xe0)).toBe(0x00); // reset se lee siempre 0
    expect(r8(m, 0xf2)).toBe(0x00);
    expect(r8(m, 0xf3)).toBe(0x00);
    expect(r8(m, 0xf4)).toBe(0x00);
    expect(r8(m, 0xf5)).toBe(0x00);
    expect(m.leerRegistros(DIR, 0xf7, 8)).toEqual([0x80, 0, 0, 0x80, 0, 0, 0x80, 0]);
  });

  it('la calibración leída como Adafruit (H4/H5 de a medio byte) reproduce los coeficientes', () => {
    expect(calibracion(nuevo())).toEqual({
      T1: 27504, T2: 26435, T3: -1000, P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7,
      P7: 15500, P8: -14600, P9: 6000, H1: 75, H2: 362, H3: 0, H4: 313, H5: 50, H6: 30,
    });
  });

  it('escribir es de a pares registro/dato en una sola transacción, sin autoincremento', () => {
    const m = nuevo();
    expect(m.escribir(DIR, [0xf2, 0x03, 0xf5, 0x10, 0xf4, 0x6c])).toBe(true);
    expect(r8(m, 0xf2)).toBe(0x03);
    expect(r8(m, 0xf5)).toBe(0x10);
    expect(r8(m, 0xf4)).toBe(0x6c);
  });

  it('los registros de solo lectura no se pueden escribir', () => {
    const m = nuevo();
    w8(m, 0xd0, 0x12);
    w8(m, 0x88, 0x00);
    expect(r8(m, 0xd0)).toBe(0x60);
    expect(r8(m, 0x88)).toBe(27504 & 0xff);
  });

  it('reset con 0xB6: vuelve a los valores de reset y no contesta durante el arranque', () => {
    const m = nuevo();
    w8(m, 0xf5, 0xa0);
    forzada(m);
    expect(m.escribir(DIR, [0xe0, 0xb6])).toBe(true);
    expect(m.sondear(DIR)).toBe(false);
    m.esperar(2.1);
    expect(r8(m, 0xf5)).toBe(0x00);
    expect(m.leerRegistros(DIR, 0xfa, 3)).toEqual([0x80, 0, 0]);
  });

  it('otro valor en el registro de reset no hace nada', () => {
    const m = nuevo();
    w8(m, 0xf5, 0xa0);
    w8(m, 0xe0, 0xb5);
    expect(r8(m, 0xf5)).toBe(0xa0);
  });
});

describe('BME280: mediciones contra el entorno', () => {
  it('modo forzado: lo que lee el firmware coincide con el entorno (dentro del ruido)', () => {
    const m = nuevo({ entorno: { temperatura: 22.5, humedad: 55, presion: 1013.25 } });
    const r = forzada(m);
    expect(r.T).toBeCloseTo(22.5, 1);
    expect(r.P).toBeCloseTo(1013.25, 0);
    expect(Math.abs(r.H - 55)).toBeLessThan(0.3);
  });

  it('en todo el rango de la hoja: -40..85 °C, 300..1100 hPa, 0..100 %HR', () => {
    for (const [t, p, h] of [[-40, 300, 0], [-10, 700, 20], [0, 950, 50], [25, 1013.25, 80], [60, 1100, 100], [85, 1050, 10]] as const) {
      const m = nuevo({ entorno: { temperatura: t, presion: p, humedad: h } });
      const r = forzada(m, { t: 5, p: 5, h: 5 }, 120); // código 5 = x16
      expect(Math.abs(r.T - t), `T a ${t} °C`).toBeLessThan(0.02);
      expect(Math.abs(r.P - p), `P a ${p} hPa`).toBeLessThan(0.05);
      expect(Math.abs(r.H - h), `H a ${h} %HR`).toBeLessThan(0.2);
    }
  });

  it('measuring vale 1 durante t_measure (típico de 9.1) y después el modo vuelve a dormido', () => {
    const m = nuevo();
    w8(m, 0xf2, 1);
    w8(m, 0xf4, (1 << 5) | (1 << 2) | 1); // x1/x1/x1: 1 + 2 + 2,5 + 2,5 = 8 ms
    expect(r8(m, 0xf3) & 0x08).toBe(0x08);
    expect(r8(m, 0xf4) & 3).toBe(1);
    m.esperar(7.9);
    expect(r8(m, 0xf3) & 0x08).toBe(0x08);
    m.esperar(0.2);
    expect(r8(m, 0xf3) & 0x08).toBe(0);
    expect(r8(m, 0xf4) & 3).toBe(0);
  });

  it('t_measure con x16 en los tres canales: 1 + 32 + 32,5 + 32,5 = 98 ms', () => {
    const m = nuevo();
    w8(m, 0xf2, 5);
    w8(m, 0xf4, (5 << 5) | (5 << 2) | 1);
    m.esperar(97.9);
    expect(r8(m, 0xf3) & 0x08).toBe(0x08);
    m.esperar(0.2);
    expect(r8(m, 0xf3) & 0x08).toBe(0);
  });

  it('los datos no cambian hasta que termina la medición (se lee el valor viejo)', () => {
    const m = nuevo({ entorno: { temperatura: 20 } });
    const antes = forzada(m);
    m.bus.ponerEntorno('bme', { temperatura: 30 });
    w8(m, 0xf4, (1 << 5) | (1 << 2) | 1);
    m.esperar(4);
    expect(medida(m).T).toBeCloseTo(antes.T, 5);
    m.esperar(5);
    expect(medida(m).T).toBeCloseTo(30, 1);
  });

  it('ctrl_hum solo se aplica al escribir ctrl_meas (5.4.3)', () => {
    const m = nuevo();
    w8(m, 0xf4, (1 << 5) | (1 << 2) | 1); // humedad salteada (ctrl_hum = 0)
    m.esperar(20);
    w8(m, 0xf2, 1); // se escribe ctrl_hum pero no ctrl_meas
    m.esperar(20);
    expect(medida(m).adcH).toBe(0x8000);
    w8(m, 0xf4, (1 << 5) | (1 << 2) | 1);
    m.esperar(20);
    expect(medida(m).adcH).not.toBe(0x8000);
  });

  it('un canal salteado da 0x80000 (0x8000 la humedad)', () => {
    const m = nuevo();
    w8(m, 0xf2, 0);
    w8(m, 0xf4, (1 << 5) | (0 << 2) | 1); // presión salteada
    m.esperar(20);
    const r = medida(m);
    expect(r.adcP).toBe(0x80000);
    expect(r.adcH).toBe(0x8000);
    expect(r.adcT).not.toBe(0x80000);
  });

  it('resolución sin filtro: 16 + (osrs − 1) bits; con filtro, 20 bits (3.4.2)', () => {
    for (let i = 1; i <= 5; i++) {
      const m = nuevo({ entorno: { temperatura: 23.456 } });
      const r = forzada(m, { t: i, p: i, h: 1 }, 120);
      const bits = 16 + Math.min(i, 5) - 1;
      expect(r.adcT % (1 << (20 - bits)), `osrs ${i}`).toBe(0);
    }
    // Con filtro, aparecen los bits bajos (en algún momento: probamos varias mediciones).
    const m = nuevo();
    w8(m, 0xf5, 4 << 2);
    let bajos = 0;
    for (let k = 0; k < 10; k++) bajos |= forzada(m, { t: 1, p: 1, h: 1 }).adcT & 0x0f;
    expect(bajos).not.toBe(0);
  });

  it('filtro IIR: muestras para llegar al 75 % de un escalón, como la tabla 6 (1, 2, 5, 11, 22)', () => {
    const esperado: Record<number, number> = { 0: 1, 1: 2, 2: 5, 3: 11, 4: 22 };
    for (const [filtro, n] of Object.entries(esperado)) {
      const m = nuevo({ entorno: { temperatura: 20 } });
      w8(m, 0xf5, Number(filtro) << 2);
      forzada(m, { t: 1, p: 1, h: 0 });
      const a = medida(m).adcT;
      m.bus.ponerEntorno('bme', { temperatura: 40 });
      let muestras = 0;
      let ultimo = a;
      const objetivo = forzada(nuevo({ entorno: { temperatura: 40 } }), { t: 1, p: 1, h: 0 }).adcT;
      while (muestras < 100) {
        muestras++;
        ultimo = forzada(m, { t: 1, p: 1, h: 0 }).adcT;
        // Con coeficiente 2, dos muestras dan exactamente 75 % (1 − 0,5²): el redondeo y el ruido
        // pueden dejarlo en 74,9 %, así que se toma 74,5 % como "llegó".
        if ((ultimo - a) / (objetivo - a) >= 0.745) break;
      }
      expect(muestras, `filtro ${filtro}`).toBe(n);
    }
  });

  it('escribir el filtro lo reinicia: la siguiente medición pasa sin filtrar', () => {
    const m = nuevo({ entorno: { temperatura: 20 } });
    w8(m, 0xf5, 4 << 2);
    forzada(m);
    m.bus.ponerEntorno('bme', { temperatura: 40 });
    w8(m, 0xf5, 3 << 2); // otro coeficiente: reinicia
    expect(forzada(m).T).toBeCloseTo(40, 1);
  });

  it('ruido de presión sin filtro a x1 ≈ 3,3 Pa RMS (tabla 12), y el filtro 16 lo baja mucho', () => {
    const rms = (filtro: number) => {
      const m = nuevo({ entorno: { presion: 1000 } });
      w8(m, 0xf5, filtro << 2);
      const xs: number[] = [];
      for (let k = 0; k < 400; k++) xs.push(forzada(m, { t: 1, p: 1, h: 0 }).P * 100);
      const util = xs.slice(50);
      const media = util.reduce((a, b) => a + b, 0) / util.length;
      return Math.sqrt(util.reduce((a, b) => a + (b - media) ** 2, 0) / util.length);
    };
    const sinFiltro = rms(0);
    expect(sinFiltro).toBeGreaterThan(2.3);
    expect(sinFiltro).toBeLessThan(4.5);
    const conFiltro = rms(4);
    expect(conFiltro).toBeLessThan(sinFiltro / 3); // la tabla da 0,4 Pa
  });
});

describe('BME280: modo normal y transiciones', () => {
  it('modo normal: mide cada t_measure + t_standby (62,5 ms) y measuring marca cada ciclo', () => {
    const m = nuevo();
    w8(m, 0xf5, 1 << 5); // t_sb = 62,5 ms
    w8(m, 0xf2, 1);
    w8(m, 0xf4, (1 << 5) | (1 << 2) | 3); // normal, t_measure 8 ms → período 70,5 ms
    expect(r8(m, 0xf3) & 0x08).toBe(0x08); // el primer ciclo arranca enseguida
    m.esperar(8.1);
    expect(r8(m, 0xf3) & 0x08).toBe(0);
    m.esperar(70.5 - 8.1 + 0.1); // empieza el segundo ciclo
    expect(r8(m, 0xf3) & 0x08).toBe(0x08);
    expect(r8(m, 0xf4) & 3).toBe(3); // sigue en normal
  });

  it('en modo normal, escribir config se ignora (5.4.6)', () => {
    const m = nuevo();
    w8(m, 0xf4, (1 << 5) | (1 << 2) | 3);
    w8(m, 0xf5, 0xa0);
    expect(r8(m, 0xf5)).toBe(0x00);
    w8(m, 0xf4, 0); // a dormir
    m.esperar(20);
    w8(m, 0xf5, 0xa0);
    expect(r8(m, 0xf5)).toBe(0xa0);
  });

  it('cambiar el modo durante una medición espera a que termine (3.3.1)', () => {
    const m = nuevo();
    w8(m, 0xf4, (5 << 5) | (5 << 2) | 1); // forzado x16: 66,5 ms (humedad salteada)
    m.esperar(10);
    w8(m, 0xf4, (1 << 5) | (1 << 2) | 3); // pide normal en el medio
    expect(r8(m, 0xf4) & 3).toBe(1);
    m.esperar(60);
    expect(r8(m, 0xf4) & 3).toBe(3);
  });

  it('el entorno nuevo se ve en modo normal después de un ciclo', () => {
    const m = nuevo({ entorno: { temperatura: 10 } });
    w8(m, 0xf2, 1);
    w8(m, 0xf4, (1 << 5) | (1 << 2) | 3);
    m.esperar(30);
    expect(medida(m).T).toBeCloseTo(10, 1);
    m.bus.ponerEntorno('bme', { temperatura: 35 });
    m.esperar(30);
    expect(medida(m).T).toBeCloseTo(35, 1);
  });
});
