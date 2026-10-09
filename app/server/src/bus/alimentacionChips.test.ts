import { describe, expect, it } from 'vitest';
import { BusChips, type MotorChip } from './busChips.js';
import type { EventoChip } from './chipSandbox.js';

function arnes(spi = false) {
  let t = 0;
  const eventos: EventoChip[] = [];
  const pines: (0 | 1 | null)[] = [];
  const agenda: (() => void)[] = [];
  const motor: MotorChip = {
    correr(es) {
      eventos.push(...es);
      return {
        lecturas: es.filter(e => e.tipo === 'leer' || e.tipo === 'spi').map(() => [0x12]),
        direcciones: [0x40], ocupadoHasta: 0, pines: { INT: 0 as const },
        despertarEn: es.some(e => e.tipo === 'encender') ? t + 100 : null,
        logs: [], ...(es.some(e => e.tipo === 'apagar') ? { guardar: { memoria: 42 } } : {}),
      };
    },
  };
  const bus = new BusChips({ ahoraUs: () => t, alPin: (_id, _pin, nivel) => pines.push(nivel), programar: (_t, fn) => agenda.push(fn) });
  bus.agregar({ id: 'chip', chip: 'falso', motor, ...(spi ? { spi: { csGpio: 2, modos: [0], lsbPrimero: false, soloEscritura: false } } : {}) });
  return { bus, eventos, pines, agenda, avanzar: (dt: number) => { t += dt; } };
}

describe('alimentación dinámica de chips', () => {
  it('el adaptador alimentar de cámaras comparte el lifecycle y vuelve a hacer ACK al restaurar', () => {
    const { bus, eventos } = arnes();
    bus.alimentar('chip', false);
    expect(bus.conectar(0x40, true)).toBe(false);
    bus.alimentar('chip', true);
    expect(bus.conectar(0x40, true)).toBe(true);
    expect(eventos.filter(e => e.tipo === 'encender')).toHaveLength(2);
  });

  it('cortar VCC elimina ACK y libera sus salidas; volver a alimentar invoca encender con memoria guardada', () => {
    const { bus, eventos, pines } = arnes();
    expect(bus.conectar(0x40, true)).toBe(true);
    expect(bus.ponerAlimentacion('chip', false)).toBe(true);
    expect(bus.escribirByte(1)).toBe(false);
    bus.parada();
    expect(bus.conectar(0x40, true)).toBe(false);
    expect(pines.at(-1)).toBe(null);
    expect(bus.ponerAlimentacion('chip', true)).toBe(true);
    expect(bus.conectar(0x40, true)).toBe(true);
    expect(eventos.filter(e => e.tipo === 'encender').at(-1)).toMatchObject({ guardado: { memoria: 42 } });
  });

  it('no reutiliza el buffer de una lectura empezada antes del corte', () => {
    const { bus } = arnes();
    expect(bus.conectar(0x40, false)).toBe(true);
    bus.ponerAlimentacion('chip', false);
    expect(bus.leerByte(false)).toBe(0xff);
  });

  it('un ciclo de alimentación invalida despertadores de la ejecución anterior', () => {
    const { bus, eventos, agenda, avanzar } = arnes();
    const viejo = agenda[0];
    bus.ponerAlimentacion('chip', false);
    bus.ponerAlimentacion('chip', true);
    eventos.length = 0;
    avanzar(100);
    viejo?.();
    expect(eventos).toHaveLength(0);
    agenda.at(-1)?.();
    expect(eventos.map(e => e.tipo)).toEqual(['tick']);
  });

  it('SPI sin VCC no entrega MISO y al restaurarlo reaplica el CS que permanece bajo', () => {
    const { bus } = arnes(true);
    const cfg = { modo: 0, hz: 100_000, lsbPrimero: false };
    bus.pinMcu(2, 0);
    expect(bus.spiByte(1, cfg)).toBe(0x12);
    bus.ponerAlimentacion('chip', false);
    expect(bus.spiByte(1, cfg)).toBe(0xff);
    bus.ponerAlimentacion('chip', true);
    expect(bus.spiByte(1, cfg)).toBe(0x12);
  });

  it('un nivel de alimentación sin cambio no reinicia y un id desconocido no modifica el bus', () => {
    const { bus, eventos } = arnes();
    eventos.length = 0;
    expect(bus.ponerAlimentacion('chip', true)).toBe(true);
    expect(bus.ponerAlimentacion('otro', false)).toBe(false);
    expect(eventos).toHaveLength(0);
  });
});

