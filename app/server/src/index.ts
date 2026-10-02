import { promises as fs } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_BOARD,
  lenguajesDe,
  ClientEventSchema,
  LanguageSchema,
  ServerEventSchema,
  tienePlaca,
  type Language,
  type Project,
  type ServerEvent,
} from '@emu/shared';
import { PATHS } from './paths.js';
import { ProjectStore, ProjectError } from './projectStore.js';
import { BuildService, type BuildArtifacts, type BuildError as BuildErrorLike, type BuildResult } from './buildService.js';
import { EmulatorManager, type EmulatorEvents } from './emulator.js';
import type { Emulador } from './emulatorBackend.js';
import { ENGINES } from './engines/index.js';
import { TOOLCHAINS } from './toolchains/index.js';
import { buscarPlaca, listarPlacas, nivelDeclarado, validarPlaca, type Placa } from './boardRegistry.js';
import { esquemaJsonPlaca } from './boardSchema.js';
import { certificar, leerCertificacion, type ReporteCertificacion } from './certificacion.js';
import { invalidarCatalogo, loadCatalog, type ModuloCatalogo } from './catalog.js';
import { ImportError, ModuleInstaller, importar, type OpcionesImportacion, type SolicitudImportacion } from './moduleImporter.js';
import { crearServidorMcp, type McpContexto } from './mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { scanPins, diffDiagramVsCode, direccionesDeCodigo, type DiagramWarning } from './pinScan.js';
import { conPlaca, ponerPlaca, sacarPlaca } from './diagramOps.js';
import { analizarCircuito, type DireccionPin } from './sim/analisis.js';
import { precalentar } from './sim/spice.js';
import type { AlimentacionPlaca, FuenteElectrica, LedElectrico } from './sim/tipos.js';
import { Depurador } from './debug/depurador.js';
import { registrarRutasDepuracion } from './debug/rutas.js';
import { chipsDelProyecto } from './bus/proyectoChips.js';
import { chipPublico, chipsDe, moverEntorno, registrarRutasChips, type CorridaChips, type DepsChips } from './bus/rutasChips.js';
import { cargarChips } from './bus/catalogoChips.js';
import { guardarMemoria, leerMemoria } from './bus/memoriaChips.js';

const PORT = Number(process.env.PORT ?? 5180);
const HOST = process.env.HOST ?? '127.0.0.1'; // por defecto nunca 0.0.0.0 (sección 13)

export interface ServerDeps {
  store: ProjectStore;
  builder: BuildService;
  emulator: Emulador;
}

const logger = Fastify({ logger: false });

const store = new ProjectStore();
const builder = new BuildService();

// --- Estado compartido ------------------------------------------------------

let lastBuild: { project: string; result: BuildResult } | null = null;
let runningProject: string | null = null;

const clients = new Set<WebSocket>();

/** Últimas líneas de compilación (para el MCP; las del emulador las guarda EmulatorManager). */
const logCompilacion: string[] = [];
/** Último nivel de salida reportado por el firmware para cada GPIO. */
const niveles = new Map<number, 0 | 1>();
const oyentesLog = new Set<(line: string) => void>();
const oyentesEstado = new Set<(state: string) => void>();

const instalador = new ModuleInstaller(PATHS.modules);

function logBuild(line: string): void {
  logCompilacion.push(line);
  if (logCompilacion.length > 2000) logCompilacion.shift();
  broadcast({ type: 'build.log', line });
}

/** Espera a que se cumpla algo que avisan los oyentes, con tiempo límite. */
function esperar<T>(oyentes: Set<(x: T) => void>, cumple: (x: T) => boolean, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const oyente = (x: T): void => {
      if (!cumple(x)) return;
      terminar(x);
    };
    const timer = setTimeout(() => terminar(null), timeoutMs);
    function terminar(x: T | null): void {
      clearTimeout(timer);
      oyentes.delete(oyente);
      resolve(x);
    }
    oyentes.add(oyente);
  });
}

/** `line: null` del parser de build → `undefined` del esquema de eventos. */
function eventErrors(errors: BuildErrorLike[]): { line?: number; file?: string; message: string }[] {
  return errors.map((e) => ({
    ...(e.line == null ? {} : { line: e.line }),
    ...(e.file ? { file: e.file } : {}),
    message: e.message,
  }));
}

/** Log del servidor que además va a la consola del cliente. */
function broadcastLog(line: string): void {
  console.log(line);
  const data = JSON.stringify({ type: 'emu.log', line } satisfies ServerEvent);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}

