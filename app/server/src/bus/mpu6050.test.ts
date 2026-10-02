import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AvrSimulador } from '../avrSim.js';
import { armarBusChips } from './armarBus.js';
import { cargarChips } from './catalogoChips.js';
import { MaestroVirtual } from './maestroVirtual.js';
import { entornoDe, type ChipEnBus } from './proyectoChips.js';

/** InvenSense MPU-6050 (chips/invensense-mpu6050) contra RM-MPU-6000A rev 4.0 y PS-MPU-6000A rev 3.1. */

const chip = cargarChips().find((c) => c.id === 'invensense-mpu6050')!;
const DIR = 0x68;
const s16 = (h: number, l: number) => ((h << 8) | l) << 16 >> 16;

function nuevo(props: Record<string, unknown> = { errores: 'ninguno' }, entorno?: Record<string, number>) {
  const m = new MaestroVirtual();
  m.conectar(chip, { id: 'imu', props, entorno });
  m.esperar(25); // start-up time for register read/write: 20 ms
  return m;
}
const r8 = (m: MaestroVirtual, reg: number) => m.leerRegistros(DIR, reg, 1)![0]!;
const w = (m: MaestroVirtual, reg: number, ...v: number[]) => expect(m.escribir(DIR, [reg, ...v])).toBe(true);
function datos(m: MaestroVirtual) {
  const b = m.leerRegistros(DIR, 0x3b, 14)!;
  return { ax: s16(b[0]!, b[1]!), ay: s16(b[2]!, b[3]!), az: s16(b[4]!, b[5]!), temp: s16(b[6]!, b[7]!), gx: s16(b[8]!, b[9]!), gy: s16(b[10]!, b[11]!), gz: s16(b[12]!, b[13]!) };
}

describe('MPU-6050: arranque y registros', () => {
  it('no contesta los primeros 20 ms (start-up time) y después sí, en 0x68 (AD0 bajo) o 0x69', () => {
    const m = new MaestroVirtual();
    m.conectar(chip, { id: 'imu', props: {} });
    m.esperar(19);
    expect(m.sondear(0x68)).toBe(false);
    m.esperar(2);
    expect(m.sondear(0x68)).toBe(true);
    expect(nuevo({ ad0: 'alto' }).sondear(0x69)).toBe(true);
  });

  it('WHO_AM_I = 68h (también con AD0 alto) y PWR_MGMT_1 = 40h: arranca dormido', () => {
    expect(r8(nuevo(), 0x75)).toBe(0x68);
    expect(nuevo({ ad0: 'alto' }).leerRegistros(0x69, 0x75, 1)).toEqual([0x68]);
    expect(r8(nuevo(), 0x6b)).toBe(0x40);
  });

  it('dormido, los datos quedan en 0 aunque el sensor esté inclinado', () => {
    const m = nuevo(undefined, { aceleracionX: 0.5 });
    m.esperar(50);
    expect(datos(m)).toEqual({ ax: 0, ay: 0, az: 0, temp: 0, gx: 0, gy: 0, gz: 0 });
  });

  it('DEVICE_RESET vuelve todo a los valores de reset y el bit se borra solo', () => {
    const m = nuevo();
    w(m, 0x1c, 0x18);
    w(m, 0x6b, 0x80);
    expect(r8(m, 0x6b)).toBe(0x40);
    expect(r8(m, 0x1c)).toBe(0x00);
  });
});

