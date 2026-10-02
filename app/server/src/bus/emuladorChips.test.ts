import { describe, expect, it } from 'vitest';
import { AvrEmulator } from '../avrEmulator.js';
import { cargarChips } from './catalogoChips.js';
import { entornoDe, type ChipEnBus } from './proyectoChips.js';

/**
 * El camino de la app: AvrEmulator (en un worker_thread, como corre de verdad, y en modo local)
 * con un BME280 en el bus, el firmware real de Adafruit, y el entorno movido en vivo por la API
 * (ponerEntorno) sin reiniciar. También: un reset del micro NO apaga el sensor (sigue su estado).
 */

const chip = cargarChips().find((c) => c.id === 'bosch-bme280')!;
const hex = (n: string) => new URL(`../fixtures/chips/${n}/${n}.hex`, import.meta.url).pathname;
const art = (n: string) => ({ firmware: hex(n), elf: null, usesWebServer: false, usesApi: false, needsRepl: false });
const bme = (o: Partial<ChipEnBus> = {}): ChipEnBus => ({
  id: 'bme', instancia: 'bme', chip: chip.id, nombre: 'BME280 (bme)', codigo: chip.codigo, props: { sdo: 'alto' }, pinesGpio: {}, pullUps: [],
  entorno: entornoDe(chip, { temperatura: 18.5 }), alimentado: true, maxHz: chip.i2c?.maxHz, ...o,
});

async function hasta(cond: () => boolean, ms = 45_000): Promise<void> {
  const limite = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > limite) throw new Error('tiempo agotado');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const ultimaT = (log: string[]) => Number(/T=(-?[\d.]+)/.exec(log.filter((l) => l.startsWith('T=')).at(-1) ?? '')?.[1]);

describe.each(['worker', 'local'] as const)('AvrEmulator con chips (modo %s)', { timeout: 120_000 }, (modo) => {
  it('el sketch lee el BME280 y ve el entorno que se mueve en vivo', async () => {
    const log: string[] = [];
    const emu = new AvrEmulator({ onLog: (l) => log.push(l), onState: () => undefined, onBridgeMessage: () => undefined, onBridgeState: () => undefined }, modo);
    await emu.start('t', art('bme280-lectura'), { chips: [bme()], arranqueMs: 66 });
    try {
      await hasta(() => log.includes('BME280 OK') && log.some((l) => l.startsWith('T=')));
      expect(ultimaT(log)).toBeCloseTo(18.5, 1);
      expect(emu.ponerEntorno('bme', { temperatura: 33.3 })).toBe(true);
      expect(emu.ponerEntorno('otro', { temperatura: 1 })).toBe(false);
      await hasta(() => Math.abs(ultimaT(log) - 33.3) < 0.05);
      expect(emu.chipsEnCorrida()[0]).toMatchObject({ id: 'bme', alimentado: true, entorno: { temperatura: 33.3 } });
    } finally {
      await emu.stop();
    }
  });

  it('un chip con código roto no tumba la corrida: se avisa y los demás andan', async () => {
    const log: string[] = [];
    const emu = new AvrEmulator({ onLog: (l) => log.push(l), onState: () => undefined, onBridgeMessage: () => undefined, onBridgeState: () => undefined }, modo);
    await emu.start('t', art('escaner-i2c'), { chips: [bme(), bme({ id: 'roto', instancia: 'roto', codigo: 'esto no es js {{{', props: { sdo: 'bajo' } })], arranqueMs: 66 });
    try {
      await hasta(() => log.some((l) => l.startsWith('encontrados:')));
      expect(log.find((l) => l.startsWith('encontrados:'))).toBe('encontrados: 0x77');
      expect(log.some((l) => /\[i2c\] BME280 \(bme\)/.test(l) && /roto|Unexpected|token/i.test(l))).toBe(true);
    } finally {
      await emu.stop();
    }
  });
});

describe('AvrEmulator con chips: reset del micro (modo worker)', { timeout: 120_000 }, () => {
  it('el reset reinicia el programa pero no el sensor: begin() lo encuentra igual y sigue el entorno', async () => {
    const log: string[] = [];
    const emu = new AvrEmulator({ onLog: (l) => log.push(l), onState: () => undefined, onBridgeMessage: () => undefined, onBridgeState: () => undefined }, 'worker');
    await emu.start('t', art('bme280-lectura'), { chips: [bme()], arranqueMs: 66 });
    try {
      await hasta(() => log.filter((l) => l === 'BME280 OK').length === 1 && log.some((l) => l.startsWith('T=')));
      emu.ponerEntorno('bme', { temperatura: -12 });
      await emu.reset();
      await hasta(() => log.filter((l) => l === 'BME280 OK').length === 2);
      await hasta(() => Math.abs(ultimaT(log) + 12) < 0.05);
    } finally {
      await emu.stop();
    }
  });
});
