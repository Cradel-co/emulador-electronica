import { describe, expect, it } from 'vitest';
import { BusChips, type MotorChip } from './busChips.js';
import { evaluarI2cRc } from './i2cFisico.js';
import { PuenteChips } from './puenteChips.js';
import { SimConfigSchema } from '@emu/shared';
import { perfilI2cSintetico as perfil } from '../fixtures/perfilI2c.js';
import { AvrEmulator } from '../avrEmulator.js';
import { cargarChips } from './catalogoChips.js';
import { entornoDe } from './proyectoChips.js';

const motor: MotorChip = { correr: () => ({ lecturas: [], direcciones: [0x40], ocupadoHasta: 0, pines: {}, despertarEn: null, logs: [] }) };

describe('el bus funcional respeta el perfil RC declarado', () => {
  it('no entrega ACK con SDA sin pull-up aunque el chip conteste', () => {
    const sinPull = structuredClone(perfil);
    sinPull.sda.resistenciaPullupOhm = null;
    const bus = new BusChips({ ahoraUs: () => 0 }, sinPull);
    bus.agregar({ id: 'sensor', chip: 'sintetico', motor });
    expect(() => { bus.velocidad(100_000); bus.inicio(); bus.conectar(0x40, true); }).toThrow(/pull-up/i);
  });
  it('no acredita un bus con subida demasiado lenta', () => {
    const lento = structuredClone(perfil);
    lento.scl.capacitanciaF = 1e-9;
    const bus = new BusChips({ ahoraUs: () => 0 }, lento);
    bus.agregar({ id: 'sensor', chip: 'sintetico', motor });
    expect(() => { bus.velocidad(100_000); bus.inicio(); bus.conectar(0x40, true); }).toThrow(/subida/i);
  });
  it('conserva ACK cuando el equivalente declarado cumple el dominio', () => {
    const bus = new BusChips({ ahoraUs: () => 0 }, perfil);
    bus.agregar({ id: 'sensor', chip: 'sintetico', motor });
    bus.velocidad(100_000); bus.inicio();
    expect(bus.conectar(0x40, true)).toBe(true);
  });
  it('el máximo del chip también limita el bus y se ignora sólo si no está alimentado', () => {
    const bus = new BusChips({ ahoraUs: () => 0 }, perfil);
    bus.agregar({ id: 'lento', chip: 'sintetico', motor, maxHz: 50_000 });
    expect(() => bus.velocidad(100_000)).toThrow(/lento.*50000/);
    bus.ponerAlimentacion('lento', false);
    expect(() => bus.velocidad(100_000)).not.toThrow();
  });
  it('rechaza frecuencia ausente sin inventar la velocidad, y copia su perfil', () => {
    const copia = structuredClone(perfil);
    const bus = new BusChips({ ahoraUs: () => 0 }, copia);
    expect(() => bus.inicio()).toThrow(/Frecuencia/);
    copia.sda.resistenciaPullupOhm = null;
    expect(() => bus.velocidad(100_000)).not.toThrow();
  });
});

it.each(['local', 'worker'] as const)('TWI real en AVR %s detiene la corrida con diagnóstico eléctrico', async modo => {
  const bme = cargarChips().find(c => c.id === 'bosch-bme280');
  if (!bme) throw new Error('Falta el BME280');
  const sinPull = structuredClone(perfil); sinPull.sda.resistenciaPullupOhm = null;
  const emu = new AvrEmulator({ onLog: () => {}, onState: () => {}, onBridgeMessage: () => {}, onBridgeState: () => {} }, modo);
  try {
    await emu.start('i2c-fisico', {
      firmware: new URL('../fixtures/chips/escaner-i2c/escaner-i2c.hex', import.meta.url).pathname,
      elf: null, usesWebServer: false, usesApi: false, needsRepl: false,
    }, { arranqueMs: 66, chips: [{ id: 'bme', instancia: 'bme', chip: bme.id, nombre: bme.nombre,
      codigo: bme.codigo, props: {}, entorno: entornoDe(bme), alimentado: true, pinesGpio: {}, pullUps: [], i2cFisico: sinPull }] });
    await expect.poll(() => emu.getStatus().state, { timeout: 4000 }).toBe('crashed');
    expect(emu.getStatus().exitInfo).toMatch(/pull-up/);
    expect(emu.getBridge()).toBeNull();
  } finally { await emu.shutdown(); }
}, 10_000);

