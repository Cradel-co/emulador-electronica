import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AvrEmulator } from '../avrEmulator.js';
import { cargarChips } from './catalogoChips.js';
import { MaestroVirtual } from './maestroVirtual.js';
import { borrarMemoria, guardarMemoria, leerMemoria } from './memoriaChips.js';
import { entornoDe, type ChipEnBus } from './proyectoChips.js';

/** Memoria no volátil de los chips: lo que graba una EEPROM y la hora de un reloj con pila. */

const chips = cargarChips();
const ee = chips.find((c) => c.id === 'atmel-at24c32')!;
const rtc = chips.find((c) => c.id === 'maxim-ds3231')!;
const bcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const dec = (b: number) => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);

describe('AT24C32: lo grabado sobrevive a apagar', () => {
  it('lo que se graba vuelve en el próximo encendido; sin memoria guardada, viene borrada (FFh)', () => {
    const a = new MaestroVirtual();
    a.conectar(ee, { id: 'ee', props: { direccion: '0x57' } });
    a.escribir(0x57, [0x02, 0x00, 0xca, 0xfe]);
    a.esperar(6);
    const g = a.guardados.get('ee');
    expect(g).toBeDefined();

    const b = new MaestroVirtual();
    b.conectar(ee, { id: 'ee', props: { direccion: '0x57' }, guardado: g });
    expect(b.leerRegistros(0x57, [0x02, 0x00], 3)).toEqual([0xca, 0xfe, 0xff]);

    const c = new MaestroVirtual();
    c.conectar(ee, { id: 'ee', props: { direccion: '0x57' } });
    expect(c.leerRegistros(0x57, [0x02, 0x00], 2)).toEqual([0xff, 0xff]);
  });

  it('una memoria guardada rota (otro tamaño) se ignora: arranca borrada', () => {
    const m = new MaestroVirtual();
    m.conectar(ee, { id: 'ee', props: { direccion: '0x57' }, guardado: { hex: 'abc' } });
    expect(m.leerRegistros(0x57, [0x00, 0x00], 1)).toEqual([0xff]);
  });
});

describe('DS3231 con pila: la hora sigue entre ejecuciones', () => {
  function conHora() {
    const m = new MaestroVirtual();
    m.conectar(rtc, { id: 'rtc', props: { inicio: '2026-10-01T10:00:00' } });
    // El programa la pone en hora (como RTClib.adjust): 08:15:00 del 3/3/2027, miércoles (3).
    m.escribir(0x68, [0x00, bcd(0), bcd(15), bcd(8), 3, bcd(3), bcd(3), bcd(27)]);
    m.escribir(0x68, [0x07, bcd(0), bcd(30), bcd(9), 0x80]); // alarma 1 a las 09:30:00 (fecha enmascarada)
    m.bus.apagar();
    return m.guardados.get('rtc') as { seg: number; pcMs: number };
  }
  const leerHora = (m: MaestroVirtual) => {
    const b = m.leerRegistros(0x68, 0, 7)!;
    return { h: dec(b[2]! & 0x3f), m: dec(b[1]!), dow: b[3]!, d: dec(b[4]!) };
  };

  it('con pila: retoma la hora guardada más lo que estuvo apagado, y las alarmas vencidas prenden su flag', () => {
    const g = conHora();
    const dosHoras = { ...g, pcMs: g.pcMs - 2 * 3600_000 }; // como si se hubiera apagado hace 2 h
    const m = new MaestroVirtual();
    m.conectar(rtc, { id: 'rtc', props: {}, guardado: dosHoras }); // sin 'inicio': usa lo guardado
    expect(leerHora(m)).toMatchObject({ h: 10, m: 15, dow: 3, d: 3 });
    expect(m.leerRegistros(0x68, 0x0f, 1)![0]! & 0x81).toBe(0x01); // OSF = 0 y A1F = 1 (venció a las 09:30)
  });

  it('sin pila, lo guardado no sirve: arranca de cero con OSF = 1', () => {
    const g = conHora();
    const m = new MaestroVirtual();
    m.conectar(rtc, { id: 'rtc', props: { pila: 'ninguna' }, guardado: g });
    m.esperar(200);
    expect(leerHora(m)).toMatchObject({ h: 0, m: 0, d: 1 });
    expect(m.leerRegistros(0x68, 0x0f, 1)![0]! & 0x80).toBe(0x80);
  });
});

describe('memoria en el proyecto', () => {
  it('se escribe de forma atómica en .chips/<id>.json y se lee igual; borrarla = chip nuevo', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'emu-memoria-'));
    expect(await leerMemoria(dir, 'rtc:maxim-ds3231')).toBeUndefined();
    await guardarMemoria(dir, 'rtc:maxim-ds3231', { seg: 1, pcMs: 2 });
    expect(await leerMemoria(dir, 'rtc:maxim-ds3231')).toEqual({ seg: 1, pcMs: 2 });
    await borrarMemoria(dir);
    expect(await leerMemoria(dir, 'rtc:maxim-ds3231')).toBeUndefined();
  });
});

describe('AvrEmulator: lo que guardan los chips llega a la app (modo worker)', { timeout: 60_000 }, () => {
  const emulador = () => new AvrEmulator({ onLog: () => undefined, onState: () => undefined, onBridgeMessage: () => undefined, onBridgeState: () => undefined }, 'worker');
  const art = (n: string) => ({ firmware: new URL(`../fixtures/chips/${n}/${n}.hex`, import.meta.url).pathname, elf: null, usesWebServer: false, usesApi: false, needsRepl: false });
  const chip = (c: typeof ee, id: string, props: Record<string, unknown>): ChipEnBus => ({
    id, instancia: id, chip: c.id, nombre: c.nombre, codigo: c.codigo, props, entorno: entornoDe(c), alimentado: true, pinesGpio: {}, pullUps: [],
  });
  const hasta = async (cond: () => boolean) => { const l = Date.now() + 20_000; while (!cond() && Date.now() < l) await new Promise((r) => setTimeout(r, 50)); };

  it('la página que graba el firmware real (Wire) llega con su contenido', async () => {
    const emu = emulador();
    const guardados: { hex: string }[] = [];
    emu.oyenteGuardado = (_id, datos) => guardados.push(datos as { hex: string });
    await emu.start('t', art('eeprom-24c32'), { chips: [chip(ee, 'ee', { direccion: '0x57' })], arranqueMs: 66 });
    await hasta(() => guardados.length > 0);
    await emu.stop();
    expect(guardados.at(-1)!.hex.slice(0x100 * 2, 0x108 * 2)).toBe('a0a1a2a3a4a5a6a7'); // lo que grabó en 0100h
  });

  it('al parar, el reloj guarda su hora ANTES de que se corte el hilo (evento apagar)', async () => {
    const emu = emulador();
    const guardados: { seg: number }[] = [];
    emu.oyenteGuardado = (_id, datos) => guardados.push(datos as { seg: number });
    await emu.start('t', art('rtc-hora'), { chips: [chip(rtc, 'rtc', {})], arranqueMs: 66 });
    await new Promise((r) => setTimeout(r, 1500));
    const antes = guardados.length;
    await emu.stop();
    expect(guardados.length).toBe(antes + 1);
    expect(guardados.at(-1)!.seg).toBeGreaterThan(0);
  });
});
