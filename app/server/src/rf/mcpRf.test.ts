import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { crearServidorMcp, type McpContexto } from '../mcp.js';
import { loadCatalog } from '../catalog.js';
import { enlaceRfDePrueba } from './canalRf.fixture.js';
import { validarDestinoRf } from './destinoRf.js';
import { analisisRfDePrueba, proyectoRfDePrueba } from './destinoRf.fixture.js';

it('enviar_rf conserva el perfil funcional identificado y filtra la trama por el umbral configurado', async () => {
  const enviarRf = vi.fn(() => true);
  const servidor = crearServidorMcp({ enviarRf } as unknown as McpContexto);
  const cliente = new Client({ name: 'prueba-rf', version: '1' });
  const [local, remoto] = InMemoryTransport.createLinkedPair();
  await servidor.connect(remoto);
  await cliente.connect(local);
  try {
    const canalRf = enlaceRfDePrueba();
    canalRf.receptor.sensibilidadDbm = -50; // Pr = -61,984 dBm: no alcanza el umbral.
    const bloqueado = await cliente.callTool({ name: 'enviar_rf', arguments: { bits: '1010', protocolo: 1, canalRf } });
    expect(enviarRf).not.toHaveBeenCalled();
    expect(JSON.stringify(bloqueado)).toContain('bajo-umbral');
    canalRf.receptor.sensibilidadDbm = -70;
    const recibido = await cliente.callTool({ name: 'enviar_rf', arguments: { bits: '1010', protocolo: 1, canalRf } });
    expect(enviarRf).toHaveBeenCalledTimes(1);
    expect(enviarRf).toHaveBeenLastCalledWith('1010', 1, canalRf);
    expect(JSON.stringify(recibido)).toContain('friis-espacio-libre');
    canalRf.dominio.sinMultitrayecto = false;
    const fuera = await cliente.callTool({ name: 'enviar_rf', arguments: { bits: '1010', protocolo: 1, canalRf } });
    expect(enviarRf).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fuera)).toContain('fuera-dominio');
    const invalido = await cliente.callTool({ name: 'enviar_rf', arguments: { bits: '1010', protocolo: 1, canalRf: { frecuenciaHz: 433e6 } } });
    expect(invalido.isError).toBe(true);
    expect(enviarRf).toHaveBeenCalledTimes(1);
    const funcional = await cliente.callTool({ name: 'enviar_rf', arguments: { bits: '1110', protocolo: 1 } });
    expect(enviarRf).toHaveBeenLastCalledWith('1110', 1, undefined);
    expect(JSON.stringify(funcional)).toContain('funcional');
  } finally { await cliente.close(); await servidor.close(); }
});

it.each(['enviar_rf', 'accionar_modulo'])('%s conserva el canal al validar destino con la instantánea eléctrica, sin entrega falsa', async herramienta => {
  const catalogo = await loadCatalog(), p = proyectoRfDePrueba();
  const buscar = (tipo: string) => catalogo.find(m => m.type === tipo);
  let analisis: ReturnType<typeof analisisRfDePrueba> | undefined = analisisRfDePrueba();
  const inyectar = vi.fn((_bits: string, _protocolo: number) => true);
  const enviarRf = vi.fn(async (bits: string, protocolo: number, canalRf?: unknown) => {
    const destino = validarDestinoRf(p, buscar, 'board', analisis, canalRf);
    return destino.permitirRecepcion && inyectar(bits, protocolo);
  });
  const servidor = crearServidorMcp({ enviarRf, catalogo: async () => catalogo,
    proyectoCorriendo: () => p.name, proyectoEnergizado: () => null,
    estadoEmulador: () => ({ state: 'bridge' }), store: { read: async () => p } } as unknown as McpContexto);
  const cliente = new Client({ name: 'prueba-destino-rf', version: '1' });
  const [local, remoto] = InMemoryTransport.createLinkedPair();
  await servidor.connect(remoto); await cliente.connect(local);
  try {
    const canalRf = enlaceRfDePrueba();
    if (herramienta === 'enviar_rf') canalRf.transmisor.id = 'externo';
    const pedir = () => cliente.callTool({ name: herramienta, arguments: herramienta === 'enviar_rf'
      ? { bits: '1010', protocolo: 1, canalRf } : { id: 'control', accion: 'boton_A', canalRf } });
    expect((await pedir()).isError).not.toBe(true);
    expect(enviarRf).toHaveBeenLastCalledWith('1010', 1, canalRf);
    expect(inyectar).toHaveBeenCalledTimes(1);
    analisis = undefined;
    expect((await pedir()).isError).toBe(true);
    analisis = analisisRfDePrueba(); analisis.resuelto = false;
    expect((await pedir()).isError).toBe(true);
    analisis = analisisRfDePrueba(); analisis.modulos.rx = { ui: { on: false } };
    p.wires[0] = { from: 'rx.VCC', to: 'board.GND' };
    expect((await pedir()).isError).toBe(true);
    p.wires[0] = { from: 'rx.VCC', to: 'board.3V3' }; analisis = analisisRfDePrueba();
    canalRf.receptor.id = 'control';
    expect((await pedir()).isError).toBe(true);
    canalRf.receptor.id = 'rx';
    p.modules.push({ id: 'rx2', type: 'rxb6', props: {}, x: 30, y: 30 });
    p.wires.push({ from: 'rx2.DATA', to: 'board.GPIO5' });
    expect((await pedir()).isError).toBe(true);
    expect(inyectar).toHaveBeenCalledTimes(1);
  } finally { await cliente.close(); await servidor.close(); }
});

