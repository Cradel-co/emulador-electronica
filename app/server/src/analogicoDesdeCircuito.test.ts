import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adcConfig } from 'avr8js';
import type { Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from './catalog.js';
import { analizarCircuito } from './sim/analisis.js';
import { estadoAnalogicoDesdeCircuito, type EstadoAnalogicoAvr } from './analogicoAvr.js';
import { AvrSimulador } from './avrSim.js';
import { AvrEmulator } from './avrEmulator.js';
import { BASE_DATOS_AVR } from './debug/avrControl.js';
let catalogo: ModuloCatalogo[] = [];
beforeAll(async () => { catalogo = await loadCatalog(); });
const proyecto = (): Project => ({ schemaVersion: 1, name: 'adc-fisico', board: 'arduino-uno', language: 'arduino',
  boards: [{ id: 'board', board: 'arduino-uno', language: 'arduino' }],
  modules: [{ id: 'board', type: 'arduino-uno', props: { usb: true }, x: 0, y: 0 },
    { id: 'r1', type: 'resistor', props: { ohms: 1000 }, x: 0, y: 0 }, { id: 'r2', type: 'resistor', props: { ohms: 1000 }, x: 0, y: 0 }],
  wires: [{ from: 'board.5V', to: 'r1.1' }, { from: 'r1.2', to: 'board.A0' }, { from: 'board.A0', to: 'r2.1' }, { from: 'r2.2', to: 'board.GND' }],
  sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false } });
const buscar = (t: string) => catalogo.find(m => m.type === t);
const descriptor = () => {
  const desc = buscar('arduino-uno')?.board;
  if (!desc) throw new Error('Falta placa');
  return desc;
};

/** Firmware mínimo: convierte ADC, espera ADSC y copia ADCL/ADCH a SRAM, repetidamente. */
function firmware(mux = 0x40): string {
  const ldi = (v: number) => 0xe000 | ((v & 0xf0) << 4) | (v & 15);
  const palabras = [
    ldi(mux), 0x9300, adcConfig.ADMUX, ldi(0xc7), 0x9300, adcConfig.ADCSRA,
    0x9100, adcConfig.ADCSRA, 0xfd06, 0xcffc, // LDS r16; SBRC r16,ADSC; RJMP espera
    0x9110, adcConfig.ADCL, 0x9120, adcConfig.ADCH,
    0x9310, 0x100, 0x9320, 0x101, 0xcff0,
  ];
  const datos = palabras.flatMap(p => [p & 255, p >> 8]);
  const registro = [datos.length, 0, 0, 0, ...datos];
  const suma = registro.reduce((a, b) => a + b, 0);
  return `:${[...registro, (-suma) & 255].map(b => b.toString(16).padStart(2, '0')).join('')}\n:00000001FF\n`;
}
function cuentaFirmware(e: EstadoAnalogicoAvr, mux = 0x40): number {
  const s = new AvrSimulador(firmware(mux), { onSerial: () => {}, onPin: () => {} });
  s.actualizarAnalogicoAvr(e); s.ejecutar(6000);
  return (s.cpu.data[0x100] ?? 0) | ((s.cpu.data[0x101] ?? 0) << 8);
}
it('usa divisor real SPICE, tierra local, AREF desconocida y no fabrica ADC de pines sin cable', async () => {
  const p = proyecto(); const r = await analizarCircuito(p, buscar);
  const desc = buscar('arduino-uno')?.board;
  if (!desc) throw new Error('Falta placa');
  const e = estadoAnalogicoDesdeCircuito(p, 'board', desc, r);
  expect(e.resuelto).toBe(true); expect(e.vcc).toBeCloseTo(5, 3);
  expect(e.avcc).toBe(e.vcc); expect(e.canales[0]).toBeCloseTo((e.vcc ?? 0) / 2, 3);
  // El solver tiene error numérico: se tolera una cuenta alrededor del divisor ideal.
  expect(Math.abs(cuentaFirmware(e) - 512)).toBeLessThanOrEqual(1);
  expect(e.canales[1]).toBeNull(); expect(e.aref).toBeNull();
  // Cambiar el cero global del solver no cambia las tensiones respecto del GND del MCU.
  const desplazado = estadoAnalogicoDesdeCircuito(p, 'board', desc, {
    ...r, tensiones: Object.fromEntries(Object.entries(r.tensiones).map(([pin, v]) => [pin, v + 7])),
  });
  expect(desplazado.vcc).toBeCloseTo(e.vcc ?? 0, 9);
  expect(desplazado.canales[0]).toBeCloseTo(e.canales[0] ?? 0, 9);
  p.wires = [];
  const sinCables = estadoAnalogicoDesdeCircuito(p, 'board', desc, await analizarCircuito(p, buscar));
  expect(sinCables.vcc).toBeCloseTo(5, 3); expect(sinCables.avcc).toBeCloseTo(5, 3);
  expect(sinCables.canales[0]).toBeNull();
});
it('rechaza ADC de otra placa ATmega328P sin configuración de rail validada', async () => {
  const p = proyecto(); const r = await analizarCircuito(p, buscar);
  const desc = buscar('arduino-uno')?.board;
  if (!desc) throw new Error('Falta placa');
  const placa = p.modules[0];
  if (!placa) throw new Error('Falta instancia de placa');
  placa.type = 'otra-placa-328p';
  expect(estadoAnalogicoDesdeCircuito(p, 'board', desc, r).resuelto).toBe(false);
});