describe('oráculos del equivalente I2C', () => {
  it('calcula 30–70 % por ln(7/3)·RC y niveles por divisor de tensión', () => {
    const r = evaluarI2cRc(perfil, 100_000);
    expect(r.apto).toBe(true);
    expect(r.lineas.sda?.subidaS).toBeCloseTo(Math.log(7 / 3) * 4700 * 50e-12, 15);
    expect(r.lineas.sda?.bajoV).toBeCloseTo(3.3 * 50 / 4750, 12);
    expect(r.lineas.sda?.corrienteSinkA).toBeCloseTo(3.3 / 4750, 12);
  });
  it.each([
    ['pull-up', { resistenciaPullupOhm: null }],
    ['subida', { capacitanciaF: 1e-9 }],
    ['hundimiento', { resistenciaPullupOhm: 100 }],
    ['VIL', { resistenciaLowOhm: 10_000 }],
    ['VIH', { fugaA: 250e-6 }],
    ['sobretensión', { tensionPullupV: 5 }],
  ])('rechaza %s sin aceptar un ACK como evidencia eléctrica', (problema, campos) => {
    const p = structuredClone(perfil); Object.assign(p.sda, campos);
    const r = evaluarI2cRc(p, 100_000);
    expect(r.apto).toBe(false);
    expect(r.problemas.join(';')).toContain(problema);
  });
  it('el tiempo alto/bajo se comprueba por separado y no sólo la frecuencia', () => {
    const r = evaluarI2cRc({ ...perfil, fraccionSclBaja: 0.9 }, 100_000);
    expect(r.problemas).toContain('scl: tiempo alto insuficiente');
    expect(evaluarI2cRc(perfil, 400_000).problemas.join()).toMatch(/frecuencia/);
    const rapido = structuredClone(perfil); rapido.modo = 'fast';
    rapido.sda.resistenciaLowOhm = rapido.scl.resistenciaLowOhm = 300;
    expect(evaluarI2cRc(rapido, 400_000).apto).toBe(true);
  });
  it('rechaza flancos demasiado rápidos en Fast-mode y capacitancia fuera del modo declarado', () => {
    const rapido = { ...structuredClone(perfil), modo: 'fast' as const };
    expect(evaluarI2cRc(rapido, 400_000).problemas.join()).toMatch(/bajada.*mínimo/);
    rapido.sda.capacitanciaF = 1e-12;
    expect(evaluarI2cRc(rapido, 400_000).problemas.join()).toMatch(/subida.*mínimo/);
    const grande = structuredClone(perfil);
    Object.assign(grande.sda, { resistenciaPullupOhm: 1000, resistenciaLowOhm: 100, capacitanciaF: 600e-12 });
    expect(evaluarI2cRc(grande, 50_000).problemas.join()).toMatch(/capacitancia/);
  });
  it('rechaza datos sin procedencia, no finitos y perfiles ambiguos del proyecto', () => {
    expect(() => evaluarI2cRc({ ...perfil, fuente: '' }, 100_000)).toThrow();
    expect(() => evaluarI2cRc(perfil, NaN)).toThrow();
    const bus = { sda: 21, scl: 22, perfil };
    expect(SimConfigSchema.safeParse({ wifiSsid: 'x', wifiPassword: '', i2cFisico: { board: [bus, bus] } }).success).toBe(false);
  });
  it.each(['sin-pull', 'fuga-fuera-dominio', 'frecuencia-cero'] as const)('propaga %s a MicroPython tanto en scan como en transferencia', caso => {
    const sinPull = structuredClone(perfil);
    if (caso === 'sin-pull') sinPull.sda.resistenciaPullupOhm = null;
    if (caso === 'fuga-fuera-dominio') sinPull.sda.fugaA = 0.001;
    const hz = caso === 'frecuencia-cero' ? 0 : 100_000;
    const respuestas: string[] = [], logs: string[] = [];
    const puente = new PuenteChips([{
      id: 'sensor', instancia: 'sensor', chip: 'sintetico', nombre: 'sensor',
      codigo: 'module.exports={direcciones:[64],leer:function(n){return Array(n).fill(12)}};',
      props: {}, entorno: {}, alimentado: true, pinesGpio: {}, pullUps: [], i2cGpio: { sda: 21, scl: 22 }, i2cFisico: sinPull,
    }], { enviar: l => respuestas.push(l), alLog: l => logs.push(l) });
    try {
      puente.recibir(`@I2CS 1 1 21 22 ${hz}`);
      puente.recibir(`@I2C 2 2 21 22 ${hz} R40:1;P`);
      expect(respuestas).toEqual(['@I2CR 1 E:ELECTRICO_I2C', '@I2CR 2 E:ELECTRICO_I2C']);
      expect(logs.join()).toMatch(/pull-up|dominio|Frecuencia/);
    } finally { puente.apagar(); }
  });
});
