import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AvrSimulador } from '../avrSim.js';
import { BusI2c } from './busI2c.js';
import { cargarChips } from './catalogoChips.js';
import { SandboxChip } from './chipSandbox.js';

/**
 * Firmware REAL contra los chips: sketches compilados con arduino-cli y las librerías que usa
 * la gente (Adafruit BME280 2.3.0, Wire del core arduino:avr 1.8.6), corriendo ciclo a ciclo en
 * avr8js, con el I2C (TWI) del ATmega328P conectado al bus de chips. Fuentes y versiones en
 * fixtures/chips/ (compilar.sh). Lo que se compara es lo que el sketch imprime por el Serial.
 */

const MS = 16_000;
const hex = (n: string) => readFileSync(new URL(`../fixtures/chips/${n}/${n}.hex`, import.meta.url), 'utf8');
const chips = cargarChips();
const chip = (id: string) => chips.find((c) => c.id === id)!;

interface Inst { id: string; chip: string; props?: Record<string, unknown>; entorno?: Record<string, number>; alimentado?: boolean }

function correr(sketch: string, instancias: Inst[]) {
  const serial: number[] = [];
  const logs: string[] = [];
  const sim = new AvrSimulador(hex(sketch), { onSerial: (b) => serial.push(b), onPin: () => undefined });
  const bus = new BusI2c({ ahoraUs: () => sim.micros, alLog: (l) => logs.push(l) });
  for (const i of instancias) {
    const c = chip(i.chip);
    const entorno = { ...Object.fromEntries(Object.entries(c.entorno).map(([k, m]) => [k, m.default])), ...i.entorno };
    // Como en el Uno: el chip se enciende con la placa y el programa arranca 66 ms después.
    bus.agregar({ id: i.id, chip: c.id, motor: new SandboxChip(c.id, c.codigo), props: i.props, entorno, alimentado: i.alimentado, maxHz: c.i2c?.maxHz, encendidoEnUs: -66_000 });
  }
  sim.conectarI2c(bus);
  const texto = () => Buffer.from(serial).toString('utf8');
  const lineas = () => texto().split('\n').map((l) => l.trim()).filter(Boolean);
  return { sim, bus, logs, texto, lineas, ms: (n: number) => sim.ejecutar(n * MS) };
}

/** "T=22.50 P=1013.25 H=45.00" → números. */
function valores(linea: string): Record<string, number> {
  return Object.fromEntries([...linea.matchAll(/(\w+)=(-?[\d.]+)/g)].map((m) => [m[1]!, Number(m[2])]));
}

describe('escáner I2C (Wire.endTransmission sobre todas las direcciones)', () => {
  it('sin chips no encuentra nada', () => {
    const r = correr('escaner-i2c', []);
    r.ms(300);
    expect(r.lineas()[0]).toBe('encontrados:');
  });

  it('encuentra exactamente las direcciones de los chips alimentados', () => {
    const r = correr('escaner-i2c', [
      { id: 'a', chip: 'bosch-bme280', props: { sdo: 'alto' } },
      { id: 'b', chip: 'bosch-bme280', props: { sdo: 'bajo' } },
      { id: 'c', chip: 'bosch-bme280', props: { sdo: 'alto' }, alimentado: false },
    ]);
    r.ms(300);
    expect(r.lineas()[0]).toBe('encontrados: 0x76 0x77');
  });

  it('dos chips con la misma dirección: el escáner ve una sola y el bus avisa del conflicto', () => {
    const r = correr('escaner-i2c', [
      { id: 'a', chip: 'bosch-bme280', props: { sdo: 'alto' } },
      { id: 'b', chip: 'bosch-bme280', props: { sdo: 'alto' } },
    ]);
    r.ms(300);
    expect(r.lineas()[0]).toBe('encontrados: 0x77');
    expect(r.logs.some((l) => /conflicto/.test(l))).toBe(true);
  });

  it('el escaneo de 126 direcciones a 100 kHz tarda al menos lo que el bus real (START + 9 bits + STOP ≈ 11 períodos cada una)', () => {
    const r = correr('escaner-i2c', []);
    r.ms(5);
    const t0 = r.sim.micros;
    let n = r.lineas().length;
    while (r.lineas().length === n && r.sim.micros - t0 < 2e6) r.ms(1);
    n = r.lineas().length;
    const t1 = r.sim.micros;
    while (r.lineas().length === n && r.sim.micros - t1 < 2e6) r.ms(1);
    // Entre una línea y la siguiente: el delay(500) más el escaneo.
    const escaneoMs = (r.sim.micros - t1) / 1000 - 500;
    // Piso: 126 × 11 / 100 kHz = 13,9 ms de bus; el resto es lo que tarda Wire entre una y otra.
    expect(escaneoMs).toBeGreaterThan(13.9);
    expect(escaneoMs).toBeLessThan(30);
  });
});