describe('MPU-6050: mediciones', () => {
  it('despierto: 1 g en Z son 16384 LSB a ±2 g, y la temperatura es T = cuenta/340 + 36,53', () => {
    const m = nuevo(undefined, { temperatura: 30 });
    w(m, 0x6b, 0x01);
    m.esperar(10);
    const d = datos(m);
    // Ruido a 260 Hz: 400 µg/√Hz × √260 = 6,45 mg rms = 106 LSB a ±2 g: se pide menos de 4σ.
    expect(Math.abs(d.az - 16384)).toBeLessThan(425);
    expect(Math.abs(d.ax)).toBeLessThan(425);
    expect(d.temp / 340 + 36.53).toBeCloseTo(30, 1);
  });

  it('escalas: ±2/4/8/16 g = 16384/8192/4096/2048 LSB/g y ±250/500/1000/2000 °/s = 131/65,5/32,8/16,4', () => {
    for (let fs = 0; fs < 4; fs++) {
      const m = nuevo(undefined, { aceleracionZ: 1, giroX: 100 });
      w(m, 0x1c, fs << 3);
      w(m, 0x1b, fs << 3);
      w(m, 0x1a, 6); // DLPF de 5 Hz: casi sin ruido
      w(m, 0x6b, 0x01);
      m.esperar(400);
      const d = datos(m);
      expect(d.az / [16384, 8192, 4096, 2048][fs]!).toBeCloseTo(1, 2);
      expect(d.gx / [131, 65.5, 32.8, 16.4][fs]!).toBeCloseTo(100, 0);
    }
  });

  it('satura en ±32767: 3 g con escala de ±2 g', () => {
    const m = nuevo(undefined, { aceleracionZ: 3 });
    w(m, 0x6b, 0x01);
    m.esperar(10);
    expect(datos(m).az).toBe(32767);
  });

  it('los errores típicos de fábrica: el giróscopo quieto no marca 0 (ZRO hasta ±20 °/s) y son repetibles', () => {
    const a = nuevo({ errores: 'tipicos', semilla: 7 }, { giroX: 0 });
    const b = nuevo({ errores: 'tipicos', semilla: 7 }, { giroX: 0 });
    for (const m of [a, b]) { w(m, 0x1a, 6); w(m, 0x6b, 0x01); m.esperar(400); }
    const gx = datos(a).gx / 131;
    expect(Math.abs(gx)).toBeGreaterThan(0.2);
    expect(Math.abs(gx)).toBeLessThanOrEqual(20.5);
    expect(Math.abs(datos(b).gx / 131 - gx)).toBeLessThan(0.1);
  });

  it('ruido del giróscopo con DLPF de 98 Hz ≈ 0,05 °/s rms (hoja: Total RMS Noise, DLPFCFG = 2)', () => {
    const m = nuevo();
    w(m, 0x1a, 2);
    w(m, 0x6b, 0x01);
    m.esperar(50);
    const xs: number[] = [];
    for (let i = 0; i < 300; i++) { m.esperar(5); xs.push(datos(m).gx / 131); }
    const media = xs.reduce((a, b) => a + b, 0) / xs.length;
    const rms = Math.sqrt(xs.reduce((a, b) => a + (b - media) ** 2, 0) / xs.length);
    expect(rms).toBeGreaterThan(0.025);
    expect(rms).toBeLessThan(0.08);
  });

  it('el filtro (DLPF) demora un escalón: con 5 Hz llega al 63 % en ~32 ms (τ = 1/2π·5 Hz)', () => {
    const m = nuevo(undefined, { giroZ: 0 });
    w(m, 0x1a, 6);
    w(m, 0x6b, 0x01);
    m.esperar(100);
    m.bus.ponerEntorno('imu', { giroZ: 200 });
    m.esperar(10);
    expect(datos(m).gz / 131).toBeLessThan(100);
    m.esperar(22);
    expect(datos(m).gz / 131).toBeGreaterThan(110);
    expect(datos(m).gz / 131).toBeLessThan(150);
    m.esperar(300);
    expect(datos(m).gz / 131).toBeCloseTo(200, 0);
  });
});

