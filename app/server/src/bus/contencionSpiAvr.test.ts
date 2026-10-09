import { expect, it } from 'vitest';
import { AvrEmulator } from '../avrEmulator.js';
import { cargarChips } from './catalogoChips.js';
import { entornoDe, type ChipEnBus } from './proyectoChips.js';

it.each(['local', 'worker'] as const)('AVR %s informa contención sin devolver un byte y permite reiniciar con el bus corregido', async modo => {
  const bme = cargarChips().find(c => c.id === 'bosch-bme280');
  if (!bme) throw new Error('Falta BME280');
  const sensor: ChipEnBus = {
    id: 'sensor', instancia: 'sensor', chip: bme.id, nombre: bme.nombre, codigo: bme.codigo,
    props: {}, entorno: entornoDe(bme), alimentado: true, pinesGpio: {}, pullUps: [],
    spi: { csGpio: 10, modos: [0, 3], lsbPrimero: false, soloEscritura: false },
  };
  const interferencia = { ...sensor, id: 'interferencia', instancia: 'interferencia',
    codigo: 'module.exports = { spi: function () { return [0]; } };' };
  const emu = new AvrEmulator({ onLog: () => {}, onState: () => {}, onBridgeMessage: () => {}, onBridgeState: () => {} }, modo);
  const artefactos = {
    firmware: new URL('../fixtures/chips/bme280-spi/bme280-spi.hex', import.meta.url).pathname,
    elf: null, usesWebServer: false, usesApi: false, needsRepl: false,
  };
  try {
    await emu.start('contencion-spi', artefactos, { arranqueMs: 66, chips: [sensor, interferencia] });
    await expect.poll(() => emu.getStatus().state, { timeout: 5000 }).toBe('crashed');
    expect(emu.getStatus()).toMatchObject({ running: false, exitInfo: expect.stringMatching(/contención MISO.*sensor.*interferencia/) });
    expect(emu.getBridge()).toBeNull();
    expect(await emu.depurar({ op: 'estado' })).toMatchObject({ ok: false });
    await emu.stop();
    await emu.start('contencion-spi', artefactos, { arranqueMs: 66, chips: [sensor] });
    await expect.poll(() => emu.getRecentLog().join('\n'), { timeout: 5000 }).toContain('BME280 SPI OK');
    expect(emu.getStatus().running).toBe(true);
  } finally { await emu.shutdown(); }
}, 15_000);
