import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { ProjectSchema, salidaDesdeFisica, firmaDiagramaElectrico, type Project, type ObservacionElectrica } from '@emu/shared';
import { analizarCircuito, type DireccionPin } from './sim/analisis.js';
import { estadoAlimentacion } from './estadoAlimentacion.js';
import { crearServidorMcp, type McpContexto } from './mcp.js';
import { loadCatalog } from './catalog.js';

const proyecto = ProjectSchema.parse({ schemaVersion: 1, name: 'lectura', board: 'esp32-s3-devkitc-1', language: 'micropython',
  sim: { wifiSsid: 'x', wifiPassword: '' }, modules: [
    { id: 'board', type: 'esp32-s3-devkitc-1', x: 0, y: 0, props: { usb: true } },
    { id: 'led', type: 'led', x: 100, y: 0, props: {} },
  ], wires: [{ from: 'board.GPIO7', to: 'led.IN' }, { from: 'board.GND', to: 'led.GND' }] });

async function conCliente(electrico: unknown, accion: (cliente: Client) => Promise<void>, p: Project = proyecto) {
  const catalogo = await loadCatalog();
  const servidor = crearServidorMcp({ store: { read: async () => p, listFiles: async () => [] },
    catalogo: async () => catalogo, proyectoCorriendo: () => p.name, proyectoEnergizado: () => null,
    estadoEmulador: () => ({ state: 'bridge' }), niveles: () => ({ 7: 1 }),
    pinesYAvisos: async () => ({ pins: [7], warnings: [], electrico }),
  } as unknown as McpContexto);
  const cliente = new Client({ name: 'lectura-electrica', version: '1' });
  const [local, remoto] = InMemoryTransport.createLinkedPair();
  await servidor.connect(remoto); await cliente.connect(local);
  try { await accion(cliente); } finally { await cliente.close(); await servidor.close(); }
}

async function llamar(cliente: Client, nombre: string, argumentos = {}) {
  const respuesta = await cliente.callTool({ name: nombre, arguments: argumentos });
  const contenido = respuesta.content as { type: string; text: string }[];
  const texto = contenido[0]?.text ?? '';
  expect(respuesta.isError, texto).not.toBe(true);
  return JSON.parse(texto.slice(texto.indexOf('\n') + 1));
}

const lectura = (resuelto: boolean, mA?: number) => ({ resuelto, estado: resuelto ? 'valida' : 'no-resuelta',
  contexto: { proyecto: proyecto.name, placas: ['board'], corrida: 1, revision: 'fixture', topologia: firmaDiagramaElectrico(proyecto) },
  nivelesPorPlaca: { board: { 7: 0 } }, leds: mA === undefined ? [] : [{ id: 'led', mA, mAFijo: mA, estado: 'ok' }],
  fuentes: [], placa: null, placas: {}, energizado: false, tensiones: {}, mediciones: [], modulos: {}, sonidos: [] });

it.each([
  ['activo en LOW', true, 8, true],
  ['entre GPIO equipotenciales', true, 0, false],
  ['sin energía aunque el GPIO sea HIGH', true, 0, false],
  ['solver fallido', false, 8, null],
  ['módulo sin observación', true, undefined, null],
] as const)('leer_pines usa la física: %s', async (_caso, resuelto, mA, esperado) => {
  const electrico = lectura(resuelto, mA);
  await conCliente(electrico, async cliente => {
    const r = await llamar(cliente, 'leer_pines');
    expect(r.modulosDeSalida.find((m: { id: string }) => m.id === 'led')?.encendido).toBe(esperado);
    expect(r.electrico).toEqual(electrico);
    expect(r.proyecto).toBe(proyecto.name);
  });
});

it('ver_proyecto conserva la observación y sus medidas, con contexto de placa', async () => {
  const electrico = lectura(true, 8);
  await conCliente(electrico, async cliente => {
    expect((await llamar(cliente, 'ver_proyecto', { proyecto: proyecto.name })).electrico).toEqual(electrico);
  });
});