function broadcast(msg: ServerEvent): void {
  const parsed = ServerEventSchema.safeParse(msg);
  if (!parsed.success) {
    // Un evento mal formado no debe caer al cliente ni romper la sesión.
    broadcastLog(`evento inválido: ${parsed.error.message}`);
    return;
  }
  const data = JSON.stringify(parsed.data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// Un motor por familia de chip (registro de placas): esp-emu para los ESP32, avr8js
// para el Arduino Uno. `emulator` es el que está en uso; runProject lo cambia según
// la placa del proyecto. Los eventos son los mismos para los dos.
const eventosEmulador: EmulatorEvents = {
  onLog: (line) => {
    broadcast({ type: 'emu.log', line });
    for (const o of oyentesLog) o(line);
    depurador.alLog(line);
  },
  onState: (status) => {
    if (status.state === 'stopped' || status.state === 'starting') { niveles.clear(); sensados.clear(); }
    depurador.alEstado(status);
    broadcast({ type: 'emu.state', state: status.state, status: { ...status, paused: depurador.pausado() } });
    for (const o of oyentesEstado) o(status.state);
  },
  onBridgeState: (connected) => broadcast({ type: 'bridge.state', connected }),
  onBridgeMessage: (msg) => {
    depurador.alMensajePuente(msg);
    switch (msg.type) {
      case 'READY':
        emulator.markBridgeReady();
        broadcast({ type: 'bridge.ready', version: msg.version });
        // Con el puente listo, el programa lee por primera vez lo que hay en el circuito.
        sensados.clear();
        if (runningProject) void refrescarEntradasDelCircuito(runningProject);
        break;
      case 'OUT':
        niveles.set(msg.pin, msg.level);
        broadcast({ type: 'pin.out', pin: msg.pin, level: msg.level });
        // Un pin que cambia de estado mueve los voltajes del circuito: lo que leen las
        // entradas cableadas a esa red cambia con él.
        if (runningProject) void refrescarEntradasDelCircuito(runningProject);
        break;
      case 'TX':
        broadcast({ type: 'rf.tx', bits: msg.bits, protocol: msg.protocol });
        break;
      case 'PONG':
        broadcast({ type: 'bridge.pong', n: msg.n });
        break;
      case 'ERR':
        broadcast({ type: 'bridge.error', code: msg.code, message: msg.message });
        break;
      default:
        break;
    }
  },
};

/** Una instancia por motor (plugin de engines/), creada la primera vez que se usa. */
const instancias = new Map<string, Emulador>();
function emuladorDe(motor: string): Emulador {
  let e = instancias.get(motor);
  if (!e) {
    const m = ENGINES[motor];
    if (!m) throw new ProjectError(`El motor de emulación "${motor}" no existe en este server.`, 400);
    if (!m.disponible) throw new ProjectError(`El motor de emulación "${motor}" todavía no está implementado.`, 400);
    e = m.crear(eventosEmulador);
    instancias.set(motor, e);
    // Motores con chips en un bus (avr8js): lo que publican (una pantalla, valores) va a la UI.
    const conChips = e as Emulador & { oyenteChips?: ((id: string, salida: Record<string, unknown>) => void) | null };
    if ('oyenteChips' in conChips) {
      conChips.oyenteChips = (id, salida) => {
        if (runningProject) broadcast({ type: 'chip.salida', project: runningProject, id, salida });
      };
    }
    // Memoria no volátil de los chips (EEPROM, la hora con pila): se guarda en el proyecto.
    const conMemoria = e as Emulador & { oyenteGuardado?: ((id: string, datos: unknown) => void) | null };
    if ('oyenteGuardado' in conMemoria) {
      conMemoria.oyenteGuardado = (id, datos) => {
        const p = runningProject;
        if (p) void guardarMemoria(store.projectDir(p), id, datos).catch((err: unknown) => logBuild(`[chips] no se pudo guardar la memoria de ${id}: ${(err as Error).message}`));
      };
    }
  }
  return e;
}
/** El motor en uso (el de la última placa que se ejecutó). Arranca con esp-emu, el de siempre. */
let emulator: Emulador = emuladorDe('esp-emu');

/** Modo debug (debug/, docs/depuracion.md): grabadora + instantánea + depurador por motor, siempre activo. */
const depurador = new Depurador({
  emitir: (e) => broadcast(e as ServerEvent),
  emulador: () => emulator,
  catalogo: loadCatalog,
  leerProyecto: (n) => store.read(n),
  direcciones: async (n) => direccionesDe(await store.read(n)),
});

export { store, builder, emulator };

/** Lo que necesitan la API y el MCP de los chips (bus/rutasChips.ts). */
const depsChips: DepsChips = {
  leer: (n) => store.read(n),
  guardar: (p) => store.save(p),
  catalogo: loadCatalog,
  corrida: (n) => {
    const e = emulator as Emulador & Partial<CorridaChips>;
    return runningProject === n && emulator.getStatus().running && e.chipsEnCorrida && e.ponerEntorno ? (e as Emulador & CorridaChips) : null;
  },
  emitir: (e) => broadcast(e),
};

/**
 * Placa tal como la ve la UI / el MCP: id, nombre, el descriptor completo (`board` del
 * module.json: pines con su número lógico, reservados, advertencias, lenguajes...) y el
 * nivel de soporte (declarado por sus datos y, si se certificó, el comprobado).
 */
async function placaParaUi(p: Placa) {
  return {
    id: p.id,
    nombre: p.nombre,
    descripcion: p.modulo.description ?? null,
    deFabrica: p.modulo.builtin,
    lenguajes: lenguajesDe(p.desc),
    board: p.desc,
    soporte: { declarado: nivelDeclarado(p.desc), certificado: await leerCertificacion(p.id) },
  };
}

/** Certificaciones en curso, por placa (una a la vez por placa). */
const certificando = new Map<string, Promise<ReporteCertificacion>>();

function certificarPlaca(placa: Placa, lenguaje?: Language): Promise<ReporteCertificacion> {
  const enCurso = certificando.get(placa.id);
  if (enCurso) return enCurso;
  const job = certificar(placa, { builder, lenguaje, onLine: logBuild }).finally(() => certificando.delete(placa.id));
  certificando.set(placa.id, job);
  return job;
}

/** Para la API: arranca y no espera (puede tardar minutos la primera vez). */
function certificarEnFondo(placa: Placa, lenguaje?: Language): 'iniciada' | 'ya-en-curso' {
  const ya = certificando.has(placa.id);
  void certificarPlaca(placa, lenguaje).catch((err) => logBuild(`[certificar ${placa.id}] error: ${(err as Error).message}`));
  return ya ? 'ya-en-curso' : 'iniciada';
}

/**
 * La placa del catálogo y los archivos de código con que arranca en un lenguaje (la plantilla
 * de la placa o la de su toolchain). Valida placa ↔ lenguaje.
 */
async function placaConArchivos(board: string, lenguaje: Language) {
  const placa = await buscarPlaca(board);
  if (!placa) {
    const ids = (await listarPlacas()).map((p) => p.id).join(', ');
    throw new ProjectError(`Placa desconocida: "${board}". Placas: ${ids}`, 400);
  }
  const destino = placa.desc.languages[lenguaje];
  if (!destino) {
    throw new ProjectError(
      `${placa.nombre} no se puede programar en ${lenguaje}. Lenguajes de esta placa: ${lenguajesDe(placa.desc).join(', ')}.`,
      400,
    );
  }
  const propia = placa.desc.templates[lenguaje]?.files;
  const archivos =
    propia && Object.keys(propia).length > 0
      ? propia
      : (TOOLCHAINS[destino.toolchain]?.plantilla(lenguaje, placa, destino.options) ?? {});
  return { placa, archivos };
}

/**
 * Crea un proyecto: con placa (valida placa ↔ lenguaje y escribe su plantilla de código), sin
 * placa (`board: null`: solo un circuito con una fuente regulable), o desde una plantilla.
 */
async function crearProyecto(nombre: string, lenguaje: Language | null, board: string | null = DEFAULT_BOARD, plantilla?: string): Promise<Project> {
  // Desde una plantilla (projects/_template/<id>/): placa, lenguaje, circuito y código salen de ella.
  if (plantilla) {
    const datos = (await store.listTemplates()).find((t) => t.id === plantilla);
    if (!datos) throw new ProjectError(`No hay una plantilla "${plantilla}" en projects/_template/`, 404);
    if (datos.board && !(await buscarPlaca(datos.board))) {
      throw new ProjectError(`La plantilla "${plantilla}" usa la placa "${datos.board}", que no está en el catálogo.`, 400);
    }
    return store.createFromTemplate(nombre, plantilla);
  }
  if (board === null) return store.crearSinPlaca(nombre);
  if (!lenguaje) throw new ProjectError('Falta el lenguaje de la placa', 400);
  const { placa, archivos } = await placaConArchivos(board, lenguaje);
  return store.create(nombre, lenguaje, { id: placa.id, desc: placa.desc }, archivos);
}

/**
 * Agrega una placa a un proyecto sin placa (la placa es un módulo que se agrega y se quita):
 * la pone en el dibujo y escribe su código inicial sin pisar el que ya hubiera de antes.
 */
async function agregarPlaca(nombre: string, board: string, lenguaje: Language, pos: { x?: number; y?: number } = {}): Promise<Project> {
  const { placa, archivos } = await placaConArchivos(board, lenguaje);
  const def = (await loadCatalog()).find((m) => m.type === placa.id);
  if (!def) throw new ProjectError(`La placa "${board}" no está en el catálogo`, 400);
  const actual = await store.read(nombre);
  const puesta = ponerPlaca(actual, def, lenguaje, pos);
  // Al incorporar el procesador queda activa la recarga al guardar: es la razón de ser
  // del campo, y un proyecto recién armado es justo donde se edita el código a cada rato.
  const nuevo = { ...puesta, sim: { ...puesta.sim, autoReload: true } };
  // Con placa, ▶ vuelve a significar "correr el firmware": el circuito deja de estar energizado aparte.
  if (proyectoEnergizado === nombre) energizar(nombre, false);
  await store.escribirSiFalta(nombre, lenguaje, archivos);
  const guardado = await store.save(nuevo);
  return guardado;
}

/** Quita la placa (y sus cables). El código queda en disco: si se vuelve a poner la placa, sigue ahí. */
async function quitarPlaca(nombre: string): Promise<Project> {
  const actual = await store.read(nombre);
  if (runningProject === nombre && emulator.getStatus().running) {
    eventosEmulador.onLog('[placa] Se quitó la placa: se detuvo la simulación.');
    await emulator.stop();
    runningProject = null;
    controlesCerrados.clear();
  }
  placasQuemadas.delete(nombre);
  return store.save(sacarPlaca(actual));
}

// --- Utilidades -------------------------------------------------------------

function fail(reply: { code: (n: number) => { send: (b: unknown) => void } }, err: unknown): void {
  // ProjectError, ImportError y DiagramError traen su código HTTP.
  const codigo = (err as { statusCode?: unknown })?.statusCode;
  const status = err instanceof ProjectError ? err.statusCode : typeof codigo === 'number' ? codigo : 500;
  const message = err instanceof Error ? err.message : String(err);
  reply.code(status).send({ error: message });
}

async function requireProject(name: string) {
  const project = await store.read(name);
  return project;
}

// --- Rutas ------------------------------------------------------------------

async function registerRoutes(): Promise<void> {
  const app = logger;

  app.addHook('onRequest', async (req, reply) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!origenPermitido(origin, req.headers.host)) {
      return reply.code(403).send({ error: 'Origen no permitido' });
    }
  });

  app.get('/api/health', async () => ({ ok: true, port: PORT }));

  // Registro de placas: sale del catálogo (módulos programables con bloque `board`).
  app.get('/api/boards', async () => ({
    porDefecto: DEFAULT_BOARD,
    motores: Object.values(ENGINES).map((m) => ({ nombre: m.nombre, descripcion: m.descripcion, disponible: m.disponible })),
    toolchains: Object.values(TOOLCHAINS).map((t) => ({ nombre: t.nombre, descripcion: t.descripcion, disponible: t.disponible, lenguajes: t.lenguajes })),
    boards: await Promise.all((await listarPlacas()).map(placaParaUi)),
  }));

  app.get('/api/boards/schema', async () => esquemaJsonPlaca());

  // Valida un module.json de placa sin instalarlo (el importador instala; esto solo revisa).
  app.post('/api/boards/validate', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as { module?: unknown };
    const r = validarPlaca(body.module ?? req.body);
    reply.code(r.ok ? 200 : 400).send(r);
  });

  // Certificación: compila y emula la plantilla de la placa, y prueba botón → LED.
  app.post('/api/boards/:id/certify', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { language?: string };
    try {
      const placa = await buscarPlaca(id);
      if (!placa) {
        reply.code(404).send({ error: `No hay una placa "${id}" en el catálogo` });
        return;
      }
      const lenguaje = body.language ? (LanguageSchema.parse(body.language) as Language) : undefined;
      const job = certificarEnFondo(placa, lenguaje);
      reply.code(202).send({ started: true, estado: job });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.get('/api/boards/:id/certification', async (req, reply) => {
    const { id } = req.params as { id: string };
    const enCurso = certificando.get(id);
    reply.send({ enCurso: Boolean(enCurso), ultimo: await leerCertificacion(id) });
  });

  app.get('/api/modules', async () => ({ modules: await loadCatalog() }));

  registrarRutasChips(app, depsChips, fail);

  // Importador de módulos (carpeta, zip, chip de Wokwi, URL / GitHub).
  app.post('/api/modules/import', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown> & OpcionesImportacion;
    try {
      const solicitud = solicitudDe(body);
      const resultado = await importarModulos(solicitud, body);
      reply.code(resultado.importados.length === 0 && resultado.errores.length > 0 ? 400 : 200).send(resultado);
    } catch (err) {
      fail(reply, err);
    }
  });

  app.delete('/api/modules/:type', async (req, reply) => {
    const { type } = req.params as { type: string };
    try {
      await quitarDelCatalogo(type);
      reply.send({ ok: true });
    } catch (err) {
      fail(reply, err);
    }
  });

  // MCP (Streamable HTTP, sin sesión): control completo de la app para agentes.
  app.post('/mcp', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const server = crearServidorMcp(contextoMcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (err as Error).message }, id: null }));
      }
    }
  });
  // Sin sesiones no hay stream de notificaciones (GET) ni cierre de sesión (DELETE).
  const sinSesion = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }): Promise<void> => {
    reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Método no permitido (MCP sin sesión: usar POST)' }, id: null });
  };
  app.get('/mcp', sinSesion);
  app.delete('/mcp', sinSesion);

  app.get('/api/projects', async () => ({ projects: await store.list() }));

  // Proyectos plantilla (projects/_template/<id>/), para "Nuevo proyecto".
  app.get('/api/templates', async () => store.listTemplates());

  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; language?: string; board?: string | null; template?: string };
    try {
      // board: null = proyecto sin placa (solo circuito). Sin board = ESP32-S3, como siempre.
      const project = body.template
        ? await crearProyecto(String(body.name ?? ''), null, null, String(body.template))
        : body.board === null
          ? await crearProyecto(String(body.name ?? ''), null, null)
          : await crearProyecto(String(body.name ?? ''), LanguageSchema.parse(body.language) as Language, body.board ?? DEFAULT_BOARD);
      reply.code(201).send({ project });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.get('/api/projects/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      const project = await requireProject(name);
      const files = await store.listFiles(name, project.language);
      const placa = project.board ? await buscarPlaca(project.board) : undefined;
      reply.send({ project, files, placa: placa ? await placaParaUi(placa) : null });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.delete('/api/projects/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      await store.delete(name);
      reply.send({ ok: true });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.put('/api/projects/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      const project = await requireProject(name);
      const body = (req.body ?? {}) as Partial<Project>;
      // La placa y el lenguaje se eligen al crear el proyecto: sus archivos (sdkconfig,
      // CMake, plantilla) dependen de eso, y cambiarlos a mano dejaría un proyecto que no compila.
      if (body.board !== undefined && body.board !== project.board) {
        reply.code(400).send({ error: 'La placa se elige al crear el proyecto: creá uno nuevo para otra placa.' });
        return;
      }
      if (body.language !== undefined && body.language !== project.language) {
        reply.code(400).send({ error: 'El lenguaje se elige al crear el proyecto.' });
        return;
      }
      const updated = await store.save({ ...project, ...body });
      reply.send({ project: updated });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.get('/api/projects/:name/files/*', async (req, reply) => {
    const { name } = req.params as { name: string };
    const file = (req.params as Record<string, string>)['*'] ?? '';
    try {
      const project = await requireProject(name);
      const content = await store.readFile(name, file, project.language);
      reply.send({ path: file, content });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.put('/api/projects/:name/files/*', async (req, reply) => {
    const { name } = req.params as { name: string };
    const file = (req.params as Record<string, string>)['*'] ?? '';
    const body = (req.body ?? {}) as { content?: string };
    try {
      const project = await requireProject(name);
      await store.writeFile(name, file, project.language, String(body.content ?? ''));
      broadcast({ type: 'project.changed', project: name, what: 'file', file, origin: clienteDe(req) });
      // No se espera: guardar tiene que contestar al toque, la recarga va por la consola.
      agendarAutoReload(project);
      reply.send({ ok: true, path: file });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.delete('/api/projects/:name/files/*', async (req, reply) => {
    const { name } = req.params as { name: string };
    const file = (req.params as Record<string, string>)['*'] ?? '';
    try {
      const project = await requireProject(name);
      await store.deleteFile(name, file, project.language);
      reply.send({ ok: true });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.put('/api/projects/:name/diagram', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      const project = await requireProject(name);
      const body = (req.body ?? {}) as { modules?: unknown[]; wires?: unknown[] };
      const updated = await store.save({
        ...project,
        modules: (body.modules ?? project.modules) as never,
        wires: (body.wires ?? project.wires) as never,
      });
      await revisarAlimentacion(name);
      broadcast({ type: 'project.changed', project: name, what: 'diagram', origin: clienteDe(req) });
      reply.send({ project: updated });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.post('/api/projects/:name/build', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      const project = await requireProject(name);
      if (builder.isBuilding(name)) {
        reply.code(409).send({ error: 'Ya hay una compilación en curso para este proyecto.' });
        return;
      }
      reply.send({ started: true });
      void runBuild(project);
    } catch (err) {
      fail(reply, err);
    }
  });

  // Pulsador apretado / llave encendida: el motor eléctrico los trata como un cable.
  app.post('/api/projects/:name/controls', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      await requireProject(name);
      const body = (req.body ?? {}) as { id?: unknown; cerrado?: unknown };
      if (typeof body.id !== 'string' || typeof body.cerrado !== 'boolean') throw new Error('hace falta { id, cerrado }');
      await fijarControl(name, body.id, body.cerrado);
      reply.send({ ok: true });
    } catch (err) {
      fail(reply, err);
    }
  });

  // Proyecto sin placa: prender/apagar el circuito (▶/⏹). Con placa, ▶ es /run.
  app.post('/api/projects/:name/energia', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      const p = await requireProject(name);
      if (p.board) throw new ProjectError('Este proyecto tiene placa: se ejecuta con /run', 400);
      const body = (req.body ?? {}) as { encendido?: unknown };
      if (typeof body.encendido !== 'boolean') throw new ProjectError('hace falta { encendido }', 400);
      energizar(name, body.encendido);
      reply.send({ ok: true, energizado: proyectoEnergizado === name });
    } catch (err) {
      fail(reply, err);
    }
  });

  // La placa es un módulo que se agrega (eligiendo su lenguaje) y se quita.
  app.post('/api/projects/:name/board', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      await requireProject(name);
      const body = (req.body ?? {}) as { board?: unknown; language?: unknown; x?: unknown; y?: unknown };
      const lenguaje = LanguageSchema.safeParse(body.language);
      if (typeof body.board !== 'string' || !lenguaje.success) {
        throw new ProjectError('hace falta { board, language }: la placa se agrega eligiendo en qué se programa', 400);
      }
      const pos = { x: typeof body.x === 'number' ? body.x : undefined, y: typeof body.y === 'number' ? body.y : undefined };
      const project = await agregarPlaca(name, body.board, lenguaje.data, pos);
      broadcast({ type: 'project.changed', project: name, what: 'diagram', origin: clienteDe(req) });
      reply.send({ project });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.delete('/api/projects/:name/board', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      await requireProject(name);
      const project = await quitarPlaca(name);
      broadcast({ type: 'project.changed', project: name, what: 'diagram', origin: clienteDe(req) });
      reply.send({ project });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.post('/api/projects/:name/board/replace', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      await requireProject(name);
      const habia = reemplazarPlaca(name);
      broadcast({ type: 'project.changed', project: name, what: 'diagram', origin: clienteDe(req) });
      reply.send({ ok: true, estabaQuemada: habia });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.post('/api/projects/:name/run', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      const project = await requireProject(name);
      const body = (req.body ?? {}) as { forceBuild?: boolean };
      reply.send({ started: true });
      void runProject(project, body.forceBuild !== false);
    } catch (err) {
      fail(reply, err);
    }
  });

  registrarRutasDepuracion(app, depurador);

  app.get('/api/emulator', async () => ({
    status: { ...emulator.getStatus(), paused: depurador.pausado() },
    running: runningProject,
    lastBuild,
    recentLog: emulator.getRecentLog(120),
    // Niveles de salida y controles cerrados que el server ya conoce. `pin.out` y los eventos de
    // control solo viajan cuando algo *cambia*, así que un cliente que se (re)conecta no tiene otra
    // forma de saber cómo está el circuito ahora: sin esto, un LED encendido antes de la caída del
    // WebSocket queda pintado encendido para siempre (issue #8).
    niveles: Object.fromEntries(niveles),
    cerrados: runningProject ? [...cerradosDe(runningProject)] : [],
  }));

  app.post('/api/emulator/stop', async (req, reply) => {
    await emulator.stop();
    runningProject = null;
    controlesCerrados.clear();
    if (proyectoEnergizado) energizar(proyectoEnergizado, false);
    reply.send({ ok: true });
  });

  app.post('/api/projects/:name/reload', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      await requireProject(name);
      const r = await recargarCodigo(name);
      reply.send(r);
    } catch (err) {
      fail(reply, err);
    }
  });

  app.post('/api/emulator/reset', async (req, reply) => {
    try {
      const out = await emulator.reset();
      reply.send({ ok: true, output: out });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.get('/api/projects/:name/pins', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      const project = await requireProject(name);
      reply.send(await avisosDelProyecto(project));
    } catch (err) {
      fail(reply, err);
    }
  });

  // Frontend estático (web/index.html)
  // La UI se compila desde app/web/*.ts a web/dist/ con tsc. Si nunca se compiló, la API
  // funciona igual pero el navegador pide /dist/app.js y recibe un 404 mudo: avisamos acá.
  try {
    await fs.access(path.join(PATHS.web, 'dist', 'app.js'));
  } catch {
    console.warn('[web] Falta web/dist/. Corré `npm run build:web` (o `npm run dev` para recompilar solo).');
  }
  await app.register(fastifyStatic, {
    root: PATHS.web,
    prefix: '/',
    index: ['index.html'],
    // Sirve solo dentro de web/: sin traversal.
    list: false,
  });
}

// --- Orquestación -----------------------------------------------------------

async function runBuild(project: { name: string }): Promise<BuildResult> {
  const full = await store.read(project.name);
  broadcast({ type: 'build.start', project: full.name });
  const result = await builder.build(full, { onLine: logBuild, onNotice: logBuild });
  lastBuild = { project: full.name, result };
  depurador.alCompilacion(full.name, result);
  broadcast({
    type: 'build.done',
    ok: result.ok,
    durationMs: result.durationMs,
    errors: eventErrors(result.errors),
  });
  if (result.artifacts) {
    broadcast({
      type: 'build.artifacts',
      firmware: path.basename(result.artifacts.firmware),
      elf: result.artifacts.elf ? path.basename(result.artifacts.elf) : null,
    });
  }
  return result;
}

/**
 * Escribe en el filesystem del chip los archivos que el build marcó para el REPL
 * (MicroPython: el puente generado + el `main.py` del usuario) y los deja corriendo
 * con un soft reboot. `uploadMicroPython` funciona con el emulador andando, así que
 * esto sirve igual para arrancar que para recargar sin reiniciar nada.
 * Sin `artifacts.repl` (los lenguajes que compilan) no hay nada que subir.
 */
async function subirPorRepl(
  full: { name: string; language: Language | null },
  artifacts: BuildArtifacts,
): Promise<boolean> {
  if (!artifacts.repl || !(emulator instanceof EmulatorManager)) return false;
  logBuild('Subiendo el código por el REPL…');
  const delProyecto = await Promise.all(
    artifacts.repl.delProyecto.map(async (ruta: string) => ({
      path: ruta,
      content: await store.readFile(full.name, ruta, full.language).catch(() => ''),
    })),
  );
  const subida = await emulator.uploadMicroPython([...artifacts.repl.generados, ...delProyecto]);
  logBuild(subida.ok ? `Código subido (${subida.output}).` : `[error] no se pudo subir el código: ${subida.output}`);
  return subida.ok;
}

/** Resultado de una recarga: qué camino tomó, o por qué no se hizo nada. */
type Recarga = { ok: boolean; modo?: 'repl' | 'relanzado'; motivo?: string };

/**
 * Lleva al chip el código que está en disco, sin que el usuario tenga que parar y
 * volver a arrancar el emulador.
 *
 * MicroPython no compila: alcanza con re-subir los archivos por el REPL y un soft
 * reboot (instantáneo). Los lenguajes compilados no tienen recarga en caliente —
 * el código vive dentro del firmware grabado—, así que ahí se compila y se relanza
 * la corrida, que es lo mismo que haría el usuario a mano pero en un paso.
 *
 * Solo actúa si el emulador está corriendo *este* proyecto: no arranca nada por su
 * cuenta (si no corre nada, el próximo ▶ ya va a tomar el código nuevo).
 */
async function recargarCodigo(nombre: string): Promise<Recarga> {
  const full = await store.read(nombre);
  if (!tienePlaca(full)) return { ok: false, motivo: 'el proyecto no tiene placa: no hay código que recargar' };
  if (runningProject !== nombre || !emulator.getStatus().running) {
    return { ok: false, motivo: 'el emulador no está corriendo este proyecto' };
  }
  const result = await runBuild(full);
  if (!result.ok || !result.artifacts) return { ok: false, motivo: 'el código no compila' };
  if (await subirPorRepl(full, result.artifacts)) {
    // El soft reboot volvió a ejecutar el código: los pines vigilados se rearman solos
    // porque el puente los vuelve a anunciar, pero los que salen del código pueden haber cambiado.
    const pins = await pinsDeCodigo(full).catch(() => []);
    for (const pin of pins) emulator.getBridge()?.watch(pin);
    logBuild('Código recargado en el chip (sin reiniciar el emulador).');
    broadcast({ type: 'project.changed', project: nombre, what: 'file', origin: 'server' });
    return { ok: true, modo: 'repl' };
  }
  if (result.artifacts.repl) return { ok: false, motivo: 'no se pudo subir el código por el REPL' };
  // Compilado: el firmware nuevo ya está, se relanza con él (`forceBuild: false` reusa este build).
  logBuild('Firmware nuevo: se relanza la corrida (los lenguajes compilados no recargan en caliente).');
  const r = await runProject(full, false);
  return r.ok ? { ok: true, modo: 'relanzado' } : { ok: false, motivo: 'no se pudo relanzar la corrida' };
}

/**
 * Recargas pedidas por el guardado de archivos. Se agrupan por proyecto con una espera
 * corta porque el editor guarda seguido (y en los compilados cada recarga paga Docker):
 * entre tecla y tecla no tiene sentido compilar dos veces.
 */
const RETARDO_AUTORELOAD_MS = 600;
const autoReloadPendiente = new Map<string, NodeJS.Timeout>();
let autoReloadEnCurso: Promise<unknown> = Promise.resolve();

/** Agenda la recarga del proyecto si tiene `sim.autoReload` y el emulador lo está corriendo. */
function agendarAutoReload(project: Project): void {
  if (!project.sim.autoReload) return;
  if (runningProject !== project.name || !emulator.getStatus().running) return;
  clearTimeout(autoReloadPendiente.get(project.name));
  autoReloadPendiente.set(
    project.name,
    setTimeout(() => {
      autoReloadPendiente.delete(project.name);
      // En fila: dos recargas a la vez se pelearían por el REPL y por el emulador.
      autoReloadEnCurso = autoReloadEnCurso.then(async () => {
        const r = await recargarCodigo(project.name).catch((err: unknown) => ({
          ok: false,
          motivo: (err as Error).message,
        }));
        if (!r.ok && r.motivo) logBuild(`[recarga] no se recargó: ${r.motivo}`);
      });
    }, RETARDO_AUTORELOAD_MS),
  );
}

async function runProject(
  project: { name: string },
  forceBuild: boolean,
): Promise<{ ok: boolean; errors: BuildErrorLike[]; sinAlimentacion?: boolean; energizado?: boolean }> {
  const full = await store.read(project.name);
  // Sin placa no hay firmware: ▶ energiza el circuito (prende las fuentes regulables).
  if (!tienePlaca(full)) {
    energizar(full.name, true);
    logBuild(`Circuito "${full.name}" energizado: las fuentes regulables entregan tensión. ⏹ lo apaga.`);
    return { ok: true, errors: [], energizado: true };
  }
  // Como en la vida real: sin la alimentación adecuada la placa no arranca.
  const sinArranque = motivoSinArranque(await alimentacionDe(full));
  if (sinArranque) {
    logBuild(`[error] ${sinArranque}`);
    broadcast({ type: 'project.changed', project: full.name, what: 'diagram', origin: 'server' });
    return { ok: false, errors: [{ line: null, file: null, message: sinArranque }], sinAlimentacion: true };
  }
  if (builder.isBuilding(full.name)) {
    logBuild('Ya se está compilando; se espera a que termine.');
  }
  let artifacts = lastBuild?.project === full.name && !forceBuild ? lastBuild.result.artifacts : null;
  if (!artifacts) {
    logBuild('Compilando antes de arrancar…');
    const result = await builder.build(full, { onLine: logBuild, onNotice: logBuild });
    lastBuild = { project: full.name, result };
    depurador.alCompilacion(full.name, result);
    broadcast({ type: 'build.done', ok: result.ok, durationMs: result.durationMs, errors: eventErrors(result.errors) });
    if (!result.ok || !result.artifacts) return { ok: false, errors: result.errors };
    artifacts = result.artifacts;
  }
  // El motor sale de la placa (`board.backend` del module.json): esp-emu, avr8js...
  const placa = await buscarPlaca(full.board);
  if (!placa) {
    logBuild(`[error] la placa "${full.board}" no está en el catálogo`);
    return { ok: false, errors: [{ line: null, file: null, message: `La placa "${full.board}" no está en el catálogo.` }] };
  }
  const motor = ENGINES[placa.desc.backend.engine];
  let siguiente: Emulador;
  try {
    siguiente = emuladorDe(placa.desc.backend.engine);
  } catch (err) {
    logBuild(`[error] ${(err as Error).message}`);
    return { ok: false, errors: [{ line: null, file: null, message: (err as Error).message }] };
  }
  // Se para la corrida anterior ANTES de cambiar de proyecto: al pararse, sus chips guardan su
  // memoria (EEPROM, la hora) y tiene que ir al proyecto de ellos, no al que arranca ahora.
  if (emulator.getStatus().running) await emulator.stop();
  emulator = siguiente;
  runningProject = full.name;
  controlesCerrados.clear();
  depurador.alIniciarCorrida({ proyecto: full.name, placa: full.board, lenguaje: full.language, motor: placa.desc.backend.engine, artefactos: artifacts });
  // Chips del dibujo (sensores, relojes...) en el bus I2C de la placa, si el motor lo emula.
  const catalogo = await loadCatalog();
  const buscarDef = (t: string): ModuloCatalogo | undefined => catalogo.find((m) => m.type === t);
  // Si cada chip está alimentado lo dice el motor eléctrico (su modelo: VDD en rango).
  const electrico = await analizarCircuito(conPlaca(full), buscarDef, {
    direcciones: await direccionesDe(full), niveles, cerrados: cerradosDe(full.name), fuentesApagadas: fuentesApagadasDe(full),
  }).catch(() => null);
  const enBus = chipsDelProyecto(full, buscarDef, placa.desc, undefined, (id) => electrico?.modulos[id]?.ui?.on);
  for (const aviso of enBus.avisos) logBuild(`[chips] ${aviso}`);
  for (const c of enBus.chips) c.guardado = await leerMemoria(store.projectDir(full.name), c.id);
  if (enBus.chips.length) logBuild(`[chips] en el bus: ${enBus.chips.map((c) => `${c.nombre} (${c.spi ? 'SPI' : 'I2C'})`).join(', ')}`);
  await emulator.start(full.name, artifacts, {
    ...motor!.opcionesArranque(placa.desc, artifacts),
    chips: enBus.chips,
    arranqueMs: placa.desc.arranqueMs,
  });
  void depurador.alArrancado();

  // Sin esto, el chip arranca a un REPL vacío: nada ejecuta el código del usuario (8.8).
  await subirPorRepl(full, artifacts);

  // Al arrancar se vigilan los pines que usa el código, así la UI muestra los
  // LED/salidas sin que el usuario tenga que seleccionarlos uno por uno.
  const pins = await pinsDeCodigo(full).catch(() => []);
  for (const pin of pins) emulator.getBridge()?.watch(pin);
  return { ok: true, errors: [] };
}

/** Todos los pines que el código del proyecto usa (archivos de código). */
/**
 * Cómo configura el programa cada pin (pinMode, Pin.OUT, output: de ESPHome...): es lo que decide,
 * como en la placa real, si un pin entrega corriente o solo escucha. Ver direccionesDeCodigo.
 */
async function direccionesDe(project: { name: string; language: Language | null }): Promise<Map<number, DireccionPin>> {
  const d = new Map<number, DireccionPin>();
  if (!project.language) return d;
  for (const f of await store.listFiles(project.name, project.language)) {
    const content = await store.readFile(project.name, f.path, project.language).catch(() => '');
    for (const [g, x] of direccionesDeCodigo(project.language, content)) d.set(g, x);
  }
  return d;
}

async function pinsDeCodigo(project: { name: string; language: Language | null; board: string | null }): Promise<number[]> {
  if (!project.language) return []; // sin placa no hay código
  const files = await store.listFiles(project.name, project.language);
  const desc = project.board ? (await buscarPlaca(project.board))?.desc : undefined;
  const pines = new Set<number>();
  for (const f of files) {
    const content = await store.readFile(project.name, f.path, project.language).catch(() => '');
    for (const pin of scanPins(project.language, content, desc)) pines.add(pin);
  }
  return [...pines].sort((a, b) => a - b);
}

// --- Alimentación de la placa ------------------------------------------------------

/**
 * Proyectos cuya placa se quemó (sobretensión o polaridad invertida en una entrada de
 * alimentación). Queda muerta hasta reemplazarla, como un LED quemado, aunque se arregle el
 * cableado. En memoria: reiniciar el server también la "repara".
 */
const placasQuemadas = new Set<string>();

type EstadoPlaca = AlimentacionPlaca & { quemada: boolean };

/**
 * Interruptores cerrados ahora (pulsador apretado, llave encendida), por proyecto. El motor
 * eléctrico los trata como un cable. Se vacía al arrancar o parar la simulación: al volver a
 * empezar, nadie está apretando nada.
 */
const controlesCerrados = new Map<string, Set<string>>();

/**
 * Proyecto sin placa "energizado" (▶): sus fuentes regulables entregan tensión. Uno a la vez,
 * como la simulación. Con placa no aplica: ▶ corre el firmware y las fuentes siempre entregan.
 */
let proyectoEnergizado: string | null = null;

/** ¿Las fuentes de este proyecto están apagadas? (sin placa y sin energizar) */
const fuentesApagadasDe = (p: Project): boolean => !p.board && proyectoEnergizado !== p.name;

function energizar(nombre: string, encendido: boolean): void {
  const antes = proyectoEnergizado;
  if (encendido) proyectoEnergizado = nombre;
  else if (proyectoEnergizado === nombre) proyectoEnergizado = null;
  controlesCerrados.clear(); // al prender o apagar, nadie está apretando nada
  estadosModulos.delete(nombre); // y los módulos arrancan de cero, como al cortar la energía
  if (antes && antes !== proyectoEnergizado) broadcast({ type: 'project.changed', project: antes, what: 'diagram', origin: 'server' });
  broadcast({ type: 'project.changed', project: nombre, what: 'diagram', origin: 'server' });
}
const cerradosDe = (nombre: string): Set<string> => controlesCerrados.get(nombre) ?? new Set();
/** Estado interno que cada modelo de módulo devolvió en `observar` (por proyecto → módulo). */
const estadosModulos = new Map<string, Map<string, Record<string, unknown>>>();

async function fijarControl(nombre: string, id: string, cerrado: boolean): Promise<void> {
  const set = controlesCerrados.get(nombre) ?? new Set<string>();
  if (cerrado) set.add(id);
  else set.delete(id);
  controlesCerrados.set(nombre, set);
  // Un interruptor puede cortar (o cerrar) la alimentación de la placa.
  await revisarAlimentacion(nombre);
  // Cambió la física (no el dibujo): las pestañas recalculan corrientes y LEDs (p. ej. si lo apretó el MCP).
  broadcast({ type: 'project.changed', project: nombre, what: 'electrico', origin: 'server' });
  await refrescarEntradasDelCircuito(nombre);
}

/** Último nivel que cada GPIO de entrada leyó del circuito (para no repetirle lo mismo al puente). */
const sensados = new Map<number, 0 | 1>();
let timerSensado = 0;

/**
 * Le avisa al firmware lo que sus pines de entrada leen **del circuito** (idea del PR #5): la
 * tensión del nodo donde está cableado cada uno, resuelta por el motor con los pull internos que
 * activó el programa y los umbrales del chip (VIL/VIH). Así un mismo interruptor puede cortar la
 * corriente de una carga y a la vez ser leído por otro pin, y un pulsador mal cableado no "anda"
 * por arte de magia: como en la mesa.
 *
 * Una lectura indefinida (entre VIL y VIH, o un pin flotando) no se manda: el pin conserva lo que
 * tenía, como hace la histéresis de una entrada real. Se agrupa a 50 ms porque un LED que
 * parpadea manda muchos cambios de salida y cada uno obliga a resolver el circuito de nuevo.
 */
function refrescarEntradasDelCircuito(nombre: string): Promise<void> {
  if (timerSensado) return Promise.resolve();
  return new Promise((listo) => {
    timerSensado = setTimeout(() => {
      timerSensado = 0;
      void (async () => {
        try {
          const bridge = emulator.getBridge();
          if (!bridge || emulator.getStatus().state !== 'bridge' || runningProject !== nombre) return;
          const catalogo = await loadCatalog();
          const buscar = (t: string): ModuloCatalogo | undefined => catalogo.find((m) => m.type === t);
          const original = await store.read(nombre);
          const r = await analizarCircuito(conPlaca(original), buscar, {
            niveles, cerrados: cerradosDe(nombre), direcciones: await direccionesDe(original),
          });
          for (const e of r.entradas) {
            if (e.nivel === null || sensados.get(e.gpio) === e.nivel) continue;
            sensados.set(e.gpio, e.nivel);
            bridge.setInput(e.gpio, e.nivel);
            depurador.alEntrada(e.gpio, e.nivel, 'circuito');
          }
        } catch (err) {
          console.error(`[entradas] no se pudo leer el circuito: ${(err as Error).message}`);
        } finally {
          listo();
        }
      })();
    }, 50) as unknown as number;
  });
}

async function alimentacionDe(project: Project): Promise<EstadoPlaca> {
  const catalogo = await loadCatalog();
  const buscar = (t: string): ModuloCatalogo | undefined => catalogo.find((m) => m.type === t);
  const { alimentacion } = await analizarCircuito(conPlaca(project), buscar, {
    direcciones: await direccionesDe(project),
    niveles, cerrados: cerradosDe(project.name), fuentesApagadas: fuentesApagadasDe(project),
  });
  return conQuemadura(project, alimentacion);
}

/** La quemadura de la placa se recuerda (queda muerta hasta reemplazarla), aunque se arregle el cableado. */
function conQuemadura(project: Project, alimentacion: AlimentacionPlaca): EstadoPlaca {
  if (alimentacion.estado === 'quema') placasQuemadas.add(project.name);
  return { ...alimentacion, quemada: placasQuemadas.has(project.name) };
}

/** Por qué no puede correr la placa (o null si puede). */
function motivoSinArranque(a: EstadoPlaca): string | null {
  if (a.quemada) return `La placa está quemada${a.estado === 'quema' ? ` (${a.mensaje})` : ''}: reemplazala para volver a usarla.`;
  return a.estado === 'ok' ? null : a.mensaje;
}

/** Después de cada cambio del dibujo: si la placa se quemó o se quedó sin energía, la simulación se corta. */
async function revisarAlimentacion(nombre: string): Promise<void> {
  const p = await store.read(nombre);
  if (!p.board) return; // sin placa no hay nada que se quede sin energía
  const estado = await alimentacionDe(p);
  const motivo = motivoSinArranque(estado);
  if (!motivo || runningProject !== nombre || !emulator.getStatus().running) return;
  eventosEmulador.onLog(`[alimentación] ${motivo} Se detuvo la simulación.`);
  await emulator.stop();
  runningProject = null;
  controlesCerrados.clear();
}

function reemplazarPlaca(nombre: string): boolean {
  return placasQuemadas.delete(nombre);
}

/** Avisos de circuito ↔ código (11.6) + Ley de Ohm (cortocircuitos, sobrecorriente): lo que ve la UI y el MCP. */
async function avisosDelProyecto(
  project: Project,
): Promise<{
  pins: number[];
  warnings: DiagramWarning[];
  /**
   * placa: null = proyecto sin placa. energizado: el circuito sin placa está prendido (▶).
   * tensiones: lo que mediría un tester en cada pin cableado.
   */
  electrico: {
    leds: LedElectrico[];
    fuentes: FuenteElectrica[];
    placa: EstadoPlaca | null;
    energizado: boolean;
    tensiones: Record<string, number>;
    /** Estado visible que decidió el modelo de cada módulo (`observar` → ui), con la física en vivo. */
    modulos: Record<string, { on?: boolean; brillo?: number }>;
  };
}> {
  const pins = await pinsDeCodigo(project);
  const catalogo = await loadCatalog();
  const buscar = (t: string): ModuloCatalogo | undefined => catalogo.find((m) => m.type === t);
  const conLaPlaca = conPlaca(project);
  const cerrados = cerradosDe(project.name);
  const fuentesApagadas = fuentesApagadasDe(project);
  // Con los niveles reales de la simulación: avisos, lo que entrega cada fuente, si la placa tiene energía.
  const estados = estadosModulos.get(project.name) ?? new Map<string, Record<string, unknown>>();
  const direcciones = await direccionesDe(project);
  const vivo = await analizarCircuito(conLaPlaca, buscar, { niveles, cerrados, fuentesApagadas, estados, direcciones });
  // Lo que cada modelo quiere recordar vuelve en el próximo cálculo (solo del vivo: los otros son hipotéticos).
  for (const [id, m] of Object.entries(vivo.modulos)) if (m.estado) estados.set(id, m.estado);
  estadosModulos.set(project.name, estados);
  const placa = project.board ? conQuemadura(project, vivo.alimentacion) : null;
  // Cada LED con las salidas del código EN ALTO (peor caso, sin mirar la simulación): la UI lo usa
  // para "quemarlo" cuando la simulación lo prende. Y con las salidas en bajo: la corriente que le
  // llega sin depender del código (mAFijo), para prenderlo aunque ningún GPIO lo maneje.
  // Sin placa no hay salidas del código: alcanza con un solo cálculo.
  const peor = project.board ? await analizarCircuito(conLaPlaca, buscar, { cerrados, fuentesApagadas, direcciones }) : vivo;
  const fijo = project.board ? await analizarCircuito(conLaPlaca, buscar, { cerrados, fuentesApagadas, salidasForzadas: 0, direcciones }) : vivo;
  const leds = peor.leds.map((l) => ({ ...l, mAFijo: fijo.leds.find((x) => x.id === l.id)?.mA ?? 0 }));
  const { avisos: electricos, fuentes } = vivo;
  // Quemada de antes (ya sin la sobretensión): el motor no lo sabe, se avisa acá.
  const quemadaDeAntes = placa?.quemada && placa.estado !== 'quema'
    ? [{ kind: 'peligro-electrico' as const, pin: -1, message: motivoSinArranque(placa)!, refs: undefined }]
    : [];
  return {
    pins,
    electrico: {
      leds, fuentes, placa, energizado: proyectoEnergizado === project.name, tensiones: vivo.tensiones,
      modulos: Object.fromEntries(Object.entries(vivo.modulos).map(([id, m]) => [id, m.ui ?? {}])),
    },
    warnings: [
      ...quemadaDeAntes,
      ...diffDiagramVsCode(project, pins, project.board ? buscar(project.board)?.board : undefined),
      ...electricos.map((a) => ({
        kind: a.severidad === 'peligro' ? ('peligro-electrico' as const) : ('advertencia-electrica' as const),
        pin: a.pin,
        message: a.mensaje,
        refs: a.refs,
      })),
    ],
  };
}

// --- Cambios que la UI tiene que ver en vivo -----------------------------------

/** Id de la pestaña que hizo el cambio (header x-cliente), para que no se recargue a sí misma. */
function clienteDe(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const c = req.headers['x-cliente'];
  return typeof c === 'string' && /^[\w-]{1,64}$/.test(c) ? c : undefined;
}

/** Lee el proyecto, aplica el cambio, lo guarda y avisa a la UI (origen: mcp). */
async function cambiarDiagrama(nombre: string, cambio: (p: Project) => Project): Promise<Project> {
  const actual = await store.read(nombre);
  const guardado = await store.save(cambio(actual));
  await revisarAlimentacion(nombre);
  broadcast({ type: 'project.changed', project: nombre, what: 'diagram', origin: 'mcp' });
  return guardado;
}

function solicitudDe(body: Record<string, unknown>): SolicitudImportacion {
  switch (body.fuente) {
    case 'archivos':
      if (!body.archivos || typeof body.archivos !== 'object') throw new ImportError('faltan los archivos');
      return { fuente: 'archivos', archivos: body.archivos as Record<string, string> };
    case 'zip':
      if (typeof body.base64 !== 'string') throw new ImportError('falta el zip (base64)');
      return { fuente: 'zip', base64: body.base64 };
    case 'wokwi':
      if (typeof body.chipJson !== 'string') throw new ImportError('falta el .chip.json');
      return { fuente: 'wokwi', chipJson: body.chipJson };
    case 'url':
      if (typeof body.url !== 'string') throw new ImportError('falta la URL');
      return { fuente: 'url', url: body.url };
    default:
      throw new ImportError('fuente inválida: archivos, zip, wokwi o url');
  }
}

async function importarModulos(solicitud: SolicitudImportacion, opciones: OpcionesImportacion) {
  const resultado = await importar(solicitud, instalador, {
    sobrescribir: Boolean(opciones.sobrescribir),
    soloValidar: Boolean(opciones.soloValidar),
    wokwi: opciones.wokwi,
  });
  if (resultado.importados.length > 0 && !opciones.soloValidar) {
    invalidarCatalogo();
    broadcast({ type: 'catalog.changed' });
  }
  return resultado;
}

async function quitarDelCatalogo(type: string): Promise<void> {
  await instalador.quitar(type);
  invalidarCatalogo();
  broadcast({ type: 'catalog.changed' });
}

const contextoMcp: McpContexto = {
  chips: {
    catalogo: () => cargarChips().map(chipPublico),
    deProyecto: (n) => chipsDe(n, depsChips),
    moverEntorno: (n, id, valores) => moverEntorno(n, id, valores, depsChips),
  },
  store,
  crearProyecto,
  plantillas: () => store.listTemplates(),
  async placas() {
    return Promise.all((await listarPlacas()).map(placaParaUi));
  },
  esquemaPlaca: esquemaJsonPlaca,
  validarPlaca,
  async certificarPlaca(id, lenguaje) {
    const placa = await buscarPlaca(id);
    if (!placa) throw new Error(`No hay una placa "${id}" en el catálogo (importala primero con importar_modulo).`);
    return certificarPlaca(placa, lenguaje);
  },
  catalogo: loadCatalog,
  cambiarDiagrama,
  async escribirArchivo(nombre, ruta, contenido) {
    const p = await store.read(nombre);
    await store.writeFile(nombre, ruta, p.language, contenido);
    broadcast({ type: 'project.changed', project: nombre, what: 'file', file: ruta, origin: 'mcp' });
  },
  pinesYAvisos: (nombre) => store.read(nombre).then(avisosDelProyecto),
  fijarControl,
  async agregarPlaca(nombre, tipo, lenguaje, pos) {
    const p = await agregarPlaca(nombre, tipo, lenguaje, pos);
    broadcast({ type: 'project.changed', project: nombre, what: 'diagram', origin: 'mcp' });
    return p;
  },
  async quitarPlaca(nombre) {
    const p = await quitarPlaca(nombre);
    broadcast({ type: 'project.changed', project: nombre, what: 'diagram', origin: 'mcp' });
    return p;
  },
  proyectoEnergizado: () => proyectoEnergizado,
  async reemplazarPlaca(nombre) {
    const habia = reemplazarPlaca(nombre);
    broadcast({ type: 'project.changed', project: nombre, what: 'diagram', origin: 'mcp' });
    return habia;
  },
  compilar: (nombre) => runBuild({ name: nombre }),
  ejecutar: (nombre, recompilar) => runProject({ name: nombre }, recompilar),
  async parar() {
    await emulator.stop();
    runningProject = null;
    controlesCerrados.clear();
    if (proyectoEnergizado) energizar(proyectoEnergizado, false);
  },
  resetear: () => emulator.reset(),
  estadoEmulador: () => emulator.getStatus(),
  proyectoCorriendo: () => (emulator.getStatus().running ? runningProject : null),
  async esperarEstado(estados, timeoutMs) {
    const ahora = emulator.getStatus().state;
    if (estados.includes(ahora)) return ahora;
    return esperar(oyentesEstado, (e) => estados.includes(e), timeoutMs);
  },
  ponerPin(gpio, nivel) {
    const bridge = emulator.getBridge();
    if (!bridge || emulator.getStatus().state !== 'bridge') return false;
    bridge.setInput(gpio, nivel);
    depurador.alEntrada(gpio, nivel, 'mcp');
    return true;
  },
  enviarRf(bits, protocolo) {
    const bridge = emulator.getBridge();
    if (!bridge || emulator.getStatus().state !== 'bridge') return false;
    bridge.sendRf(bits, protocolo);
    return true;
  },
  niveles: () => Object.fromEntries(niveles) as Record<number, 0 | 1>,
  logs: (fuente, n) => (fuente === 'build' ? logCompilacion.slice(-n) : emulator.getRecentLog(n)),
  esperarLog: (re, timeoutMs) => esperar(oyentesLog, (l) => re.test(l), timeoutMs),
  importar: importarModulos,
  quitarDelCatalogo,
  depurador,
};

// --- Seguridad: solo la propia UI y clientes locales ------------------------------

/**
 * La app escucha solo en 127.0.0.1, pero una página web cualquiera abierta en el
 * navegador podría mandarle pedidos (o abrir el WebSocket / MCP). Los navegadores
 * mandan Origin: si viene y no es la propia UI, se rechaza. Clientes sin navegador
 * (MCP de Claude Code, curl) no mandan Origin. El Host se valida contra DNS rebinding.
 */
const EXTRA = (process.env.EMU_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const ORIGENES = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  ...(HOST === '127.0.0.1' || HOST === '0.0.0.0' ? [] : [`http://${HOST}:${PORT}`]),
  ...EXTRA.map((h) => `http://${h}`),
]);
const HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  ...(HOST === '127.0.0.1' || HOST === '0.0.0.0' ? [] : [`${HOST}:${PORT}`]),
  ...EXTRA,
]);

function origenPermitido(origin: string | undefined, host: string | undefined): boolean {
  if (host !== undefined && !HOSTS.has(host)) return false;
  return origin === undefined || ORIGENES.has(origin);
}

// --- WebSocket --------------------------------------------------------------

function attachWebSocket(server: import('node:http').Server): void {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info: { origin: string; req: import('node:http').IncomingMessage }) =>
      origenPermitido(info.origin || undefined, info.req.headers.host),
  });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', state: emulator.getStatus().state }));
    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const msg = ClientEventSchema.safeParse(parsed);
      if (!msg.success) {
        ws.send(JSON.stringify({ type: 'error', message: 'Mensaje inválido' }));
        return;
      }
      const m = msg.data;
      switch (m.type) {
        case 'pin.in':
          emulator.getBridge()?.setInput(m.pin, m.level);
          depurador.alEntrada(m.pin, m.level, 'ui');
          break;
        case 'pin.watch':
          emulator.getBridge()?.watch(m.pin);
          break;
        case 'rf.send':
          emulator.getBridge()?.sendRf(m.bits, m.protocol);
          break;
        case 'console.input':
          emulator.writeConsole(m.data);
          break;
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
}

// --- Arranque ---------------------------------------------------------------

// Import diferido para no cargar el plugin estático en las pruebas.
let fastifyStatic: typeof import('@fastify/static').default;

export async function startServer(): Promise<{ close: () => Promise<void>; port: number }> {
  fastifyStatic = (await import('@fastify/static')).default;
  await store.init();
  await registerRoutes();

  await logger.listen({ port: PORT, host: HOST });
  attachWebSocket(logger.server);
  console.log(`Emulador listo en http://${HOST}:${PORT}`);
  // El motor eléctrico (ngspice) tarda ~0,7 s en arrancar: mejor ahora que en el primer cálculo.
  void precalentar().catch((err) => console.error(`[motor eléctrico] no arrancó: ${(err as Error).message}`));

  const shutdown = async (): Promise<void> => {
    await emulator.shutdown();
    // Sin esto, close() espera a que el navegador suelte el WebSocket: nunca termina.
    for (const ws of clients) ws.terminate();
    await logger.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  return { close: () => logger.close(), port: PORT };
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