it('accionar_modulo aplica el presupuesto a la pareja declarada y rechaza identidades ajenas al circuito', async () => {
  const enviarRf = vi.fn(() => true);
  const catalogo = await loadCatalog();
  const proyecto = {
    name: 'prueba-rf', board: 'esp32-s3-devkitc-1', language: 'esphome',
    modules: [
      { id: 'board', type: 'esp32-s3-devkitc-1', props: { usb: true }, x: 0, y: 0 },
      { id: 'control', type: 'remote-433', props: { codeA: '1010', protocol: 1 }, x: 10, y: 10 },
      { id: 'rx', type: 'rxb6', props: {}, x: 20, y: 20 },
    ],
    wires: [{ from: 'rx.VCC', to: 'board.3V3' }, { from: 'rx.GND', to: 'board.GND' }, { from: 'rx.DATA', to: 'board.GPIO4' }],
  };
  const contexto = { enviarRf, catalogo: async () => catalogo, proyectoCorriendo: () => proyecto.name,
    proyectoEnergizado: () => null, estadoEmulador: () => ({ state: 'bridge' }), store: { read: async () => proyecto } };
  const servidor = crearServidorMcp(contexto as unknown as McpContexto);
  const cliente = new Client({ name: 'prueba-modulo-rf', version: '1' });
  const [local, remoto] = InMemoryTransport.createLinkedPair();
  await servidor.connect(remoto); await cliente.connect(local);
  try {
    const canalRf = enlaceRfDePrueba(); canalRf.receptor.sensibilidadDbm = -50;
    const pedido = () => cliente.callTool({ name: 'accionar_modulo', arguments: { id: 'control', accion: 'boton_A', canalRf } });
    expect(JSON.stringify(await pedido())).toContain('bajo-umbral');
    expect(enviarRf).not.toHaveBeenCalled();
    canalRf.receptor.sensibilidadDbm = -70;
    expect(JSON.stringify(await pedido())).toContain('friis-espacio-libre');
    expect(enviarRf).toHaveBeenCalledTimes(1);
    canalRf.receptor.id = 'otro-receptor';
    expect((await pedido()).isError).toBe(true);
    canalRf.receptor.id = 'rx'; canalRf.transmisor.id = 'otro-control';
    expect((await pedido()).isError).toBe(true);
    canalRf.transmisor.id = 'control';
    proyecto.modules.push({ id: 'rx2', type: 'rxb6', props: {}, x: 30, y: 30 });
    proyecto.wires.push({ from: 'rx2.VCC', to: 'board.3V3' }, { from: 'rx2.GND', to: 'board.GND' }, { from: 'rx2.DATA', to: 'board.GPIO5' });
    expect((await pedido()).isError).toBe(true);
    expect(enviarRf).toHaveBeenCalledTimes(1);
  } finally { await cliente.close(); await servidor.close(); }
});