it.each([
  ['activo bajo', true, true, 0, 0, true],
  ['GPIO opuestos', false, true, 1, 0, true],
  ['GPIO equipotenciales', false, true, 1, 1, false],
  ['GPIO HIGH sin alimentación', false, false, 1, 0, false],
] as const)('el motor real, MCP y UI coinciden: %s', async (_caso, bajo, usb, gpio7, gpio8, encendido) => {
  const p = structuredClone(proyecto);
  const board = p.modules.find(m => m.id === 'board');
  if (!board) throw new Error('Falta la placa');
  board.props.usb = usb;
  p.modules.push({ id: 'r', type: 'resistor', x: 50, y: 0, props: { ohms: 220 } });
  p.wires = [{ from: bajo ? 'board.3V3' : 'board.GPIO7', to: 'r.1' },
    { from: 'r.2', to: 'led.IN' }, { from: 'led.GND', to: bajo ? 'board.GPIO7' : 'board.GPIO8' }];
  const cat = await loadCatalog();
  const resultado = await analizarCircuito(p, tipo => cat.find(m => m.type === tipo), {
    nivelesReales: true, niveles: new Map([[7, gpio7], [8, gpio8]]),
    direcciones: new Map<number, DireccionPin>([[7, { salida: true }], [8, { salida: true }]]),
  });
  expect(resultado.resuelto).toBe(true);
  const electrico: ObservacionElectrica = {
    ...lectura(true), leds: resultado.leds, fuentes: resultado.fuentes, tensiones: resultado.tensiones,
    placa: estadoAlimentacion(resultado.alimentacion),
    modulos: Object.fromEntries(Object.entries(resultado.modulos).map(([id, m]) => [id, m.ui ?? {}])),
    contexto: { ...lectura(true).contexto, topologia: firmaDiagramaElectrico(p) },
    estado: 'valida', nivelesPorPlaca: { board: { 7: gpio7, 8: gpio8 } },
  };
  const led = resultado.leds.find(l => l.id === 'led');
  expect(led).toBeDefined();
  expect(salidaDesdeFisica({ valida: true, led })).toBe(encendido);
  await conCliente(electrico, async cliente => {
    const r = await llamar(cliente, 'leer_pines', { proyecto: p.name });
    expect(r.modulosDeSalida.find((m: { id: string }) => m.id === 'led').encendido).toBe(encendido);
    expect(r.electrico.tensiones).toEqual(resultado.tensiones);
    // JSON representa -0 como 0; la corriente física sigue siendo idéntica.
    expect(r.modulosDeSalida.find((m: { id: string }) => m.id === 'led').corrienteMa).toBe(led?.mA || 0);
  }, p);
});

it('GPIO con el mismo número en placas distintas conservan su identidad con el motor real', async () => {
  const p = structuredClone(proyecto);
  p.boards = [{ id: 'board', board: 'esp32-s3-devkitc-1', language: 'micropython' },
    { id: 'aux', board: 'esp32-s3-devkitc-1', language: 'micropython' }];
  p.modules.push({ id: 'aux', type: 'esp32-s3-devkitc-1', x: 300, y: 0, props: { usb: true } },
    { id: 'r', type: 'resistor', x: 50, y: 0, props: { ohms: 220 } });
  p.wires = [{ from: 'board.GPIO7', to: 'r.1' }, { from: 'r.2', to: 'led.IN' },
    { from: 'led.GND', to: 'aux.GPIO7' }, { from: 'board.GND', to: 'aux.GND' }];
  const cat = await loadCatalog();
  for (const nivelAux of [0, 1] as const) {
    const nivelesPorPlaca = new Map([['board', new Map<number, 0 | 1>([[7, 1]])], ['aux', new Map<number, 0 | 1>([[7, nivelAux]])]]);
    const direccionesPorPlaca = new Map(['board', 'aux'].map(id => [id, new Map<number, DireccionPin>([[7, { salida: true }]])]));
    const resultado = await analizarCircuito(p, tipo => cat.find(m => m.type === tipo), { nivelesReales: true, nivelesPorPlaca, direccionesPorPlaca });
    expect(resultado.resuelto).toBe(true);
    const electrico = { ...lectura(true), leds: resultado.leds,
      contexto: { ...lectura(true).contexto, placas: ['board', 'aux'], topologia: firmaDiagramaElectrico(p) },
      nivelesPorPlaca: { board: { 7: 1 }, aux: { 7: nivelAux } } };
    await conCliente(electrico, async cliente => {
      const r = await llamar(cliente, 'leer_pines');
      expect(r.nivelesPorPlaca).toEqual(electrico.nivelesPorPlaca);
      expect(r.niveles).toEqual({ 7: 1 });
      expect(r.modulosDeSalida.find((m: { id: string }) => m.id === 'led').encendido).toBe(nivelAux === 0);
    }, p);
  }
});

it.each(['proyecto', 'topologia'] as const)('MCP no publica una observación con %s ajeno al circuito consultado', async campo => {
  const electrico = lectura(true, 8);
  electrico.contexto[campo] = 'ajeno';
  await conCliente(electrico, async cliente => {
    for (const tool of ['leer_pines', 'ver_proyecto']) {
      const r = await llamar(cliente, tool, { proyecto: proyecto.name });
      expect(r.electrico).toMatchObject({ estado: 'obsoleta', resuelto: false, leds: [], tensiones: {}, nivelesPorPlaca: {} });
    }
  });
});
