import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { validarDestinoRf } from './destinoRf.js';
import { enlaceRfDePrueba } from './canalRf.fixture.js';
import { proyectoRfDePrueba, analisisRfDePrueba } from './destinoRf.fixture.js';

let catalogo: ModuloCatalogo[];
beforeAll(async () => { catalogo = await loadCatalog(); });
const buscar = (tipo: string) => catalogo.find(m => m.type === tipo);
const sinAlimentacionConfirmada: (ReturnType<typeof analisisRfDePrueba> | null | undefined)[] = [
  undefined, null, { resuelto: false, modulos: { rx: { ui: { on: true } } } },
  { resuelto: true, modulos: {} }, { resuelto: true, modulos: { rx: {} } },
  { resuelto: true, modulos: { rx: { ui: {} } } }, { resuelto: true, modulos: { rx: { ui: { on: false } } } },
];

describe('destino eléctrico del canal RF declarado', () => {
  it('acepta el receptor único en su placa, con alimentación resuelta, y permite transmisor externo', () => {
    const c = enlaceRfDePrueba(); c.transmisor.id = 'fuera-del-circuito';
    expect(validarDestinoRf(proyectoRfDePrueba(), buscar, 'board', analisisRfDePrueba(), c))
      .toEqual({ permitirRecepcion: true, modo: 'canal-declarado', problemas: [], receptorId: 'rx', gpio: 4 });
  });
  it.each(sinAlimentacionConfirmada)('no sustituye alimentación desconocida/no resuelta por presencia de cables: %j', analisis => {
    const r = validarDestinoRf(proyectoRfDePrueba(), buscar, 'board', analisis, enlaceRfDePrueba());
    expect(r.permitirRecepcion).toBe(false);
    expect(r.problemas.join(' ')).toMatch(/resuelt|alimentaci/i);
  });
  it('VCC conectado a tierra no alimenta aunque todos los terminales tengan cables', () => {
    const p = proyectoRfDePrueba(); p.wires[0] = { from: 'rx.VCC', to: 'board.GND' };
    const r = analisisRfDePrueba(); r.modulos.rx = { ui: { on: false } };
    expect(validarDestinoRf(p, buscar, 'board', r, enlaceRfDePrueba()).permitirRecepcion).toBe(false);
  });
  it.each(['VCC', 'GND', 'DATA'])('rechaza %s desconectado aunque la instantánea anterior diga on', pin => {
    const p = proyectoRfDePrueba(); p.wires = p.wires.filter(w => w.from !== `rx.${pin}`);
    expect(validarDestinoRf(p, buscar, 'board', analisisRfDePrueba(), enlaceRfDePrueba()).permitirRecepcion).toBe(false);
  });
  it.each(['inexistente', 'control'])('exige identidad y rol de receptor: %s', receptorId => {
    const c = enlaceRfDePrueba(); c.receptor.id = receptorId;
    expect(validarDestinoRf(proyectoRfDePrueba(), buscar, 'board', analisisRfDePrueba(), c).permitirRecepcion).toBe(false);
  });
  it('rechaza placa/catálogo ausente en vez de usar el fallback GPIO del modo funcional', () => {
    const p = proyectoRfDePrueba(); p.modules = p.modules.filter(m => m.id !== 'board'); p.board = null; p.language = null;
    expect(validarDestinoRf(p, buscar, 'board', analisisRfDePrueba(), enlaceRfDePrueba()).permitirRecepcion).toBe(false);
    expect(validarDestinoRf(proyectoRfDePrueba(), tipo => tipo === 'rxb6' ? buscar(tipo) : undefined,
      'board', analisisRfDePrueba(), enlaceRfDePrueba()).permitirRecepcion).toBe(false);
  });
  it('rechaza dos receptores de la misma placa, incluso si falta alimentación del segundo', () => {
    const p = proyectoRfDePrueba();
    p.modules.push({ id: 'rx2', type: 'rxb6', props: {}, x: 0, y: 0 });
    p.wires.push({ from: 'rx2.DATA', to: 'board.GPIO5' });
    expect(validarDestinoRf(p, buscar, 'board', analisisRfDePrueba(), enlaceRfDePrueba()).permitirRecepcion).toBe(false);
  });
  it('separa receptores por placa y no permite dirigir a otra placa', () => {
    const p = proyectoRfDePrueba();
    p.boards = ['board', 'segunda'].map(id => ({ id, board: 'esp32-s3-devkitc-1', language: 'esphome' }));
    p.modules.push({ id: 'segunda', type: 'esp32-s3-devkitc-1', props: { usb: true }, x: 0, y: 0 },
      { id: 'rx2', type: 'rxb6', props: {}, x: 0, y: 0 });
    p.wires.push({ from: 'rx2.DATA', to: 'segunda.GPIO4' }, { from: 'rx2.VCC', to: 'segunda.3V3' }, { from: 'rx2.GND', to: 'segunda.GND' });
    const r = analisisRfDePrueba(); r.modulos.rx2 = { ui: { on: true } };
    const c = enlaceRfDePrueba();
    expect(validarDestinoRf(p, buscar, 'board', r, c).permitirRecepcion).toBe(true);
    expect(validarDestinoRf(p, buscar, 'segunda', r, c).permitirRecepcion).toBe(false);
    c.receptor.id = 'rx2';
    expect(validarDestinoRf(p, buscar, 'segunda', r, c)).toMatchObject({ permitirRecepcion: true, receptorId: 'rx2', gpio: 4 });
  });
  it.each([null, {}, { receptor: { id: 'rx' } }])('no convierte un canal inválido en funcional: %j', c => {
    expect(validarDestinoRf(proyectoRfDePrueba(), buscar, 'board', undefined, c))
      .toMatchObject({ permitirRecepcion: false, modo: 'canal-declarado' });
  });
  it('conserva el modo funcional explícito sólo cuando falta canalRf', () => {
    expect(validarDestinoRf(proyectoRfDePrueba(), buscar, 'board', undefined))
      .toEqual({ permitirRecepcion: true, modo: 'funcional', problemas: [] });
  });
});
