import { describe, expect, it } from 'vitest';
import { cargarChips } from './catalogoChips.js';
import { MaestroVirtual } from './maestroVirtual.js';

/** Maxim DS3231 (chips/maxim-ds3231) contra su hoja de datos, con un maestro I2C virtual. */

const chip = cargarChips().find((c) => c.id === 'maxim-ds3231')!;
const DIR = 0x68;
const bcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const dec = (b: number) => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);

function nuevo(props: Record<string, unknown> = { inicio: '2026-10-01T12:00:00' }, entorno?: Record<string, number>) {
  const m = new MaestroVirtual();
  m.conectar(chip, { id: 'rtc', props, entorno });
  return m;
}
const r8 = (m: MaestroVirtual, reg: number) => m.leerRegistros(DIR, reg, 1)![0]!;
const w = (m: MaestroVirtual, reg: number, ...v: number[]) => expect(m.escribir(DIR, [reg, ...v])).toBe(true);
/** Hora como la arma RTClib.now(): 7 bytes desde 00h. */
function hora(m: MaestroVirtual) {
  const b = m.leerRegistros(DIR, 0, 7)!;
  return { s: dec(b[0]! & 0x7f), m: dec(b[1]!), h: dec(b[2]! & 0x3f), dow: b[3]!, d: dec(b[4]!), mes: dec(b[5]! & 0x1f), siglo: b[5]! >> 7, a: dec(b[6]!), crudo: b };
}
const temp = (m: MaestroVirtual) => { const [hi, lo] = m.leerRegistros(DIR, 0x11, 2)!; return (((hi! << 8) | lo!) << 16 >> 16) / 256; };

describe('DS3231: registros al encender', () => {
  it('contesta solo en 0x68', () => {
    const m = nuevo();
    expect(m.sondear(0x68)).toBe(true);
    expect(m.sondear(0x57)).toBe(false);
  });

  it('control 1Ch y estado con EN32kHz = 1; OSF = 0 si tiene pila y hora, 1 en el primer encendido', () => {
    const m = nuevo();
    m.esperar(200);
    expect(r8(m, 0x0e)).toBe(0x1c);
    expect(r8(m, 0x0f)).toBe(0x08);
    const p = nuevo({ estado: 'sin-pila' });
    m.esperar(200);
    p.esperar(200);
    expect(r8(p, 0x0f)).toBe(0x88);
    expect(hora(p)).toMatchObject({ s: 0, m: 0, h: 0, d: 1, mes: 1, a: 0 });
  });

  it('temperatura en 0 °C hasta que termina la primera conversión (125 ms), con BSY mientras tanto', () => {
    const m = nuevo(undefined, { temperatura: 27.3 });
    m.esperar(60);
    expect(temp(m)).toBe(0);
    expect(r8(m, 0x0f) & 0x04).toBe(0x04);
    m.esperar(70);
    expect(temp(m)).toBe(27.25); // redondeado a 0,25 °C
    expect(r8(m, 0x0f) & 0x04).toBe(0);
  });
});

