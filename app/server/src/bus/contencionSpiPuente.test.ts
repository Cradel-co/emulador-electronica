import { expect, it } from 'vitest';
import { cargarChips } from './catalogoChips.js';
import { entornoDe, type ChipEnBus } from './proyectoChips.js';
import { PuenteChips } from './puenteChips.js';

function chip(id: string, instancia: string, spi: NonNullable<ChipEnBus['spi']>): ChipEnBus {
  const c = cargarChips().find(x => x.id === id);
  if (!c) throw new Error(`Falta el chip ${id} del catálogo`);
  return {
    id: instancia, instancia, chip: id, nombre: c.nombre, codigo: c.codigo, props: {},
    entorno: entornoDe(c), alimentado: true, pinesGpio: {}, pullUps: [], spi,
  };
}

it('la cámara y la TFT conservan CS independientes y la TFT no conduce MISO', () => {
  const chips = [
    chip('arduchip', 'camara', { sck: 12, mosi: 11, miso: 13, csGpio: 10, modos: [0], lsbPrimero: false, soloEscritura: false }),
    chip('sitronix-st7735', 'pantalla', { sck: 12, mosi: 11, csGpio: 14, dcGpio: 15, modos: [0], lsbPrimero: false, soloEscritura: true }),
  ];
  const respuestas: string[] = [], logs: string[] = [], salidas: Record<string, unknown>[] = [];
  const puente = new PuenteChips(chips, {
    enviar: l => respuestas.push(l), alLog: l => logs.push(l), alSalida: (_id, s) => salidas.push(s),
  });
  let t = 0;
  const pin = (gpio: number, valor: 0 | 1) => puente.recibir(`@P ${gpio} ${valor} ${++t}`);
  const spi = (datos: number[]) => {
    puente.recibir(`@SPI 1 ${++t} 12 11 13 1000000 0 0 ${Buffer.from(datos).toString('base64')} 1`);
    return [...Buffer.from(respuestas.at(-1)?.split(' ')[2] ?? '', 'base64')];
  };
  pin(10, 0); expect(spi([0x80, 0x55])).toEqual([0, 0]); pin(10, 1);
  pin(14, 0); pin(15, 0); expect(spi([0x01])).toEqual([0xff]); pin(14, 1);
  expect(salidas.some(s => s.cameraAction === 'capture')).toBe(false);
  // Con ambos CS bajos solo la cámara responde: la TFT recibe MOSI, pero no maneja MISO.
  pin(14, 0); pin(10, 0); expect(spi([0, 0])).toEqual([0, 0x55]); pin(10, 1); pin(14, 1);
  puente.entradaCamara('camara', { tipo: 'configuracion', soportada: true });
  pin(10, 0); spi([0x84, 2]); pin(10, 1);
  expect(salidas.some(s => s.cameraAction === 'capture')).toBe(true);
  expect(logs.join('\n')).not.toMatch(/contención/);
  puente.apagar();
});

it('una escritura sin respuesta avisa contención, y la siguiente transferencia sigue funcionando', () => {
  const config = { sck: 12, mosi: 11, miso: 13, csGpio: 10, modos: [0], lsbPrimero: false, soloEscritura: false };
  const primero = chip('arduchip', 'a', config);
  primero.codigo = 'module.exports = { spi: function () { return [0xf0]; } };';
  const segundo = { ...primero, id: 'b', instancia: 'b', codigo: 'module.exports = { spi: function () { return [0x0f]; } };', spi: { ...config, csGpio: 9 } };
  const respuestas: string[] = [], logs: string[] = [];
  const puente = new PuenteChips([primero, segundo], { enviar: l => respuestas.push(l), alLog: l => logs.push(l) });
  puente.recibir('@P 10 0 1'); puente.recibir('@P 9 0 2');
  // Un pedido mal formado tampoco debe escapar del manejador al intentar responder el error.
  expect(() => puente.recibir('@SPI invalido 3 12 11 13 1000000 0 0 AA== 1')).not.toThrow();
  expect(() => puente.recibir('@SPI 0 3 12 11 13 1000000 0 0 AA== 0')).not.toThrow();
  expect(respuestas).toEqual([]);
  expect(logs.join('\n')).toMatch(/contención MISO.*a.*b/);
  puente.recibir('@P 9 1 4');
  puente.recibir('@SPI 2 5 12 11 13 1000000 0 0 AA== 1');
  expect(respuestas).toEqual(['@SPIR 2 8A==']);
});