it.each(['A4', 'SDA'])('conserva ADC4 cableado como %s aunque el otro alias no esté cableado', async pin => {
  const p = proyecto();
  p.wires = p.wires.map(w => ({ from: w.from.replace('.A0', `.${pin}`), to: w.to.replace('.A0', `.${pin}`) }));
  const e = estadoAnalogicoDesdeCircuito(p, 'board', descriptor(), await analizarCircuito(p, buscar));
  expect(e.canales[4]).toBeCloseTo((e.vcc ?? 0) / 2, 3);
  expect(Math.abs(cuentaFirmware(e, 0x44) - 512)).toBeLessThanOrEqual(1);
});

it('rechaza un ADC cableado a una resistencia que queda flotante', async () => {
  const p = proyecto(); p.wires = [{ from: 'board.A0', to: 'r1.1' }];
  const r = await analizarCircuito(p, buscar);
  expect(r.resuelto).toBe(true);
  expect(r.entradas.find(e => e.gpio === 14)?.flotante).toBe(true);
  const e = estadoAnalogicoDesdeCircuito(p, 'board', descriptor(), r);
  expect(e.canales[0]).toBeNull();
  expect(() => cuentaFirmware(e)).toThrow(/ADC0 desconocido/);
});

it('usa AREF externa cableada al riel 3V3 real al leer el divisor', async () => {
  const p = proyecto(); p.wires.push({ from: 'board.3V3', to: 'board.AREF' });
  const r = await analizarCircuito(p, buscar);
  const e = estadoAnalogicoDesdeCircuito(p, 'board', descriptor(), r);
  const riel = r.tensiones['board.3V3'], tierra = r.tensiones['board.GND'];
  if (riel === undefined || tierra === undefined) throw new Error('Falta solución de la referencia');
  expect(e.aref).toBe(riel - tierra);
  expect(Math.abs(cuentaFirmware(e, 0) - Math.floor(2.5 / 3.3 * 1024))).toBeLessThanOrEqual(1);
});

let carpetaTemporal = '';
let rutaFirmware = '';
beforeAll(async () => {
  carpetaTemporal = await mkdtemp(join(tmpdir(), 'adc-avr-'));
  rutaFirmware = join(carpetaTemporal, 'adc.hex');
  await writeFile(rutaFirmware, firmware());
});
afterAll(async () => { if (carpetaTemporal) await rm(carpetaTemporal, { recursive: true, force: true }); });