describe('DS3231: la hora', () => {
  it('arranca en la hora pedida y corre con el tiempo de la emulación', () => {
    const m = nuevo();
    expect(hora(m)).toMatchObject({ s: 0, m: 0, h: 12, d: 1, mes: 10, a: 26, dow: 4 }); // 1/10/2026 es jueves
    m.esperar(2500);
    expect(hora(m).s).toBe(2);
    m.esperar(3600_000);
    expect(hora(m)).toMatchObject({ s: 2, m: 0, h: 13 });
  });

  it('escribir los segundos reinicia la cuenta: el próximo segundo llega 1 s después de la escritura', () => {
    const m = nuevo();
    m.esperar(700);
    w(m, 0x00, bcd(30));
    m.esperar(999);
    expect(hora(m).s).toBe(30);
    m.esperar(2);
    expect(hora(m).s).toBe(31);
  });

  it('fin de año 99 → 00 cambia el bit de siglo; febrero bisiesto (2024) y no bisiesto (2023)', () => {
    const m = nuevo({ inicio: '2099-12-31T23:59:59' });
    m.esperar(1000);
    expect(hora(m)).toMatchObject({ a: 0, mes: 1, d: 1, h: 0, m: 0, s: 0, siglo: 1 });
    const b = nuevo({ inicio: '2024-02-28T23:59:59' });
    b.esperar(1000);
    expect(hora(b)).toMatchObject({ mes: 2, d: 29 });
    const c = nuevo({ inicio: '2023-02-28T23:59:59' });
    c.esperar(1000);
    expect(hora(c)).toMatchObject({ mes: 3, d: 1 });
  });

  it('como dice la hoja, toma 2100 como bisiesto (la compensación vale hasta 2100)', () => {
    const m = nuevo({ inicio: '2100-02-28T23:59:59' });
    m.esperar(1000);
    expect(hora(m)).toMatchObject({ mes: 2, d: 29, siglo: 1 });
  });

  it('el día de la semana sube a medianoche y es independiente de la fecha (lo fija el usuario)', () => {
    const m = nuevo({ inicio: '2026-10-01T23:59:58' });
    w(m, 0x03, 7);
    m.esperar(3000);
    expect(hora(m).dow).toBe(1); // 7 → 1 al pasar la medianoche
  });

  it('modo 12 h: 11 PM pasa a 12 AM; y se lee con el bit de AM/PM', () => {
    const m = nuevo({ inicio: '2026-10-01T22:00:00' });
    w(m, 0x02, 0x40 | 0x20 | bcd(11)); // 11 PM
    m.esperar(3600_000);
    expect(r8(m, 0x02)).toBe(0x40 | bcd(12)); // 12 AM
    w(m, 0x02, bcd(15)); // vuelve a 24 h
    expect(r8(m, 0x02)).toBe(bcd(15));
  });

  it('el puntero vuelve a 00h después de 12h en una lectura en ráfaga', () => {
    const m = nuevo();
    m.esperar(200);
    const b = m.leerRegistros(DIR, 0x10, 5)!;
    expect(b[3]).toBe(hora(m).crudo[0]);
    expect(b[4]).toBe(bcd(0)); // minutos
  });

  it('error de frecuencia y aging: +10 en aging (−1 ppm) atrasa 0,1 s cada 100 000 s', () => {
    const base = nuevo({ inicio: '2026-10-01T00:00:00' });
    const lento = nuevo({ inicio: '2026-10-01T00:00:00' });
    w(lento, 0x10, 10);
    // 100 000 s + 0,05 s: el que tiene aging todavía no llegó al segundo 100 000.
    base.esperar(100_000_050);
    lento.esperar(100_000_050);
    const s = (m: MaestroVirtual) => { const h = hora(m); return h.h * 3600 + h.m * 60 + h.s + (h.d - 1) * 86400; };
    expect(s(base)).toBe(100_000);
    expect(s(lento)).toBe(99_999);
  });
});

describe('DS3231: temperatura', () => {
  it('negativos en complemento a dos con 0,25 °C (−10,25 °C → F5h C0h: −11 + 0,75)', () => {
    const m = nuevo(undefined, { temperatura: -10.25 });
    m.esperar(200);
    expect(m.leerRegistros(DIR, 0x11, 2)).toEqual([0xf5, 0xc0]);
  });

  it('un cambio de entorno se ve recién en la próxima conversión automática (cada 64 s)', () => {
    const m = nuevo(undefined, { temperatura: 20 });
    m.esperar(200);
    m.bus.ponerEntorno('rtc', { temperatura: 30 });
    m.esperar(60_000);
    expect(temp(m)).toBe(20);
    m.esperar(4_000);
    expect(temp(m)).toBe(30);
  });

  it('CONV fuerza una conversión: CONV queda en 1 hasta que termina (125 ms) y BSY se prende a los ~2 ms', () => {
    const m = nuevo(undefined, { temperatura: 20 });
    m.esperar(300);
    m.bus.ponerEntorno('rtc', { temperatura: 33.5 });
    w(m, 0x0e, 0x1c | 0x20);
    expect(r8(m, 0x0e) & 0x20).toBe(0x20);
    m.esperar(5);
    expect(r8(m, 0x0f) & 0x04).toBe(0x04);
    expect(temp(m)).toBe(20);
    m.esperar(125);
    expect(r8(m, 0x0e) & 0x20).toBe(0);
    expect(r8(m, 0x0f) & 0x04).toBe(0);
    expect(temp(m)).toBe(33.5);
  });

  it('CONV no se puede poner mientras BSY = 1 (durante una conversión automática)', () => {
    const m = nuevo(undefined, { temperatura: 20 });
    m.esperar(50); // la conversión del encendido sigue
    w(m, 0x0e, 0x1c | 0x20);
    expect(r8(m, 0x0e) & 0x20).toBe(0);
  });
});