import { cargarChips } from './catalogoChips.js';
import { PuenteChips } from './puenteChips.js';
import { entornoDe, type ChipEnBus } from './proyectoChips.js';

// La pila del RTC no alimenta su bus ni la EEPROM auxiliar del módulo.
describe('VCC de módulo en el puente MicroPython', () => {
  it('RTC y EEPROM dejan de hacer ACK juntos y conservan la EEPROM al recuperar VCC', () => {
    const catalogo = cargarChips();
    const cs: ChipEnBus[] = ['maxim-ds3231', 'atmel-at24c32'].map((id) => {
      const c = catalogo.find(c => c.id === id);
      if (!c) throw new Error(`Falta chip ${id}`);
      return { id: `rtc:${id}`, instancia: 'rtc', chip: id, nombre: c.nombre, codigo: c.codigo,
        props: {}, entorno: entornoDe(c), alimentado: true, pinesGpio: {}, pullUps: [], i2cGpio: { sda: 4, scl: 5 } };
    });
    const respuestas: string[] = [];
    const p = new PuenteChips(cs, { enviar: l => respuestas.push(l) });
    const scan = (t: number) => { p.recibir(`@I2CS 1 ${t} 4 5 100000`); return respuestas.at(-1); };
    expect(scan(0)).toBe('@I2CR 1 50,68');
    const escritura = Buffer.from([0, 0, 42]).toString('base64');
    p.recibir(`@I2C 2 10000 4 5 100000 W50:${escritura};P`);
    p.actualizarAlimentacion({ rtc: false });
    expect(scan(20000)).toBe('@I2CR 1');
    expect(cs.every(c => !c.alimentado)).toBe(true);
    p.actualizarAlimentacion({ rtc: true });
    expect(scan(30000)).toBe('@I2CR 1 50,68');
    p.recibir('@I2C 3 40000 4 5 100000 W50:AAA=;R50:1;P');
    expect(respuestas.at(-1)).toContain('Kg==');
    p.apagar();
  });
});

import { AvrEmulator } from '../avrEmulator.js';

it('AVR worker recibe el corte y la recuperación mientras el firmware continúa', { timeout: 15_000 }, async () => {
  const rtc = cargarChips().find(c => c.id === 'maxim-ds3231');
  if (!rtc) throw new Error('Falta RTC');
  const guardados: unknown[] = [];
  const emu = new AvrEmulator({ onLog: () => undefined, onState: () => undefined,
    onBridgeMessage: () => undefined, onBridgeState: () => undefined }, 'worker');
  emu.oyenteGuardado = (_id, datos) => guardados.push(datos);
  try {
    await emu.start('alimentacion-test', {
      firmware: new URL('../fixtures/chips/rtc-hora/rtc-hora.hex', import.meta.url).pathname,
      elf: null, usesWebServer: false, usesApi: false, needsRepl: false,
    }, { arranqueMs: 66, chips: [{ id: 'rtc:chip', instancia: 'rtc', chip: rtc.id,
      nombre: rtc.nombre, codigo: rtc.codigo, props: {}, entorno: entornoDe(rtc),
      alimentado: true, pinesGpio: {}, pullUps: [] }] });
    await new Promise(r => setTimeout(r, 200));
    emu.actualizarAlimentacionChips({ rtc: false });
    const limite = Date.now() + 5000;
    while (!guardados.length && Date.now() < limite) await new Promise(r => setTimeout(r, 20));
    expect(guardados).toHaveLength(1); // apagar llegó al sandbox del worker
    expect(emu.chipsEnCorrida()[0]?.alimentado).toBe(false);
    emu.actualizarAlimentacionChips({ rtc: true });
    expect(emu.chipsEnCorrida()[0]?.alimentado).toBe(true);
    await emu.stop();
    expect(guardados).toHaveLength(2); // la recuperación vuelve a ejecutar el ciclo de apagado
  } finally { await emu.shutdown(); }
});