describe('MPU-6050: muestreo e interrupción de dato listo', () => {
  it('frecuencia de muestreo = 1 kHz / (1 + SMPLRT_DIV) con DLPF: DATA_RDY se prende con cada muestra y se borra al leer INT_STATUS', () => {
    const m = nuevo();
    w(m, 0x1a, 3);
    w(m, 0x19, 9); // 100 Hz
    w(m, 0x6b, 0x01);
    m.esperar(5);
    expect(r8(m, 0x3a) & 1).toBe(1); // la primera muestra, al despertar
    expect(r8(m, 0x3a) & 1).toBe(0); // leerlo la borra
    m.esperar(4); // 9 ms desde que despertó
    expect(r8(m, 0x3a) & 1).toBe(0);
    m.esperar(2); // 11 ms: ya pasó la muestra de los 10 ms
    expect(r8(m, 0x3a) & 1).toBe(1);
  });

  it('INT: pulso de 50 µs activo en alto por cada muestra (100 Hz)', () => {
    const m = nuevo();
    w(m, 0x1a, 3);
    w(m, 0x19, 9);
    w(m, 0x38, 0x01);
    w(m, 0x6b, 0x01);
    m.esperar(35);
    const subidas = m.historialPines.filter((h) => h.pin === 'imu.INT' && h.nivel === 1).map((h) => h.t);
    expect(subidas.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < subidas.length; i++) expect((subidas[i]! - subidas[i - 1]!) / 1000).toBeCloseTo(10, 1);
    const bajada = m.historialPines.find((h) => h.pin === 'imu.INT' && h.nivel === 0 && h.t > subidas[1]!)!;
    expect(bajada.t - subidas[1]!).toBeCloseTo(50, -1);
  });

  it('INT enganchada (LATCH_INT_EN) y activa en bajo de colector abierto: queda en 0 hasta leer INT_STATUS', () => {
    const m = nuevo();
    w(m, 0x1a, 3);
    w(m, 0x19, 9);
    w(m, 0x37, 0x80 | 0x40 | 0x20); // activa en bajo, open drain, latch
    w(m, 0x38, 0x01);
    w(m, 0x6b, 0x01);
    m.esperar(3);
    expect(m.pines.get('imu.INT')).toBe(0);
    m.esperar(3);
    expect(m.pines.get('imu.INT')).toBe(0);
    r8(m, 0x3a);
    expect(m.pines.get('imu.INT') ?? null).toBeNull(); // suelta: el 1 lo pone el pull-up
  });

  it('a 8 kHz (sin DLPF) no se emula el pin INT y se avisa', () => {
    const m = nuevo();
    w(m, 0x38, 0x01);
    w(m, 0x6b, 0x01);
    m.esperar(2);
    expect(m.logs.some((l) => /más de 1 kHz/.test(l))).toBe(true);
  });
});

describe('MPU-6050 con Adafruit_MPU6050 2.2.9 (firmware real)', () => {
  it('begin() lo encuentra y lo despierta; las lecturas en m/s² y rad/s siguen al entorno', () => {
    const serial: number[] = [];
    const sim = new AvrSimulador(readFileSync(new URL('../fixtures/chips/mpu6050-lectura/mpu6050-lectura.hex', import.meta.url), 'utf8'), {
      onSerial: (b) => serial.push(b), onPin: () => undefined,
    });
    const c: ChipEnBus = { id: 'imu', instancia: 'imu', chip: chip.id, nombre: 'MPU-6050', codigo: chip.codigo, props: { errores: 'ninguno' },
      entorno: { ...entornoDe(chip), aceleracionX: 0.5, aceleracionZ: 0.866, giroZ: 90, temperatura: 28 }, alimentado: true, pinesGpio: {}, pullUps: [] };
    const bus = armarBusChips([c], 66, { ahoraUs: () => sim.micros, programar: (t, fn) => sim.cpu.addClockEvent(fn, Math.max(1, Math.round(((t - sim.micros) / 1e6) * sim.frecuenciaHz))) })!;
    sim.conectarChips(bus);
    sim.ejecutar(900 * 16_000);
    const l = Buffer.from(serial).toString('utf8').split('\n').map((x) => x.trim()).filter(Boolean);
    expect(l[0]).toBe('MPU6050 OK');
    const v = Object.fromEntries([...l.at(-1)!.matchAll(/(\w+)=(-?[\d.]+)/g)].map((m) => [m[1]!, Number(m[2])]));
    expect(v.ax).toBeCloseTo(0.5 * 9.80665, 1);
    expect(v.az).toBeCloseTo(0.866 * 9.80665, 1);
    expect(v.gz).toBeCloseTo((90 * Math.PI) / 180, 2);
    expect(v.T).toBeCloseTo(28, 1);
  });
});
