import { beforeAll, expect, it } from 'vitest';
import type { Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito, type DireccionPin } from './analisis.js';
let catalogo: ModuloCatalogo[];
beforeAll(async () => { catalogo = await loadCatalog(); });
it('una salida de una placa comunica alto y bajo a la entrada de otra', async () => {
  const board = 'esp32-s3-devkitc-1';
  const p = { schemaVersion: 1, name: 'dos', board, language: 'micropython',
    boards: [{ id: 'board', board, language: 'micropython' }, { id: 'board2', board, language: 'micropython' }],
    modules: ['board', 'board2'].map(id => ({ id, type: board, x: 0, y: 0, props: { usb: true } })),
    wires: [{ from: 'board.GPIO7', to: 'board2.GPIO6' }, { from: 'board.GND', to: 'board2.GND' }],
    sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false } } as Project;
  for (const level of [0, 1] as const) {
    const r = await analizarCircuito(p, type => catalogo.find(m => m.type === type), {
      nivelesPorPlaca: new Map<string, Map<number, 0 | 1>>([['board', new Map([[7, level]])]]),
      direccionesPorPlaca: new Map<string, Map<number, DireccionPin>>([['board', new Map([[7, { salida: true }]])], ['board2', new Map([[6, { salida: false }]])]]),
    });
    expect(r.entradas.find(e => e.boardId === 'board2' && e.gpio === 6)?.nivel).toBe(level);
    expect(r.alimentacionesPorPlaca?.board2?.estado).toBe('ok');
  }
}, 30_000);
it('mantiene niveles de GPIO y alimentación independientes entre placas', async () => {
  const board = 'esp32-s3-devkitc-1';
  const p: Project = { schemaVersion: 1, name: 'independientes', board, language: 'micropython',
    boards: [{ id: 'board', board, language: 'micropython' }, { id: 'board2', board, language: 'micropython' }],
    modules: ['board', 'board2'].map(id => ({ id, type: board, x: 0, y: 0, props: { usb: true } })),
    wires: [{ from: 'board.GPIO7', to: 'board.GPIO6' }, { from: 'board2.GPIO7', to: 'board2.GPIO6' }, { from: 'board.GND', to: 'board2.GND' }],
    sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false } };
  const r = await analizarCircuito(p, type => catalogo.find(m => m.type === type), {
    nivelesPorPlaca: new Map<string, Map<number, 0 | 1>>([['board', new Map([[7, 1]])], ['board2', new Map([[7, 0]])]]),
    direccionesPorPlaca: new Map<string, Map<number, DireccionPin>>(['board', 'board2'].map(id => [id, new Map([[7, { salida: true }], [6, { salida: false }]])])),
  });
  expect(r.entradas.find(e => e.boardId === 'board' && e.gpio === 6)?.nivel).toBe(1);
  expect(r.entradas.find(e => e.boardId === 'board2' && e.gpio === 6)?.nivel).toBe(0);
  p.modules[1]!.props.usb = false;
  const sinUsb = await analizarCircuito(p, type => catalogo.find(m => m.type === type));
  expect(sinUsb.alimentacionesPorPlaca?.board?.estado).toBe('ok');
  expect(sinUsb.alimentacionesPorPlaca?.board2?.estado).not.toBe('ok');
}, 30_000);
it('mide entradas respecto de la tierra de su placa, aunque esté a otra tensión', async () => {
  const board = 'esp32-s3-devkitc-1';
  const p: Project = { schemaVersion: 1, name: 'referencia', board, language: 'micropython',
    boards: [{ id: 'board', board, language: 'micropython' }, { id: 'board2', board, language: 'micropython' }],
    modules: ['board', 'board2'].map(id => ({ id, type: board, x: 0, y: 0, props: { usb: true } })),
    wires: [{ from: 'board.5V', to: 'board2.GND' }, { from: 'board2.GPIO7', to: 'board2.GPIO6' }],
    sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false } };
  const r = await analizarCircuito(p, type => catalogo.find(m => m.type === type), {
    nivelesPorPlaca: new Map([['board2', new Map([[7, 0]])]]),
    direccionesPorPlaca: new Map([['board2', new Map([[7, { salida: true }], [6, { salida: false }]])]]),
  });
  expect(r.tensiones['board2.GND']).toBeGreaterThan(4.9);
  expect(r.entradas.find(e => e.boardId === 'board2' && e.gpio === 6)?.nivel).toBe(0);
  expect(r.alimentacionesPorPlaca?.board2?.estado).toBe('ok');
}, 30_000);