describe('BME280 con Adafruit_BME280 2.3.0 (firmware real)', () => {
  it('begin() encuentra el chip (id 0x60, reset, calibración) y las lecturas siguen al entorno', () => {
    const r = correr('bme280-lectura', [{ id: 'bme', chip: 'bosch-bme280', props: { sdo: 'alto' }, entorno: { temperatura: 23.4, humedad: 61, presion: 1009.8 } }]);
    r.ms(600);
    expect(r.lineas()[0]).toBe('BME280 OK');
    const v = valores(r.lineas()[1]!);
    expect(v.T).toBeCloseTo(23.4, 1);
    expect(v.P).toBeCloseTo(1009.8, 0);
    expect(Math.abs(v.H! - 61)).toBeLessThan(0.3);
  });

  it('con la dirección equivocada begin() falla, como con el sensor real', () => {
    const r = correr('bme280-lectura', [{ id: 'bme', chip: 'bosch-bme280', props: { sdo: 'bajo' } }]);
    r.ms(300);
    expect(r.lineas()[0]).toMatch(/^BME280 no encontrado/);
  });

  it('sin alimentación no contesta', () => {
    const r = correr('bme280-lectura', [{ id: 'bme', chip: 'bosch-bme280', alimentado: false }]);
    r.ms(300);
    expect(r.lineas()[0]).toMatch(/^BME280 no encontrado/);
  });

  it('mover el entorno con el programa corriendo cambia lo que imprime', () => {
    const r = correr('bme280-lectura', [{ id: 'bme', chip: 'bosch-bme280', entorno: { temperatura: 15 } }]);
    r.ms(600);
    expect(valores(r.lineas().at(-1)!).T).toBeCloseTo(15, 1);
    r.bus.ponerEntorno('bme', { temperatura: 31.7, humedad: 20 });
    r.ms(600);
    const v = valores(r.lineas().at(-1)!);
    expect(v.T).toBeCloseTo(31.7, 1);
    expect(Math.abs(v.H! - 20)).toBeLessThan(0.3);
  });

  it('forzado justo después de begin(): ctrl_hum se ignora y la humedad queda en x16 (hoja 3.3.1)', () => {
    // begin() deja el sensor en modo normal x16 (98 ms por medición). setSampling(FORCED, x1...)
    // pide dormir en medio de una medición: el cambio se demora hasta que termina, y mientras
    // tanto las escrituras a ctrl_hum se ignoran (3.3.1). Resultado: la humedad sigue en x16 y
    // cada medición forzada tarda 1 + 2 + 2,5 + 32,5 = 38 ms en vez de 8 ms. Es el mismo problema
    // que reporta el issue #40 de la librería de SparkFun con config después de begin().
    const r = correr('bme280-forzado', [{ id: 'bme', chip: 'bosch-bme280', props: { sdo: 'bajo' }, entorno: { temperatura: -5.5, humedad: 80, presion: 850 } }]);
    r.ms(800);
    expect(r.lineas()[0]).toBe('BME280 OK forzado');
    const v = valores(r.lineas()[2]!);
    expect(v.ok).toBe(1);
    expect(v.us).toBeGreaterThan(38_000);
    expect(v.us).toBeLessThan(41_000);
    expect(v.T).toBeCloseTo(-5.5, 1);
    expect(v.P).toBeCloseTo(850, 0);
    expect(Math.abs(v.H! - 80)).toBeLessThan(0.5);
  });

  it('forzado configurado con el sensor dormido: la medición tarda el t_measure típico (8 ms con x1/x1/x1)', () => {
    const r = correr('bme280-forzado-dormido', [{ id: 'bme', chip: 'bosch-bme280', props: { sdo: 'bajo' }, entorno: { temperatura: 41.2 } }]);
    r.ms(900);
    expect(r.lineas()[0]).toBe('BME280 OK forzado');
    // La primera vuelta: setSampling(FORCED) ya disparó una medición, y el primer
    // takeForcedMeasurement() llega mientras corre: espera que termine y mide otra (3.3.1).
    const primera = valores(r.lineas()[1]!);
    expect(primera.us).toBeGreaterThan(8_000);
    expect(primera.us).toBeLessThan(17_500);
    for (const linea of r.lineas().slice(2, 5)) {
      const v = valores(linea);
      expect(v.ok).toBe(1);
      // takeForcedMeasurement consulta "measuring" con delay(1) entre lecturas: 8 ms + hasta ~1,5 ms.
      expect(v.us).toBeGreaterThan(8_000);
      expect(v.us).toBeLessThan(10_000);
      expect(v.T).toBeCloseTo(41.2, 1);
    }
  });
});