describe.each(['local', 'worker'] as const)('ADC en AvrEmulator %s', modo => {
  function crear() {
    return new AvrEmulator({ onLog: () => {}, onState: () => {}, onBridgeMessage: () => {}, onBridgeState: () => {} }, modo);
  }
  const artefactos = () => ({ firmware: rutaFirmware, elf: null, usesWebServer: false, usesApi: false, needsRepl: false });
  async function esperarCuenta(emu: AvrEmulator, esperado: number) {
    await expect.poll(async () => {
      const r = await emu.depurar({ op: 'leer', dir: BASE_DATOS_AVR + 0x100, largo: 2 });
      return r.ok && r.datos ? (r.datos[0] ?? 0) | ((r.datos[1] ?? 0) << 8) : null;
    }, { timeout: 10_000, interval: 20 }).toBe(esperado);
  }
  it('lee la solución del divisor, actualiza y conserva instantáneas al resetear', async () => {
    const p = proyecto();
    const inicial = estadoAnalogicoDesdeCircuito(p, 'board', descriptor(), await analizarCircuito(p, buscar));
    const esperado = cuentaFirmware(inicial);
    const emu = crear();
    try {
      await emu.start('adc', artefactos(), { analogicoAvr: inicial });
      inicial.canales = { 0: null }; // No debe modificar la instantánea almacenada para reset.
      await esperarCuenta(emu, esperado);
      await emu.reset();
      await esperarCuenta(emu, esperado);
      const nuevo = { ...inicial, canales: { 0: (inicial.avcc ?? 0) / 4 } };
      emu.actualizarAnalogicoAvr(nuevo);
      nuevo.canales[0] = 0;
      await esperarCuenta(emu, 256);
      await emu.reset();
      await esperarCuenta(emu, 256);
    } finally { await emu.stop(); }
  });
  it('detiene la ejecución si una actualización vuelve desconocido el ADC', async () => {
    const emu = crear();
    try {
      await emu.start('adc', artefactos(), { analogicoAvr: { resuelto: true, vcc: 5, avcc: 5, aref: null, canales: { 0: 2.5 } } });
      await esperarCuenta(emu, 512);
      emu.actualizarAnalogicoAvr({ resuelto: false, vcc: null, avcc: null, aref: null, canales: {} });
      await expect.poll(() => emu.getStatus().state, { timeout: 10_000 }).toBe('crashed');
      expect(emu.getStatus()).toMatchObject({ running: false, exitInfo: expect.stringContaining('ADC AVR') });
      expect(emu.getBridge()).toBeNull();
      expect(await emu.depurar({ op: 'estado' })).toMatchObject({ ok: false });
    } finally { await emu.stop(); }
  });
  it('reporta y detiene también una conversión inválida ejecutada paso a paso', async () => {
    const emu = crear();
    try {
      await emu.start('adc', artefactos(), { analogicoAvr: { resuelto: true, vcc: 5, avcc: 5, aref: null, canales: { 0: 2.5 } } });
      await esperarCuenta(emu, 512);
      // STS ADCSRA,r16 inicia la conversión: se detiene justo antes de ejecutarla.
      await emu.depurar({ op: 'breakpoints', dirs: [8] });
      await expect.poll(async () => {
        const r = await emu.depurar({ op: 'estado' });
        return r.ok && r.detenido;
      }, { timeout: 10_000 }).toBe(true);
      emu.actualizarAnalogicoAvr({ resuelto: false, vcc: null, avcc: null, aref: null, canales: {} });
      const paso = await emu.depurar({ op: 'paso' });
      expect(paso).toMatchObject({ ok: false });
      expect(emu.getStatus()).toMatchObject({ state: 'crashed', running: false, exitInfo: expect.stringContaining('ADC AVR') });
    } finally { await emu.stop(); }
  });
});
