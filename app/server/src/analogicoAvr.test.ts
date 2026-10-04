import { describe, expect, it } from 'vitest';
import { adcConfig } from 'avr8js';
import { AvrSimulador } from './avrSim.js';
import type { EstadoAnalogicoAvr } from './analogicoAvr.js';

const estado = (v = 2.5): EstadoAnalogicoAvr => ({ resuelto: true, vcc: 5, avcc: 5, aref: 2.048, canales: { 0: v, 1: 1 } });
function simular() { return new AvrSimulador(':00000001FF', { onSerial: () => {}, onPin: () => {} }); }
function convertir(sim: AvrSimulador, mux = 0x40, control = 0xc7): number {
  sim.cpu.writeData(adcConfig.ADMUX, mux);
  sim.cpu.writeData(adcConfig.ADCSRA, control);
  sim.ejecutar(4000);
  return (sim.cpu.data[adcConfig.ADCL] ?? 0) | ((sim.cpu.data[adcConfig.ADCH] ?? 0) << 8);
}
describe('ADC AVR recibe tensiones físicas sin unknown→0', () => {
  it('cuantiza con AVCC resuelta y acepta actualizaciones sin reiniciar', () => {
    const s = simular(); s.actualizarAnalogicoAvr(estado());
    expect(convertir(s)).toBe(512);
    s.actualizarAnalogicoAvr({ ...estado(2), vcc: 4, avcc: 4 });
    expect(convertir(s)).toBe(512);
    s.actualizarAnalogicoAvr(estado(1));
    expect(convertir(s)).toBe(204);
  });
  it('usa AREF externa, referencia interna nominal1.1 y saturación según ADMUX', () => {
    const s = simular(); s.actualizarAnalogicoAvr(estado(1));
    expect(convertir(s, 0)).toBe(500);
    expect(convertir(s, 0xc0)).toBe(930);
    s.actualizarAnalogicoAvr(estado(2));
    expect(convertir(s, 0xc0)).toBe(1023);
    expect(convertir(s, 0x4e)).toBe(225); // bandgap nominal1.1 como entrada, AVCC5
  });
  it.each([
    { ...estado(), resuelto: false }, { ...estado(), canales: { 0: null } },
    { ...estado(), avcc: null }, { ...estado(), vcc: null },
  ])('rechaza datos no resueltos/sin referencia/sin canal, sin sustituirlos por 0', e => {
    const s = simular(); s.actualizarAnalogicoAvr(e);
    expect(() => convertir(s)).toThrow(/ADC/);
  });
  it('rechaza AREF desconocida, selección reservada, temperatura no calibrada y ADC6 no expuesto en Uno', () => {
    for (const mux of [0, 0x80, 0x48, 0x46]) {
      const s = simular(); s.actualizarAnalogicoAvr({ ...estado(), aref: null });
      expect(() => convertir(s, mux)).toThrow(/ADC/);
    }
  });
  it.each([9, 10, 11, 12, 13])('rechaza MUX reservado %s aunque avr8js lo convierta a constante cero', canal => {
    const s = simular(); s.actualizarAnalogicoAvr(estado());
    expect(() => convertir(s, 0x40 | canal)).toThrow(/MUX.*reservad/);
  });
  it('rechaza auto-trigger fuera del perfil de conversiones individuales', () => {
    const s = simular(); s.actualizarAnalogicoAvr(estado());
    expect(() => convertir(s, 0x40, 0xe7)).toThrow(/auto-trigger/);
  });
  it.each([2.6, 5.6])('rechaza AVCC %s fuera del dominio del modelo', avcc => {
    const s = simular(); s.actualizarAnalogicoAvr({ ...estado(), avcc, vcc: avcc });
    expect(() => convertir(s)).toThrow(/AVCC/);
  });
  it('rechaza diferencia excesiva VCC/AVCC', () => {
    const s = simular(); s.actualizarAnalogicoAvr({ ...estado(), avcc: 4.5 });
    expect(() => convertir(s)).toThrow(/AVCC/);
  });
  it('convierte extremos y canal GND, y conserva muestra al inicio de la conversión', () => {
    const s = simular(); s.actualizarAnalogicoAvr(estado(0));
    expect(convertir(s)).toBe(0);
    s.actualizarAnalogicoAvr(estado(5));
    expect(convertir(s)).toBe(1023);
    expect(convertir(s, 0x4f)).toBe(0);
    s.actualizarAnalogicoAvr(estado(2.5));
    s.cpu.writeData(adcConfig.ADMUX, 0x40);
    s.cpu.writeData(adcConfig.ADCSRA, 0xc7);
    s.actualizarAnalogicoAvr(estado(1));
    s.ejecutar(4000);
    expect((s.cpu.data[adcConfig.ADCL] ?? 0) | ((s.cpu.data[adcConfig.ADCH] ?? 0) << 8)).toBe(512);
    expect(convertir(s)).toBe(204);
  });
  it.each([-0.1, 5.1, NaN, Infinity])('rechaza VIN fuera de dominio o no finita %s', vin => {
    const s = simular(); s.actualizarAnalogicoAvr(estado(vin));
    expect(() => convertir(s)).toThrow(/ADC/);
  });
  it.each([0, 0.9, 5.1, NaN])('rechaza AREF externa fuera de rango %s', aref => {
    const s = simular(); s.actualizarAnalogicoAvr({ ...estado(), aref });
    expect(() => convertir(s, 0)).toThrow(/ADC/);
  });
  it('firmware AVR ejecuta LDS de ADCL/ADCH y recibe el valor del circuito', () => {
    const s = simular(); s.actualizarAnalogicoAvr(estado(2.5));
    // LDI r16,REFS0; STS ADMUX,r16; LDI r16,ADEN|ADSC|ADPS; STS ADCSRA,r16.
    const ldi = (v: number) => 0xe000 | ((v & 0xf0) << 4) | (v & 15);
    s.cpu.progMem.set([ldi(0x40), 0x9300, adcConfig.ADMUX, ldi(0xc7), 0x9300, adcConfig.ADCSRA]);
    s.cpu.progMem[4000] = 0x9110; s.cpu.progMem[4001] = adcConfig.ADCL; // LDS r17
    s.cpu.progMem[4002] = 0x9120; s.cpu.progMem[4003] = adcConfig.ADCH; // LDS r18
    s.cpu.progMem[4004] = 0xcfff; // RJMP -1
    s.ejecutar(6000);
    expect((s.cpu.data[17] ?? 0) | ((s.cpu.data[18] ?? 0) << 8)).toBe(512);
  });
});
