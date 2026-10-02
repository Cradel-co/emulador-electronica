import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AvrSimulador } from '../avrSim.js';
import { armarBusChips, LineasCompartidas } from './armarBus.js';
import { cargarChips } from './catalogoChips.js';
import { entornoDe, type ChipEnBus } from './proyectoChips.js';

/**
 * Firmware real con el DS3231 y la AT24C32 de una ZS-042: RTClib 2.1.4 y Wire del core
 * arduino:avr 1.8.6, ciclo a ciclo en avr8js, con el bus armado igual que en la app
 * (armarBusChips + líneas compartidas para INT/SQW → D2).
 */

const MS = 16_000;
const hex = (n: string) => readFileSync(new URL(`../fixtures/chips/${n}/${n}.hex`, import.meta.url), 'utf8');
const catalogo = cargarChips();

function chip(id: string, inst: string, o: Partial<ChipEnBus> = {}): ChipEnBus {
  const c = catalogo.find((x) => x.id === id)!;
  return {
    id: inst, instancia: inst, chip: id, nombre: `${c.nombre} (${inst})`, codigo: c.codigo, props: {},
    entorno: entornoDe(c), alimentado: true, maxHz: c.i2c?.maxHz, pinesGpio: {}, pullUps: [], ...o,
  };
}

function correr(sketch: string, chips: ChipEnBus[]) {
  const serial: number[] = [];
  const logs: string[] = [];
  const sim = new AvrSimulador(hex(sketch), { onSerial: (b) => serial.push(b), onPin: () => undefined });
  const lineas = new LineasCompartidas((g, n) => sim.ponerEntrada(g, n));
  const bus = armarBusChips(chips, 66, {
    ahoraUs: () => sim.micros,
    alLog: (l) => logs.push(l),
    alPin: (id, pin, nivel) => { const c = chips.find((x) => x.id === id); if (c) lineas.desdeChip(c, pin, nivel); },
    programar: (t, fn) => sim.cpu.addClockEvent(fn, Math.max(1, Math.round(((t - sim.micros) / 1e6) * sim.frecuenciaHz))),
  })!;
  sim.conectarChips(bus);
  const lineasSerial = () => Buffer.from(serial).toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  return { sim, bus, logs, lineas: lineasSerial, ms: (n: number) => sim.ejecutar(n * MS) };
}
const num = (l: string, k: string) => Number(new RegExp(`${k}=(-?[\\d.]+)`).exec(l)?.[1]);

describe('DS3231 con RTClib 2.1.4 (firmware real)', () => {
  it('con pila y en hora: lostPower = 0, y la hora avanza un segundo por segundo de emulación', () => {
    const r = correr('rtc-hora', [chip('maxim-ds3231', 'rtc', { props: { inicio: '2026-10-01T08:30:15' }, entorno: { temperatura: 24.6 } })]);
    r.ms(3300);
    const l = r.lineas();
    expect(l[0]).toBe('lostPower=0');
    const horas = l.filter((x) => /^\d{4}-/.test(x));
    expect(horas[0]).toMatch(/^2026-10-01 08:30:15 /);
    expect(horas.slice(0, 4).map((x) => x.slice(11, 19))).toEqual(['08:30:15', '08:30:16', '08:30:17', '08:30:18']);
    // Cada cambio de segundo llega ~1000 ms después del anterior (lo ve millis() del Arduino).
    const ms = horas.map((x) => num(x, 'ms'));
    for (let i = 2; i < ms.length; i++) expect(Math.abs(ms[i]! - ms[i - 1]! - 1000)).toBeLessThanOrEqual(25);
    // La temperatura: la conversión del encendido (125 ms) ya terminó al primer print, redondeada a 0,25 °C.
    expect(num(horas[1]!, 'T')).toBe(24.5);
  });

  it('primer encendido (sin pila): lostPower = 1, el sketch la pone en hora y adjust() borra OSF', () => {
    const r = correr('rtc-hora', [chip('maxim-ds3231', 'rtc', { props: { estado: 'sin-pila' } })]);
    r.ms(1500);
    const l = r.lineas();
    expect(l[0]).toBe('perdio la hora: ajustando');
    expect(l[1]).toBe('lostPower=0');
    expect(l[2]).toMatch(/^2026-10-01 12:00:0[01] /);
  });
});

describe('DS3231: alarma 1 → INT/SQW → interrupción en D2 (firmware real)', () => {
  it('INT baja exactamente cuando llega el segundo de la alarma; clearAlarm la suelta (pull-up de la placa)', () => {
    const rtc = chip('maxim-ds3231', 'rtc', { props: { inicio: '2026-10-01T12:00:00' }, pinesGpio: { 'INT/SQW': 2 }, pullUps: ['INT/SQW'] });
    const r = correr('rtc-alarma', [rtc]);
    r.ms(5000);
    const l = r.lineas();
    expect(l[0]).toMatch(/^alarma programada ok=1 a las 0\+3 ms=\d+/);
    const alarma = l.find((x) => x.startsWith('ALARMA'))!;
    expect(alarma).toBeDefined();
    // La hora arrancó en 12:00:00.000 cuando la CPU llevaba −66 ms: el segundo 3 llega a los 2934 ms de millis().
    expect(Math.abs(num(alarma, 'ms') - 2934)).toBeLessThanOrEqual(3);
    expect(alarma).toMatch(/fired=1 D2=0 despues D2=1$/);
    expect(l.filter((x) => x.startsWith('ALARMA'))).toHaveLength(1); // DS3231_A1_Second: una por minuto
  });

  it('sin el pull-up de la placa, al soltarse INT el pin queda flotando (como en la vida real: hace falta uno)', () => {
    const rtc = chip('maxim-ds3231', 'rtc', { props: { inicio: '2026-10-01T12:00:00' }, pinesGpio: { 'INT/SQW': 2 }, pullUps: [] });
    const r = correr('rtc-alarma', [rtc]);
    r.ms(5000);
    // Sin pull-up, la línea suelta en un AVR sin INPUT_PULLUP se lee 0 (flotando): no hay flanco de bajada.
    expect(r.lineas().some((x) => x.startsWith('ALARMA'))).toBe(false);
  });
});

describe('AT24C32 con Wire (firmware real)', () => {
  it('graba una página, el acknowledge polling dura t_WR (5 ms) y lee lo grabado', () => {
    const r = correr('eeprom-24c32', [chip('atmel-at24c32', 'ee', { props: { direccion: '0x57' } })]);
    r.ms(300);
    const [esc, leido] = r.lineas();
    expect(num(esc!, 'escritura')).toBe(0);
    const us = num(esc!, 'polling_us');
    expect(us).toBeGreaterThan(4800);
    expect(us).toBeLessThan(5300);
    expect(leido).toBe('leido: A0 A1 A2 A3 A4 A5 A6 A7 FF');
  });
});
