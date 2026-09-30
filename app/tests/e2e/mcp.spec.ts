import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import { abrirProyectoNuevo, cable, modulo } from './helpers';

const BASE = 'http://127.0.0.1:5191';

async function clienteMcp(): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  return client;
}

/** Llama una herramienta y devuelve su texto (y si fue error). */
async function llamar(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const texto = (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
  return { texto, error: Boolean(r.isError) };
}

test('expone las herramientas para controlar toda la app', async () => {
  const client = await clienteMcp();
  const { tools } = await client.listTools();
  const nombres = tools.map((t) => t.name);
  for (const n of [
    'estado', 'listar_proyectos', 'crear_proyecto', 'ver_proyecto', 'leer_archivo', 'escribir_archivo',
    'catalogo', 'importar_modulo', 'quitar_modulo_catalogo', 'agregar_modulo', 'quitar_modulo', 'mover_modulo',
    'configurar_modulo', 'conectar', 'desconectar', 'compilar', 'ejecutar', 'parar', 'resetear',
    'accionar_modulo', 'poner_pin', 'enviar_rf', 'leer_pines', 'leer_log', 'esperar_log',
  ]) {
    expect(nombres).toContain(n);
  }
  await client.close();
});

test('lo que hace el agente por MCP se ve en vivo en la UI', async ({ page, request }) => {
  const nombre = await abrirProyectoNuevo(page, request);
  const client = await clienteMcp();

  // Circuito: agrega un receptor RF y lo cablea.
  const agregado = await llamar(client, 'agregar_modulo', { proyecto: nombre, tipo: 'rxb6', x: 260, y: 40 });
  expect(agregado.texto).toContain('Agregado "rx1"');
  expect((await llamar(client, 'conectar', { proyecto: nombre, desde: 'rx1.DATA', hasta: 'GPIO4' })).texto)
    .toContain('rx1.DATA → board.GPIO4');
  await expect(modulo(page, 'rx1')).toBeVisible(); // sin recargar la página
  await expect(cable(page, 'rx1.DATA', 'board.GPIO4')).toHaveCount(1);
  await expect(page.locator('#nota')).toContainText('MCP');
  // El chequeo circuito ↔ código también se actualiza.
  await expect(page.locator('#avisos-dibujo')).toContainText(/pin (GPIO)?4 que el código no usa/);

  // Errores que el agente pueda entender y corregir.
  const malo = await llamar(client, 'conectar', { proyecto: nombre, desde: 'rx1.DATA', hasta: 'GPIO17' });
  expect(malo.error).toBe(true);
  expect(malo.texto).toContain('puente de simulación');
  const pinInexistente = await llamar(client, 'conectar', { proyecto: nombre, desde: 'rx1.ANT', hasta: 'GPIO5' });
  expect(pinInexistente.texto).toContain('Pines: DATA, VCC, GND');

  // Código: el editor se actualiza solo.
  const yaml = (await llamar(client, 'leer_archivo', { proyecto: nombre, ruta: 'main.yaml' })).texto;
  await llamar(client, 'escribir_archivo', { proyecto: nombre, ruta: 'main.yaml', contenido: `${yaml}\n# editado por MCP\n` });
  await expect(page.locator('#editor')).toHaveValue(/# editado por MCP/);

  // Propiedades y quitar.
  await llamar(client, 'configurar_modulo', { proyecto: nombre, id: 'led1', props: { color: 'green' } });
  await llamar(client, 'quitar_modulo', { proyecto: nombre, id: 'rx1' });
  await expect(modulo(page, 'rx1')).toHaveCount(0);

  const visto = JSON.parse((await llamar(client, 'ver_proyecto', { proyecto: nombre })).texto.split('\n').slice(1).join('\n'));
  expect(visto.modulos.find((m: { id: string }) => m.id === 'led1').props.color).toBe('green');
  expect(visto.cables).toContainEqual({ from: 'btn1.OUT', to: 'board.GPIO6' });
  await client.close();
});

test('importar un módulo por MCP aparece en el catálogo de la UI', async ({ page, request }) => {
  await abrirProyectoNuevo(page, request);
  const client = await clienteMcp();
  const nombre = `Chip MCP ${Date.now().toString(36)}`;
  const r = await llamar(client, 'importar_modulo', {
    chip_wokwi: JSON.stringify({ name: nombre, pins: ['A', 'B', 'GND', 'VCC'] }),
    rol: 'input',
    categoria: 'Desde MCP',
  });
  expect(r.error).toBe(false);
  await expect(page.locator('#lista-modulos .cat-header', { hasText: 'Desde MCP' })).toBeVisible();
  await expect(page.locator('.modulo-card', { hasText: nombre })).toBeVisible();
  const tipo = (await llamar(client, 'catalogo', { buscar: nombre })).texto;
  expect(tipo).toContain('"rol": "input"');
  await client.close();
});

test('sin simulación, accionar un módulo explica qué hacer', async ({ request }) => {
  const client = await clienteMcp();
  const r = await llamar(client, 'accionar_modulo', { id: 'btn1', accion: 'pulsar' });
  expect(r.error).toBe(true);
  expect(r.texto).toContain('ejecutá el proyecto primero');
  expect((await llamar(client, 'estado')).texto).toContain('"estado": "stopped"');
  await client.close();
  expect(request).toBeTruthy();
});

test('una página web ajena no puede usar el MCP ni la API', async ({ request }) => {
  const mcp = await request.post('/mcp', {
    headers: { origin: 'https://sitio-malo.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(mcp.status()).toBe(403);
  const api = await request.post('/api/emulator/stop', { headers: { origin: 'https://sitio-malo.example' } });
  expect(api.status()).toBe(403);
  // Rebinding de DNS: un Host que no es el nuestro.
  const host = await request.get('/api/projects', { headers: { host: 'atacante.example:5191' } });
  expect(host.status()).toBe(403);
});
