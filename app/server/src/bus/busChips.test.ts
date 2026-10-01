import { describe, expect, it } from 'vitest';
import { BusChips, type MotorChip } from './busChips.js';
import type { EventoChip } from './chipSandbox.js';

/** El bus I2C con un chip falso que anota cada llamada: ACK, colector abierto, lecturas, tandas. */

function falso(direcciones = [0x40]) {
  const llamadas: EventoChip[][] = [];
  const motor: MotorChip = {
    correr(eventos) {
      llamadas.push(eventos);
      const lecturas = eventos.filter((e) => e.tipo === 'leer').map((e) => Array.from({ length: (e as { n: number }).n }, (_, i) => i));
      return { lecturas, direcciones, ocupadoHasta: 0, pines: {}, despertarEn: null, logs: [] };
    },
  };
  return { motor, llamadas };
}

function bus(diferir: boolean) {
  let t = 0;
  const agenda: { t: number; fn: () => void }[] = [];
  const b = new BusChips({ ahoraUs: () => t, programar: (tt, fn) => agenda.push({ t: tt, fn }) });
  const f = falso();
  b.agregar({ id: 'x', chip: 'falso', motor: f.motor, diferirEscrituras: diferir });
  const escribir = (bytes: number[]) => { b.inicio(); b.conectar(0x40, true); for (const v of bytes) b.escribirByte(v); b.parada(); };
  const avanzar = (us: number) => {
    t += us;
    agenda.sort((a, c) => a.t - c.t);
    while (agenda[0] && agenda[0].t <= t) agenda.shift()!.fn();
  };
  return { b, f, escribir, avanzar, ahora: () => t };
}

describe('BusChips', () => {
  it('sin diferir: una llamada al chip por transacción de escritura', () => {
    const { f, escribir } = bus(false);
    f.llamadas.length = 0;
    for (let i = 0; i < 20; i++) escribir([0x40, i]);
    expect(f.llamadas).toHaveLength(20);
  });

  it('con diferirEscrituras: hasta 16 escrituras por llamada, cada una con su instante', () => {
    const { f, escribir, avanzar } = bus(true);
    f.llamadas.length = 0;
    for (let i = 0; i < 20; i++) { escribir([0x40, i]); avanzar(100); }
    expect(f.llamadas).toHaveLength(1); // las primeras 16
    expect(f.llamadas[0]!.map((e) => e.t)).toEqual(Array.from({ length: 16 }, (_, i) => i * 100));
    avanzar(10_000); // la tanda que quedó se entrega a los 10 ms de su primera
    expect(f.llamadas).toHaveLength(2);
    expect(f.llamadas[1]!.map((e) => (e as { bytes: number[] }).bytes[1])).toEqual([16, 17, 18, 19]);
  });

  it('una lectura entrega antes lo diferido, en orden', () => {
    const { b, f, escribir } = bus(true);
    f.llamadas.length = 0;
    escribir([0x40, 1]);
    escribir([0x40, 2]);
    expect(f.llamadas).toHaveLength(0);
    b.inicio();
    b.conectar(0x40, false);
    b.leerByte(false);
    b.parada();
    expect(f.llamadas[0]!.map((e) => e.tipo)).toEqual(['escribir', 'escribir', 'leer']);
  });

  it('dos chips con la misma dirección: en una lectura gana el 0 (AND) y se avisa', () => {
    const logs: string[] = [];
    const b = new BusChips({ ahoraUs: () => 0, alLog: (l) => logs.push(l) });
    const uno: MotorChip = { correr: (ev) => ({ lecturas: ev.filter((e) => e.tipo === 'leer').map(() => [0b1100]), direcciones: [0x40], ocupadoHasta: 0, pines: {}, despertarEn: null, logs: [] }) };
    const otro: MotorChip = { correr: (ev) => ({ lecturas: ev.filter((e) => e.tipo === 'leer').map(() => [0b1010]), direcciones: [0x40], ocupadoHasta: 0, pines: {}, despertarEn: null, logs: [] }) };
    b.agregar({ id: 'a', chip: 'x', motor: uno });
    b.agregar({ id: 'b', chip: 'x', motor: otro });
    b.inicio();
    expect(b.conectar(0x40, false)).toBe(true);
    expect(b.leerByte(false)).toBe(0b1000);
    b.parada();
    expect(logs.join()).toMatch(/conflicto/);
  });

  it('un chip sin alimentación no contesta; uno que tira un error queda fuera del bus', () => {
    const logs: string[] = [];
    const b = new BusChips({ ahoraUs: () => 0, alLog: (l) => logs.push(l) });
    b.agregar({ id: 'apagado', chip: 'x', motor: falso([0x41]).motor, alimentado: false });
    let veces = 0;
    b.agregar({ id: 'roto', chip: 'x', motor: { correr: () => { if (veces++ > 0) throw new Error('se rompió'); return { lecturas: [], direcciones: [0x42], ocupadoHasta: 0, pines: {}, despertarEn: null, logs: [] }; } } });
    b.inicio();
    expect(b.conectar(0x41, true)).toBe(false);
    b.parada();
    b.inicio();
    expect(b.conectar(0x42, true)).toBe(true);
    b.parada(); // acá falla
    b.inicio();
    expect(b.conectar(0x42, true)).toBe(false);
    b.parada();
    expect(logs.join()).toMatch(/dejó de responder/);
  });

  it('avisa si el maestro va más rápido que lo que soporta el chip', () => {
    const logs: string[] = [];
    const b = new BusChips({ ahoraUs: () => 0, alLog: (l) => logs.push(l) });
    b.agregar({ id: 'lento', chip: 'x', motor: falso().motor, maxHz: 100_000 });
    b.velocidad(400_000);
    expect(logs.join()).toMatch(/hasta 100 kHz/);
  });
});