describe('DS3231: alarmas e INT/SQW', () => {
  it('alarma 1 una vez por segundo (A1M4..1 = 1111): A1F se prende y, con A1IE e INTCN, INT baja', () => {
    const m = nuevo();
    w(m, 0x07, 0x80, 0x80, 0x80, 0x80);
    w(m, 0x0e, 0x1c | 0x01);
    expect(m.pines.get('rtc.INT/SQW') ?? null).toBeNull();
    m.esperar(1001);
    expect(r8(m, 0x0f) & 0x01).toBe(1);
    expect(m.pines.get('rtc.INT/SQW')).toBe(0);
    // Borrar el flag suelta INT.
    w(m, 0x0f, 0x08);
    expect(m.pines.get('rtc.INT/SQW')).toBeNull();
  });

  it('INT baja justo en el cambio de segundo (no cuando el programa lee)', () => {
    const m = nuevo();
    w(m, 0x07, bcd(5), 0x80, 0x80, 0x80); // cuando los segundos sean 05
    w(m, 0x0e, 0x1c | 0x01);
    m.esperar(10_000);
    const bajada = m.historialPines.find((h) => h.pin === 'rtc.INT/SQW' && h.nivel === 0)!;
    expect(bajada.t / 1e6).toBeCloseTo(5, 2);
  });

  it('los flags se prenden aunque la interrupción esté deshabilitada (y entonces INT no baja)', () => {
    const m = nuevo();
    w(m, 0x07, 0x80, 0x80, 0x80, 0x80);
    m.esperar(1500);
    expect(r8(m, 0x0f) & 0x01).toBe(1);
    expect(m.pines.get('rtc.INT/SQW') ?? null).toBeNull();
  });

  it('alarma 1 con hora, minutos, segundos y día de la semana (DY/DT = 1), en formato 12 h', () => {
    const m = nuevo({ inicio: '2026-10-01T13:59:58' }); // jueves = 4
    w(m, 0x03, 4);
    w(m, 0x07, bcd(0), bcd(0), 0x40 | 0x20 | bcd(2), 0x40 | 4); // 2:00:00 PM del día 4
    m.esperar(1500);
    expect(r8(m, 0x0f) & 1).toBe(0);
    m.esperar(1000);
    expect(r8(m, 0x0f) & 1).toBe(1);
  });

  it('alarma 1 por fecha (DY/DT = 0): no dispara otro día a la misma hora', () => {
    const m = nuevo({ inicio: '2026-10-01T07:59:59' });
    w(m, 0x07, bcd(0), bcd(0), bcd(8), bcd(2)); // el día 2 a las 08:00:00
    m.esperar(2000);
    expect(r8(m, 0x0f) & 1).toBe(0);
    m.esperar(86_400_000);
    expect(r8(m, 0x0f) & 1).toBe(1);
  });

  it('alarma 2 una vez por minuto (111): dispara en el segundo 00', () => {
    const m = nuevo({ inicio: '2026-10-01T12:00:30' });
    w(m, 0x0b, 0x80, 0x80, 0x80);
    w(m, 0x0e, 0x1c | 0x02);
    m.esperar(29_000);
    expect(r8(m, 0x0f) & 2).toBe(0);
    m.esperar(2_000);
    expect(r8(m, 0x0f) & 2).toBe(2);
    expect(m.pines.get('rtc.INT/SQW')).toBe(0);
  });

  it('A1F/A2F y OSF solo se pueden escribir en 0', () => {
    const m = nuevo({ estado: 'sin-pila' });
    m.esperar(200);
    w(m, 0x0f, 0x8b);
    expect(r8(m, 0x0f)).toBe(0x88);
    w(m, 0x0f, 0x08);
    expect(r8(m, 0x0f)).toBe(0x08);
  });

  it('INTCN = 0 y RS = 00: onda cuadrada de 1 Hz (baja en el cambio de segundo, sube a los 500 ms)', () => {
    const m = nuevo();
    w(m, 0x0e, 0x00);
    m.esperar(3000);
    const cambios = m.historialPines.filter((h) => h.pin === 'rtc.INT/SQW').map((h) => [Math.round(h.t / 1000), h.nivel]);
    expect(cambios).toContainEqual([1000, 0]);
    expect(cambios).toContainEqual([1500, null]);
    expect(cambios).toContainEqual([2000, 0]);
    expect(cambios).toContainEqual([2500, null]);
  });

  it('frecuencias de onda cuadrada que no se emulan: se avisa y el pin queda suelto', () => {
    const m = nuevo();
    w(m, 0x0e, 0x18);
    expect(m.logs.some((l) => /más de 1 Hz no emulada/.test(l))).toBe(true);
    expect(m.pines.get('rtc.INT/SQW') ?? null).toBeNull();
  });
});

