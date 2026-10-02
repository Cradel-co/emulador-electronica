import { describe, expect, it } from 'vitest';
import {
  BOARD_ID, cablesDe, esPinSinAlimentar, nombreRef, partirRef, pinesSinAlimentar,
} from '../../web/consultas.js';

const LED = { name: 'LED', pins: [{ name: 'IN', kind: 'digital-in' }, { name: 'GND', kind: 'ground' }] };
const RELE = { name: 'Relé', pins: [{ name: 'IN', kind: 'digital-in' }, { name: 'VCC', kind: 'power' }, { name: 'GND', kind: 'ground' }] };
const PLACA = { name: 'ESP32-S3', pins: [{ name: 'GPIO6', kind: 'digital-io' }, { name: 'GND', kind: 'ground' }, { name: 'GND_2', kind: 'ground' }] };
const catalogo: Record<string, any> = { led: LED, relay: RELE, 'esp32-s3-devkitc-1': PLACA };
const def = (t: string) => catalogo[t];

const modules = [
  { id: 'board', type: 'esp32-s3-devkitc-1' },
  { id: 'led1', type: 'led' },
  { id: 'rele1', type: 'relay' },
];
const wires = [
  { from: 'led1.IN', to: 'board.GPIO6' },
  { from: 'led1.GND', to: 'board.GND' },
  { from: 'rele1.IN', to: 'board.GPIO6' },
];

describe('partirRef', () => {
  it('parte en el primer punto', () => {
    expect(partirRef('btn1.OUT')).toEqual({ id: 'btn1', pin: 'OUT' });
    expect(partirRef('led1.IN.extra')).toEqual({ id: 'led1', pin: 'IN.extra' });
  });

  it('null si no hay id o no hay punto', () => {
    expect(partirRef('btn1')).toBeNull();
    expect(partirRef('.OUT')).toBeNull();
    expect(partirRef('')).toBeNull();
  });
});

describe('cablesDe', () => {
  it('encuentra los cables de una punta, sin importar de qué lado esté', () => {
    expect(cablesDe('led1.IN', wires)).toHaveLength(1);
    expect(cablesDe('board.GPIO6', wires)).toHaveLength(2); // el LED y el relé
  });

  it('vacío si la punta está al aire', () => {
    expect(cablesDe('rele1.VCC', wires)).toEqual([]);
    expect(cablesDe('noexiste.X', wires)).toEqual([]);
  });
});

describe('pinesSinAlimentar', () => {
  it('lista los pines de masa y alimentación que quedaron al aire', () => {
    // El relé tiene VCC y GND sin cablear; IN no cuenta porque es de señal.
    expect(pinesSinAlimentar({ id: 'rele1', type: 'relay' }, RELE, wires)).toEqual(['VCC', 'GND']);
  });

  it('vacío si están todos conectados', () => {
    expect(pinesSinAlimentar({ id: 'led1', type: 'led' }, LED, wires)).toEqual([]);
  });

  it('un módulo sin pines no reclama nada', () => {
    expect(pinesSinAlimentar({ id: 'x', type: 'y' }, { pins: [] }, wires)).toEqual([]);
    expect(pinesSinAlimentar({ id: 'x', type: 'y' }, {}, wires)).toEqual([]);
  });
});

describe('esPinSinAlimentar', () => {
  it('es true para un pin de alimentación de un módulo, al aire', () => {
    expect(esPinSinAlimentar('rele1.VCC', modules, def, wires)).toBe(true);
    expect(esPinSinAlimentar('rele1.GND', modules, def, wires)).toBe(true);
  });

  it('es false si está cableado, si es de señal, o si es de la placa', () => {
    expect(esPinSinAlimentar('led1.GND', modules, def, wires)).toBe(false); // cableado
    expect(esPinSinAlimentar('rele1.IN', modules, def, wires)).toBe(false); // de señal
    // La placa se alimenta por USB o por sus pines, no se le reclama el GND.
    expect(esPinSinAlimentar(`${BOARD_ID}.GND_2`, modules, def, wires)).toBe(false);
  });

  it('es false si el módulo o el pin no existen', () => {
    expect(esPinSinAlimentar('noexiste.GND', modules, def, wires)).toBe(false);
    expect(esPinSinAlimentar('rele1.NOEXISTE', modules, def, wires)).toBe(false);
    expect(esPinSinAlimentar('sinpunto', modules, def, wires)).toBe(false);
  });
});

describe('nombreRef', () => {
  it('módulo: nombre del catálogo + id + pin', () => {
    expect(nombreRef('led1.IN', modules, def, 'ESP32-S3')).toBe('LED led1 · IN');
  });

  it('la placa se nombra con su nombre, sin el id', () => {
    expect(nombreRef('board.GPIO6', modules, def, 'ESP32-S3')).toBe('ESP32-S3 · GPIO6');
  });

  it('saca el sufijo _N de los pines repetidos: es para el module.json, no para leerlo', () => {
    expect(nombreRef('board.GND_2', modules, def, 'ESP32-S3')).toBe('ESP32-S3 · GND');
  });

  it('un módulo que no está en el catálogo se nombra por su id', () => {
    expect(nombreRef('fantasma.X', modules, def, 'ESP32-S3')).toBe('fantasma fantasma · X');
  });

  it('una ref sin punto se devuelve tal cual', () => {
    expect(nombreRef('raro', modules, def, 'ESP32-S3')).toBe('raro');
  });
});
