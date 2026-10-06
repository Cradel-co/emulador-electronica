import { beforeAll, expect, it } from 'vitest';
import { ModuleDefSchema, type Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito, type DireccionPin } from './analisis.js';
import { instantaneaOpcionesAnalisis } from './instantaneaOpcionesAnalisis.js';
let catalogo: ModuloCatalogo[];
beforeAll(async () => { catalogo = await loadCatalog(); });
it('la instantánea separa también Set y mapas de niveles y direcciones de una sola placa', () => {
  const originales = { cerrados: new Set(['s']), niveles: new Map<number, 0 | 1>([[7, 1]]), direcciones: new Map([[7, { salida: true, pull: 'up' as const }]]) };
  const copia = instantaneaOpcionesAnalisis(originales);
  originales.cerrados.clear(); originales.niveles.clear(); originales.direcciones.get(7)!.salida = false;
  expect(copia.cerrados?.has('s')).toBe(true);
  expect(copia.niveles?.get(7)).toBe(1);
  expect(copia.direcciones?.get(7)).toEqual({ salida: true, pull: 'up' });
});
const board = 'esp32-s3-devkitc-1';
const proyecto = (): Project => ({ schemaVersion: 1, name: 'instantanea', board, language: 'micropython',
  boards: ['board', 'board2'].map(id => ({ id, board, language: 'micropython' })),
  modules: [{ id: 'board', type: board, x: 0, y: 0, props: { usb: false } }, { id: 'board2', type: board, x: 0, y: 0, props: { usb: true } },
    { id: 'r', type: 'resistor', x: 0, y: 0, props: { ohms: 1000 } }],
  wires: [{ from: 'board2.GPIO7', to: 'r.1' }, { from: 'r.2', to: 'board2.GND' }],
  sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false } });
it('las pasadas de brownout conservan el nivel y la dirección originales aunque cambie el runtime', async () => {
  const niveles = new Map<number, 0 | 1>([[7, 1]]);
  const direccion: DireccionPin = { salida: true };
  const analisis = analizarCircuito(proyecto(), type => catalogo.find(m => m.type === type), {
    nivelesPorPlaca: new Map([['board2', niveles]]), direccionesPorPlaca: new Map([['board2', new Map([[7, direccion]])]]) });
  niveles.set(7, 0);
  direccion.openDrain = true;
  const r = await analisis;
  expect(r.resuelto, JSON.stringify(r.avisos)).toBe(true);
  expect(r.tensiones['r.1']! - r.tensiones['r.2']!).toBeGreaterThan(3);
});
it('observar recibe el estado JSON original aunque el llamador modifique objetos anidados', async () => {
  const def = { ...ModuleDefSchema.parse({ type: 'estado-instantanea', name: 'Estado', category: 'Pruebas', svg: 'x.svg', pins: [] }),
    modeloCodigo: 'module.exports={circuito(){return []},observar(ctx){return {estado:ctx.estado}}}' };
  const p = proyecto();
  p.boards = [p.boards![0]!]; p.modules = [p.modules[0]!]; p.modules[0]!.props.usb = true; p.wires = [];
  p.modules.push({ id: 'm', type: def.type, x: 0, y: 0, props: {} });
  const estado = { datos: { cuenta: 1 } };
  const analisis = analizarCircuito(p, type => type === def.type ? def : catalogo.find(m => m.type === type), { estados: new Map([['m', estado]]) });
  estado.datos.cuenta = 2;
  const r = await analisis;
  expect(r.resuelto, JSON.stringify(r.avisos)).toBe(true);
  expect(r.modulos.m?.estado).toEqual({ datos: { cuenta: 1 } });
});