describe('DS3231: robustez', () => {
  it('un hueco de 2 días sin leer el chip no lo traba (la revisión de alarmas mira solo candidatos)', () => {
    const m = nuevo({ inicio: '2026-10-01T00:00:00' });
    w(m, 0x07, bcd(30), bcd(15), bcd(9), bcd(2)); // el 2 a las 09:15:30
    m.esperar(2 * 86_400_000);
    const t0 = performance.now();
    expect(r8(m, 0x0f) & 1).toBe(1);
    expect(performance.now() - t0).toBeLessThan(40);
    expect(m.logs.join()).not.toMatch(/dejó de responder/);
  });
});

describe('AT24C32 (EEPROM de la ZS-042)', () => {
  const eeprom = cargarChips().find((c) => c.id === 'atmel-at24c32')!;
  function nueva(direccion = '0x57') {
    const m = new MaestroVirtual();
    m.conectar(eeprom, { id: 'ee', props: { direccion } });
    return m;
  }

  it('dirección 0x50 + A2A1A0 (la ZS-042 los tiene en 1: 0x57), y viene llena de 0xFF', () => {
    const m = nueva();
    expect(m.sondear(0x57)).toBe(true);
    expect(m.sondear(0x50)).toBe(false);
    expect(m.leerRegistros(0x57, [0x0f, 0xa0], 4)).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it('escribe una página y durante t_WR (5 ms) no contesta: acknowledge polling', () => {
    const m = nueva();
    expect(m.escribir(0x57, [0x01, 0x00, 1, 2, 3, 4])).toBe(true);
    expect(m.sondear(0x57)).toBe(false);
    m.esperar(4.9);
    expect(m.sondear(0x57)).toBe(false);
    m.esperar(0.2);
    expect(m.sondear(0x57)).toBe(true);
    expect(m.leerRegistros(0x57, [0x01, 0x00], 5)).toEqual([1, 2, 3, 4, 0xff]);
  });

  it('pasarse de la página vuelve al principio de la MISMA página (pisa lo primero)', () => {
    const m = nueva();
    m.escribir(0x57, [0x00, 0x1e, 0xa, 0xb, 0xc, 0xd]); // 1Eh, 1Fh, y vuelve a 00h, 01h
    m.esperar(6);
    expect(m.leerRegistros(0x57, [0x00, 0x1e], 2)).toEqual([0xa, 0xb]);
    expect(m.leerRegistros(0x57, [0x00, 0x00], 2)).toEqual([0xc, 0xd]);
    expect(m.leerRegistros(0x57, [0x00, 0x20], 1)).toEqual([0xff]); // la página siguiente, intacta
  });

  it('lectura secuencial que pasa del final vuelve a 0; y "dirección actual" sigue donde quedó', () => {
    const m = nueva();
    m.escribir(0x57, [0x00, 0x00, 0x42]);
    m.esperar(6);
    expect(m.leerRegistros(0x57, [0x0f, 0xff], 2)).toEqual([0xff, 0x42]); // FFFh y vuelve a 000h
    expect(m.leer(0x57, 1)).toEqual([0xff]); // dirección actual: 001h
  });

  it('se usan 12 bits de dirección: 1000h es la misma celda que 0000h', () => {
    const m = nueva();
    m.escribir(0x57, [0x10, 0x00, 0x99]);
    m.esperar(6);
    expect(m.leerRegistros(0x57, [0x00, 0x00], 1)).toEqual([0x99]);
  });
});
