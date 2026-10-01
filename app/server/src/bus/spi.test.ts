import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AvrSimulador } from '../avrSim.js';
import { armarBusChips } from './armarBus.js';
import { cargarChips } from './catalogoChips.js';
import { MaestroVirtual } from './maestroVirtual.js';
import { entornoDe, type ChipEnBus } from './proyectoChips.js';

/**
 * Bus SPI del Uno, con el BME280 en modo SPI (hoja BST-BME280-DS001, 6.1 y 6.3): CSB selecciona,
 * control con RW en el bit 7, escritura de a pares, lectura con autoincremento, modos 0 y 3, y el
 * I2C que se apaga en cuanto CSB baja.
 */

const bme = cargarChips().find((c) => c.id === 'bosch-bme280')!;
const CS = 10;

function conBme(entorno?: Record<string, number>) {
  const m = new MaestroVirtual();
  m.conectar(bme, { id: 'bme', props: {}, entorno, spi: { csGpio: CS, modos: [0, 3], lsbPrimero: false, soloEscritura: false, maxHz: 10e6 } });
  m.pin(CS, 1); // CS en reposo: alto
  m.esperar(3);
  return m;
}

describe('SPI: BME280 por el maestro virtual', () => {
  it('chip_id: control 0xD0 (RW = 1) y el dato sale en el byte siguiente', () => {
    const m = conBme();
    expect(m.spi(CS, [0xd0, 0x00])).toEqual([0xff, 0x60]);
  });

  it('sin seleccionar (CS en alto) nadie contesta: MISO queda en 0xFF', () => {
    const m = conBme();
    m.pin(CS, 1);
    expect(m.bus.spiByte(0xd0, { modo: 0, lsbPrimero: false, hz: 4e6 })).toBe(0xff);
  });

  it('escritura de a pares (control con RW = 0, sin el bit 7 de la dirección) y lectura con autoincremento', () => {
    const m = conBme();
    m.spi(CS, [0xf2 & 0x7f, 0x01, 0xf4 & 0x7f, 0x25, 0xf5 & 0x7f, 0x10]);
    expect(m.spi(CS, [0xf2, 0, 0, 0, 0])).toEqual([0xff, 0x01, 0x08 /* midiendo */, 0x25, 0x10]);
  });

  it('una medición forzada por SPI da el entorno', () => {
    const m = conBme({ temperatura: 33.3, humedad: 50, presion: 1000 });
    m.spi(CS, [0x72, 0x01, 0x74, 0x25]); // ctrl_hum x1, ctrl_meas x1/x1 forzado
    m.esperar(10);
    const d = m.spi(CS, [0xfa, 0, 0, 0]).slice(1);
    const adcT = (d[0]! << 12) | (d[1]! << 4) | (d[2]! >> 4);
    expect(adcT).not.toBe(0x80000);
  });

  it('en cuanto CSB baja, el I2C se apaga hasta el próximo reinicio (6.1)', () => {
    const m = new MaestroVirtual();
    m.conectar(bme, { id: 'bme', props: { sdo: 'alto' }, spi: { csGpio: CS, modos: [0, 3], lsbPrimero: false, soloEscritura: false } });
    m.pin(CS, 1);
    m.esperar(3);
    expect(m.sondear(0x77)).toBe(true);
    m.spi(CS, [0xd0, 0]);
    expect(m.sondear(0x77)).toBe(false);
  });

  it('con un modo SPI que el chip no acepta (modo 1) los datos llegan corridos y se avisa', () => {
    const m = conBme();
    expect(m.spi(CS, [0xd0, 0x00], { modo: 1 })).not.toEqual([0xff, 0x60]);
    expect(m.logs.join()).toMatch(/modo 0\/3.*modo 1/);
    expect(conBme().spi(CS, [0xd0, 0x00], { modo: 3 })).toEqual([0xff, 0x60]); // el 3 sí
  });

  it('avisa si el reloj SPI pasa los 10 MHz del chip', () => {
    const m = conBme();
    m.spi(CS, [0xd0, 0], { hz: 16e6 });
    expect(m.logs.join()).toMatch(/hasta 10 MHz/);
  });
});

describe('SPI: BME280 con Adafruit_BME280 por SPI por hardware (firmware real)', () => {
  it('begin() lo encuentra por SPI, las lecturas siguen al entorno, y el I2C quedó apagado', () => {
    const serial: number[] = [];
    const sim = new AvrSimulador(readFileSync(new URL('../fixtures/chips/bme280-spi/bme280-spi.hex', import.meta.url), 'utf8'), {
      onSerial: (b) => serial.push(b), onPin: () => undefined,
    });
    const c: ChipEnBus = {
      id: 'bme', instancia: 'bme', chip: bme.id, nombre: 'BME280', codigo: bme.codigo, props: { sdo: 'alto' },
      entorno: { ...entornoDe(bme), temperatura: 19.75, humedad: 70, presion: 990 }, alimentado: true, pinesGpio: { CSB: CS }, pullUps: [],
      spi: { csGpio: CS, modos: [0, 3], lsbPrimero: false, soloEscritura: false, maxHz: 10e6 },
    };
    const bus = armarBusChips([c], 66, { ahoraUs: () => sim.micros, programar: (t, fn) => sim.cpu.addClockEvent(fn, Math.max(1, Math.round(((t - sim.micros) / 1e6) * 16e6))) })!;
    sim.conectarChips(bus);
    sim.ejecutar(700 * 16_000);
    const l = Buffer.from(serial).toString().split('\n').map((x) => x.trim()).filter(Boolean);
    expect(l[0]).toBe('BME280 SPI OK');
    expect(l[1]).toBe('i2c 0x77 contesta=0');
    const v = Object.fromEntries([...l.at(-1)!.matchAll(/(\w+)=(-?[\d.]+)/g)].map((x) => [x[1]!, Number(x[2])]));
    expect(v.T).toBeCloseTo(19.75, 1);
    expect(v.P).toBeCloseTo(990, 0);
    expect(Math.abs(v.H! - 70)).toBeLessThan(0.3);
  });
});
