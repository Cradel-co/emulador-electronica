import { describe, expect, it } from 'vitest';
import { BusChips, type OpcionesDispositivo } from './busChips.js';
import { SandboxChip, type EventoChip } from './chipSandbox.js';

const cfg = { modo: 0, lsbPrimero: false, hz: 1e6, misoGpio: 13 };

function preparar() {
  const bus = new BusChips({ ahoraUs: () => 0 });
  const recibidos = new Map<string, EventoChip[]>();
  const agregar = (id: string, csGpio: number, respuesta: number | undefined, opciones: Partial<OpcionesDispositivo> = {}) => {
    const eventos: EventoChip[] = [];
    recibidos.set(id, eventos);
    bus.agregar({
      id, chip: 'prueba-spi',
      motor: { correr: lote => {
        eventos.push(...lote);
        return {
          lecturas: lote.filter(e => e.tipo === 'spi').map(() => respuesta === undefined ? [] : [respuesta]),
          direcciones: [], ocupadoHasta: 0, pines: {}, despertarEn: null, logs: [],
        };
      } },
      spi: { csGpio, miso: 13, modos: [0], lsbPrimero: false, soloEscritura: false },
      ...opciones,
    });
  };
  return { bus, agregar, recibidos };
}

describe('contención parcial de MISO en SPI', () => {
  it('rechaza bits opuestos, sin convertirlos al AND válido de I2C, y entrega MOSI a todos', () => {
    const { bus, agregar, recibidos } = preparar();
    agregar('sensor-a', 10, 0xf0);
    agregar('sensor-b', 9, 0x0f);
    agregar('sensor-c', 8, 0xf0);
    for (const cs of [10, 9, 8]) bus.pinMcu(cs, 0);
    expect(() => bus.spiByte(0x5a, cfg)).toThrowError(expect.objectContaining({
      name: 'ErrorContencionSpi', codigo: 'CONTENCION_MISO',
      dispositivos: ['sensor-a', 'sensor-b', 'sensor-c'], bitsEnConflicto: 0xff,
    }));
    for (const eventos of recibidos.values()) expect(eventos.filter(e => e.tipo === 'spi')).toEqual([
      { tipo: 'spi', t: 0, mosi: [0x5a], dc: [1] },
    ]);
    // Soltar el segundo CS permite continuar; la contención no rompe los chips.
    bus.pinMcu(9, 1);
    expect(bus.spiByte(0, cfg)).toBe(0xf0);
  });

  it('0xff emitido por un chip conduce unos y puede contender con un solo bit bajo', () => {
    const { bus, agregar } = preparar();
    agregar('alto', 10, 0xff);
    agregar('bit-bajo', 9, 0xfe);
    bus.pinMcu(10, 0); bus.pinMcu(9, 0);
    expect(() => bus.spiByte(0, cfg)).toThrowError(expect.objectContaining({ bitsEnConflicto: 1 }));
  });

  it('CS independientes conservan cada respuesta, y coincidir en todos los bits no es oposición', () => {
    const { bus, agregar } = preparar();
    agregar('a', 10, 0xa5); agregar('b', 9, 0x5a); agregar('igual-a', 8, 0xa5);
    expect(bus.spiByte(0, cfg)).toBe(0xff);
    bus.pinMcu(10, 0);
    expect(bus.spiByte(0, cfg)).toBe(0xa5);
    bus.pinMcu(10, 1); bus.pinMcu(9, 0);
    expect(bus.spiByte(0, cfg)).toBe(0x5a);
    bus.pinMcu(9, 1); bus.pinMcu(10, 0); bus.pinMcu(8, 0);
    expect(bus.spiByte(0, cfg)).toBe(0xa5);
  });

  it('no cuenta chips sin alimentación, sin respuesta, de solo escritura ni otro MISO', () => {
    const { bus, agregar } = preparar();
    agregar('dato', 10, 0x5a);
    agregar('apagado', 9, 0xa5, { alimentado: false });
    agregar('alta-impedancia', 8, undefined);
    agregar('pantalla', 7, 0xa5, { spi: { csGpio: 7, modos: [0], lsbPrimero: false, soloEscritura: true } });
    agregar('otro-miso', 6, 0xa5, { spi: { csGpio: 6, miso: 14, modos: [0], lsbPrimero: false, soloEscritura: false } });
    for (const cs of [10, 9, 8, 7, 6]) bus.pinMcu(cs, 0);
    expect(bus.spiByte(0, cfg)).toBe(0x5a);
  });

  it.each(['module.exports = {};', 'module.exports = { spi: function () { return []; } };'])(
    'el sandbox conserva la ausencia de respuesta SPI: %s', codigo => {
      const { bus, agregar } = preparar();
      agregar('dato', 10, 0x00);
      agregar('sin-dato', 9, undefined, { motor: new SandboxChip('sin-dato', codigo) });
      bus.pinMcu(10, 0); bus.pinMcu(9, 0);
      expect(bus.spiByte(0, cfg)).toBe(0x00);
      const sandbox = new SandboxChip('sin-dato', codigo);
      expect(sandbox.correr([{ tipo: 'spi', t: 0, mosi: [0, 0], dc: [1, 1] }], {}, {}).lecturas).toEqual([[]]);
    },
  );
});
