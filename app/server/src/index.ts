import { crearActualizadorElectrico } from './actualizadorElectrico.js';
import { VigenciaElectrica } from './vigenciaElectrica.js';
import { transmitirPorCanalRf } from './rf/canalRf.js';
import { validarDestinoRf } from './rf/destinoRf.js';
import { enviarTramaRf, validarTramaRf } from './rf/transporteRf.js';
import { pararPlacasSinEnergia } from './pararPlacasSinEnergia.js';
import { estadoAlimentacion, motivoSinArranque, type EstadoAlimentacion as EstadoPlaca } from './estadoAlimentacion.js';
import { leerFuentesMicroPython } from './micropythonSources.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_BOARD,
  placaDelProyecto,
  placasDelProyecto,
  lenguajesDe,
  ClientEventSchema,
  LanguageSchema,
  ServerEventSchema,
  sonidosDelCircuito,
  tienePlaca,
  type EventoSonido,
  type Language,
  type Project,
  type ServerEvent,
} from '@emu/shared';
import { PATHS } from './paths.js';
import { CoordinadorCapturas } from './camera/coordinador.js';
import { ServicioCamara } from './camera/servicio.js';
import { registrarRutasCamara } from './camera/rutas.js';
import { registrarRutasAnalisisFisico } from './rutasAnalisisFisico.js';
import { estadoAnalogicoDesdeCircuito } from './analogicoAvr.js';
import { estadoAnalogicoEspDesdeCircuito } from './analogicoEsp.js';
import type { PwmPin } from './pwmEsp.js';
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
import { conPlaca, gpioDe, ponerPlaca, sacarPlaca } from './diagramOps.js';
import { analizarCircuito, type AnalisisCircuito, type DireccionPin, type OpcionesAnalisis } from './sim/analisis.js';
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
const camaras = new ServicioCamara(broadcast);
const capturasFirmware = new CoordinadorCapturas(camaras, mensaje => logBuild(mensaje));
store.alCambiar = async (name, modules) => {
  const catalogo = await loadCatalog();
  camaras.reconciliar(name, modules.filter(m => catalogo.some(d => d.type === m.type && d.camera)).map(m => m.id));
  if (runningProject === name) await actualizarCamarasDelCircuito(name);
};

// --- Estado compartido ------------------------------------------------------

let lastBuild: { project: string; result: BuildResult } | null = null;
let runningProject: string | null = null;

const clients = new Set<WebSocket>();

/** Últimas líneas de compilación (para el MCP; las del emulador las guarda EmulatorManager). */
const logCompilacion: string[] = [];
/** Último nivel de salida reportado por el firmware para cada GPIO. */
let niveles = new Map<number, 0 | 1>();
const nivelesPorPlaca = new Map<string, Map<number, 0 | 1>>([['board', niveles]]);
const corridas = new Map<string, Emulador>();
let primaryBoardId = 'board';
let runGeneration = 0;
const vigenciaElectrica = new VigenciaElectrica();
let runQueue: Promise<unknown> = Promise.resolve();
let executingProject: string | null = null;
const nivelesDePlaca = (id: string) => {
  let levels = nivelesPorPlaca.get(id);
  if (!levels) { levels = new Map(); nivelesPorPlaca.set(id, levels); }
  return levels;
};
const oyentesLog = new Set<(line: string) => void>();
const oyentesEstado = new Set<(state: string) => void>();

const instalador = new ModuleInstaller(PATHS.modules);

function logBuild(line: string, boardId?: string): void {
  logCompilacion.push(line);
  if (logCompilacion.length > 2000) logCompilacion.shift();
  broadcast({ type: 'build.log', line, boardId });
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
function eventosDePlaca(boardId: string): EmulatorEvents { return {
  onLog: (line) => {
    broadcast({ type: 'emu.log', line, boardId, project: runningProject ?? undefined });
    for (const o of boardId === primaryBoardId ? oyentesLog : []) o(line);
    depuradorDe(boardId).alLog(line);
  },
  onState: (status) => {
    if (status.state === 'stopped' || status.state === 'starting') { nivelesDePlaca(boardId).clear(); sensadosPorPlaca.delete(boardId); }
    depuradorDe(boardId).alEstado(status);
    broadcast({ type: 'emu.state', boardId, project: runningProject ?? undefined, state: status.state, status: { ...status, paused: depuradorDe(boardId).pausado() } });
    if (boardId === primaryBoardId) for (const o of oyentesEstado) o(status.state);
  },
  onBridgeState: (connected) => broadcast({ type: 'bridge.state', connected, boardId }),
  onPwm: () => broadcast({ type: 'pwm.changed', boardId }),
  onBridgeMessage: (msg) => {
    depuradorDe(boardId).alMensajePuente(msg);
    switch (msg.type) {
      case 'READY':
        corridas.get(boardId)?.markBridgeReady();
        broadcast({ type: 'bridge.ready', version: msg.version, boardId, project: runningProject ?? undefined });
        // Con el puente listo, el programa lee por primera vez lo que hay en el circuito.
        sensadosPorPlaca.delete(boardId);
        if (runningProject) void refrescarEntradasDelCircuito(runningProject);
        break;
      case 'OUT':
        nivelesDePlaca(boardId).set(msg.pin, msg.level);
        broadcast({ type: 'pin.out', pin: msg.pin, level: msg.level, boardId, project: runningProject ?? undefined });
        // Un pin que cambia de estado mueve los voltajes del circuito: lo que leen las
        // entradas cableadas a esa red cambia con él.
        if (runningProject) void refrescarEntradasDelCircuito(runningProject);
        break;
      case 'TX':
        broadcast({ type: 'rf.tx', bits: msg.bits, protocol: msg.protocol, boardId, project: runningProject ?? undefined });
        break;
      case 'PONG':
        broadcast({ type: 'bridge.pong', n: msg.n, boardId, project: runningProject ?? undefined });
        break;
      case 'ERR':
        broadcast({ type: 'bridge.error', code: msg.code, message: msg.message, boardId, project: runningProject ?? undefined });
        break;
      default:
        break;
    }
  },
}; }
const eventosEmulador = eventosDePlaca('board');

/** Una instancia por motor (plugin de engines/), creada la primera vez que se usa. */
const instancias = new Map<string, Emulador>();
function emuladorDe(motor: string, boardId = 'board'): Emulador {
  const key = `${boardId}:${motor}`;
  let e = instancias.get(key);
  if (!e) {
    const m = ENGINES[motor];
    if (!m) throw new ProjectError(`El motor de emulación "${motor}" no existe en este server.`, 400);
    if (!m.disponible) throw new ProjectError(`El motor de emulación "${motor}" todavía no está implementado.`, 400);
    e = m.crear(eventosDePlaca(boardId));
    instancias.set(key, e);
    // Motores con chips en un bus (avr8js): lo que publican (una pantalla, valores) va a la UI.
    const conChips = e as Emulador & { oyenteChips?: ((id: string, salida: Record<string, unknown>) => void) | null };
    if ('oyenteChips' in conChips) {
      conChips.oyenteChips = (id, salida) => {
        if (runningProject) broadcast({ type: 'chip.salida', project: runningProject, id, salida });
        const motorCamara = e as Emulador & { entradaCamara?: (i: string, d: import('./bus/chipSandbox.js').EntradaChip) => void };
        if (runningProject && motorCamara.entradaCamara) capturasFirmware.salida(runningProject, id, salida, (i, datos) => motorCamara.entradaCamara?.(i, datos));
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
const depuradores = new Map<string, Depurador>();
function depuradorDe(boardId: string): Depurador {
  let d = depuradores.get(boardId);
  if (!d) {
    d = new Depurador({
      emitir: e => broadcast({ ...e, boardId, project: runningProject ?? undefined } as ServerEvent),
      emulador: () => corridas.get(boardId) ?? emulator,
      catalogo: loadCatalog,
      leerProyecto: async name => {
        const project = await store.read(name);
        const selected = placaDelProyecto(project, boardId);
        return selected ? { ...project, board: selected.board, language: selected.language, boards: [selected, ...placasDelProyecto(project).filter(b => b.id !== boardId)] } : project;
      },
      direcciones: async name => {
        const project = await store.read(name);
        const selected = placaDelProyecto(project, boardId);
        return direccionesDe({ name, language: selected?.language ?? project.language }, boardId);
      },
      boardId,
      nivelesPorPlaca: () => nivelesPorPlaca,
    });
    depuradores.set(boardId, d);
  }
  return d;
}
let depurador = depuradorDe('board');

export { store, builder, emulator };

/** Lo que necesitan la API y el MCP de los chips (bus/rutasChips.ts). */
const depsChips: DepsChips = {
  leer: (n) => store.read(n),
  guardar: (p) => store.save(p),
  catalogo: loadCatalog,
  corrida: (n) => {
    if (runningProject !== n) return null;
    const targets = [...corridas.values()].filter(e => e.getStatus().running && 'chipsEnCorrida' in e && 'ponerEntorno' in e) as (Emulador & CorridaChips)[];
    return targets.length ? { chipsEnCorrida: () => targets.flatMap(e => e.chipsEnCorrida()), ponerEntorno: (id, valores) => targets.map(e => e.ponerEntorno(id, valores)).some(Boolean) } : null;
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
  const agregada = placasDelProyecto(nuevo).find((p) => !placasDelProyecto(actual).some((a) => a.id === p.id));
  await store.escribirSiFalta(nombre, lenguaje, archivos, agregada?.id);
  const guardado = await store.save(nuevo);
  return guardado;
}

/** Quita la placa (y sus cables). El código queda en disco: si se vuelve a poner la placa, sigue ahí. */
async function quitarPlaca(nombre: string, boardId?: string): Promise<Project> {
  const actual = await store.read(nombre);
  if (runningProject === nombre && emulator.getStatus().running) {
    eventosEmulador.onLog('[placa] Se quitó la placa: se detuvo la simulación.');
    await pararCorridas();
    runningProject = null;
    controlesCerrados.clear();
  }
  return store.save(sacarPlaca(actual, boardId));
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

/** Valida el contexto antes de resolver una ruta de código. */
function placaParaArchivo(project: Project, boardId?: string) {
  const placa = placaDelProyecto(project, boardId);
  if (!placa) throw new ProjectError('Elegí una placa del circuito para acceder a sus archivos.', boardId ? 404 : 400);
  return placa;
}

async function validarModulosPlacas(project: Project, modules: unknown[]): Promise<void> {
  if (!Array.isArray(modules) || modules.some(m => m === null || typeof m !== 'object' || typeof (m as { id?: unknown }).id !== 'string' || typeof (m as { type?: unknown }).type !== 'string')) throw new ProjectError('El dibujo debe incluir una lista de módulos válidos.', 400);
  const boards = placasDelProyecto(project);
  const items = modules as { id?: string; type?: string }[];
  for (const b of boards) if (items.filter(m => m.id === b.id && m.type === b.board).length !== 1) throw new ProjectError(`El dibujo debe conservar la placa ${b.id}. Agregá o quitá placas desde sus controles.`, 400);
  const catalog = await loadCatalog();
  for (const m of items) if (catalog.find(def => def.type === m.type)?.programmable && !boards.some(b => b.id === m.id && b.board === m.type)) throw new ProjectError('No se puede agregar una placa desde la actualización del dibujo.', 400);
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
  registrarRutasCamara(app, camaras, async (name, id) => {
    if (!await store.exists(name)) return null;
    const p = await store.read(name);
    const inst = p.modules.find(m => m.id === id);
    if (!inst) return null;
    return (await loadCatalog()).find(m => m.type === inst.type)?.camera ?? null;
  });

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
      const boardId = (req.query as { boardId?: string }).boardId;
      const elegida = placaDelProyecto(project, boardId);
      if (boardId && !elegida) throw new ProjectError('La placa no existe en este proyecto.', 404);
      const [files, directories] = await Promise.all([
        store.listFiles(name, elegida?.language ?? null, elegida?.id),
        store.listDirectories(name, elegida?.language ?? null, elegida?.id),
      ]);
      const placa = elegida ? await buscarPlaca(elegida.board) : undefined;
      reply.send({ project, files, directories, placa: placa ? await placaParaUi(placa) : null });
    } catch (err) {
      fail(reply, err);
    }
  });

  // El árbol del proyecto enumera todas las placas sin cambiar el contexto del editor.
  app.get('/api/projects/:name/explorer', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      const project = await requireProject(name);
      const boards = await Promise.all(placasDelProyecto(project).map(async (board) => {
        const [files, directories, placa] = await Promise.all([
          store.listFiles(name, board.language, board.id),
          store.listDirectories(name, board.language, board.id),
          buscarPlaca(board.board),
        ]);
        const descriptor = placa ? await placaParaUi(placa) : null;
        return { id: board.id, name: descriptor?.nombre ?? board.board,
          files: files.filter(file => !/(^|\/)(secrets\.yaml|project\.json)$/.test(file.path)), directories };
      }));
      reply.send({ boards });
    } catch (err) {
      fail(reply, (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? new ProjectError('El proyecto no existe.', 404) : err);
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
      if (body.boards !== undefined && JSON.stringify(body.boards) !== JSON.stringify(project.boards)) throw new ProjectError('Las placas se administran desde las rutas de placas del proyecto.', 400);
      if (body.name !== undefined && body.name !== name) throw new ProjectError('No se puede cambiar el nombre por esta ruta.', 400);
      if (body.modules !== undefined) await validarModulosPlacas(project, body.modules);
      const updated = await store.save({ ...project, ...body, name });
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
      const elegida = placaParaArchivo(project, (req.query as { boardId?: string }).boardId);
      const content = await store.readFile(name, file, elegida.language, elegida.id);
      reply.send({ path: file, content });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.post('/api/projects/:name/directories', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as { path?: unknown };
    try {
      if (typeof body.path !== 'string') throw new ProjectError('Indicá la ruta de la carpeta.', 400);
      const project = await requireProject(name);
      const elegida = placaParaArchivo(project, (req.query as { boardId?: string }).boardId);
      const directory = await store.createDirectory(name, body.path, elegida.language, elegida.id);
      broadcast({ type: 'project.changed', project: name, what: 'file', file: directory, boardId: elegida.id, origin: clienteDe(req) });
      reply.code(201).send({ ok: true, path: directory });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.post('/api/projects/:name/files/*', async (req, reply) => {
    const { name } = req.params as { name: string };
    const file = (req.params as Record<string, string>)['*'] ?? '';
    const body = (req.body ?? {}) as { content?: unknown };
    try {
      if (body.content !== undefined && typeof body.content !== 'string') throw new ProjectError('El contenido debe ser texto.', 400);
      const project = await requireProject(name);
      const elegida = placaParaArchivo(project, (req.query as { boardId?: string }).boardId);
      const created = await store.createFile(name, file, elegida.language, body.content ?? '', elegida.id);
      broadcast({ type: 'project.changed', project: name, what: 'file', file: created, boardId: elegida.id, origin: clienteDe(req) });
      agendarAutoReload(project, elegida.id);
      reply.code(201).send({ ok: true, path: created });
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
      const elegida = placaParaArchivo(project, (req.query as { boardId?: string }).boardId);
      await store.writeFile(name, file, elegida.language, String(body.content ?? ''), elegida.id);
      broadcast({ type: 'project.changed', project: name, what: 'file', file, boardId: elegida.id, origin: clienteDe(req) });
      // No se espera: guardar tiene que contestar al toque, la recarga va por la consola.
      agendarAutoReload(project, elegida.id);
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
      const elegida = placaParaArchivo(project, (req.query as { boardId?: string }).boardId);
      await store.deleteFile(name, file, elegida.language, elegida.id);
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
      if (body.modules !== undefined) await validarModulosPlacas(project, body.modules);
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
      const project = await quitarPlaca(name, (req.query as { boardId?: string }).boardId);
      broadcast({ type: 'project.changed', project: name, what: 'diagram', origin: clienteDe(req) });
      reply.send({ project });
    } catch (err) {
      fail(reply, err);
    }
  });

  app.post('/api/projects/:name/board/replace', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      const project = await requireProject(name);
      const elegida = placaParaArchivo(project, (req.query as { boardId?: string }).boardId);
      const habia = reemplazarPlaca(name, elegida.id);
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

  registrarRutasDepuracion(app, async (boardId, projectName) => {
    if (!boardId) return depurador;
    const name = projectName ?? runningProject;
    if (name && !placaDelProyecto(await store.read(name), boardId)) throw new ProjectError('No existe esa placa en el proyecto.', 404);
    if (!name && !depuradores.has(boardId)) throw new ProjectError('La placa no está disponible para depuración.', 404);
    return depuradorDe(boardId);
  });

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
    nivelesPorPlaca: Object.fromEntries([...nivelesPorPlaca].map(([id, levels]) => [id, Object.fromEntries(levels)])),
    boards: Object.fromEntries([...corridas].map(([id, e]) => [id, e.getStatus()])),
    cerrados: runningProject ? [...cerradosDe(runningProject)] : [],
  }));

  app.post('/api/emulator/stop', async (req, reply) => {
    await pararCorridas();
    runningProject = null;
    controlesCerrados.clear();
    if (proyectoEnergizado) energizar(proyectoEnergizado, false);
    reply.send({ ok: true });
  });

  app.post('/api/projects/:name/reload', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      await requireProject(name);
      const r = await recargarCodigo(name, (req.body as { boardId?: string } | undefined)?.boardId);
      reply.send(r);
    } catch (err) {
      fail(reply, err);
    }
  });

  app.post('/api/emulator/reset', async (req, reply) => {
    try {
      const boardId = (req.body as { boardId?: string } | undefined)?.boardId;
      const out = await resetearCorridas(boardId);
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

  registrarRutasAnalisisFisico(app, {
    cargar: async nombre => {
      const proyecto = await requireProject(nombre);
      const catalogo = await loadCatalog();
      const opciones: OpcionesAnalisis = {
        nivelesReales: true,
        nivelesPorPlaca: nombre === runningProject ? nivelesPorPlaca : new Map(),
        direccionesPorPlaca: await direccionesTodas(proyecto),
        cerrados: cerradosDe(nombre), fuentesApagadas: fuentesApagadasDe(proyecto),
      };
      return { proyecto: conPlaca(proyecto), buscar: tipo => catalogo.find(m => m.type === tipo), opciones };
    },
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
  const result = await builder.buildBoards(full, boardId => ({
    onLine: line => logBuild(line, boardId), onNotice: line => logBuild(line, boardId),
  }));
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
  for (const [boardId, boardResult] of Object.entries(result.boardResults ?? {})) {
    depuradorDe(boardId).alCompilacion(full.name, boardResult);
    if (placasDelProyecto(full).length > 1) broadcast({ type: 'build.done', boardId, ok: boardResult.ok, durationMs: boardResult.durationMs, errors: eventErrors(boardResult.errors) });
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
  boardId = primaryBoardId,
  target: Emulador | undefined = corridas.get(boardId),
): Promise<boolean> {
  const generation = runGeneration;
  if (!artifacts.repl || !(target instanceof EmulatorManager) || !target.getStatus().running || runningProject !== full.name) return false;
  logBuild('Subiendo el código por el REPL…', boardId);
  let delProyecto: { path: string; content: string }[];
  try {
    delProyecto = full.language === 'micropython'
      ? (await leerFuentesMicroPython(store.projectCodeDir(full.name, boardId))).files
      : await Promise.all(artifacts.repl.delProyecto.map(async ruta => ({
        path: ruta, content: await store.readFile(full.name, ruta, full.language, boardId),
      })));
  } catch (error) {
    logBuild(`[error] no se pudo preparar el código: ${(error as Error).message}`, boardId);
    return false;
  }
  if (generation !== runGeneration || !target.getStatus().running || corridas.get(boardId) !== target || runningProject !== full.name) return false;
  const subida = await target.uploadMicroPython([...artifacts.repl.generados, ...delProyecto]);
  logBuild(subida.ok ? `Código subido (${subida.output}).` : `[error] no se pudo subir el código: ${subida.output}`, boardId);
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
async function recargarCodigo(nombre: string, boardId?: string): Promise<Recarga> {
  const full = await store.read(nombre);
  const all = placasDelProyecto(full);
  const selected = boardId ? all.filter(b => b.id === boardId) : all;
  if (!selected.length) return { ok: false, motivo: boardId ? 'el proyecto no tiene la placa solicitada' : 'el proyecto no tiene placa' };
  const generation = runGeneration;
  const targets = new Map(selected.map(b => [b.id, corridas.get(b.id)]));
  if (runningProject !== nombre || selected.some(b => !targets.get(b.id)?.getStatus().running)) return { ok: false, motivo: 'el emulador no está corriendo este proyecto' };
  const results = await Promise.all(selected.map(async b => [b.id, await builder.build(full, { onLine: line => logBuild(line, b.id), onNotice: line => logBuild(line, b.id) }, b.id)] as const));
  if (generation !== runGeneration || runningProject !== nombre) return { ok: false, motivo: 'la ejecución fue detenida durante la recarga' };
  for (const [id, result] of results) if (!result.ok || !result.artifacts) return { ok: false, motivo: `el código de ${id} no compila` };
  const combined = { ...(lastBuild?.project === nombre ? lastBuild.result.boardResults : {}), ...Object.fromEntries(results) };
  const primary = combined[all[0]!.id] ?? results[0]![1];
  lastBuild = { project: nombre, result: { ...primary, boardResults: combined } };
  let compiled = false;
  for (const b of selected) {
    const target = targets.get(b.id)!;
    if (generation !== runGeneration || corridas.get(b.id) !== target || !target.getStatus().running) return { ok: false, motivo: 'la ejecución cambió durante la recarga' };
    const artifacts = combined[b.id]!.artifacts!;
    const project = { ...full, board: b.board, language: b.language };
    if (artifacts.repl) {
      if (!await subirPorRepl(project, artifacts, b.id, target)) return { ok: false, motivo: `no se pudo subir el código de ${b.id}` };
    } else {
      compiled = true;
      const placa = await buscarPlaca(b.board);
      if (!placa) return { ok: false, motivo: 'la placa no está en el catálogo' };
      const catalog = await loadCatalog();
      // La solución DC abarca todas las placas. Ninguna consulta del runtime puede
      // aplicar una instantánea anterior o intermedia a este stop/análisis/start.
      let fallo: Recarga | null;
      try {
        fallo = await vigenciaElectrica.cambiar<Recarga | null>(async () => {
          if (generation !== runGeneration || runningProject !== nombre) return { ok: false, motivo: 'la ejecución cambió durante la recarga' };
          await target.stop();
          if (generation !== runGeneration || runningProject !== nombre) return { ok: false, motivo: 'se detuvo la ejecución durante la recarga' };
          nivelesPorPlaca.get(b.id)?.clear();
          sensadosPorPlaca.delete(b.id);
          const electrico = await analizarCircuito(conPlaca(full), t => catalog.find(m => m.type === t), {
            nivelesReales: true, nivelesPorPlaca, direccionesPorPlaca: await direccionesTodas(full),
            cerrados: cerradosDe(nombre), fuentesApagadas: fuentesApagadasDe(full),
          });
          if (generation !== runGeneration || runningProject !== nombre) return { ok: false, motivo: 'se detuvo la ejecución durante el análisis eléctrico' };
          const motivo = motivoSinArranque(estadoAlimentacion(electrico.alimentacionesPorPlaca?.[b.id] ?? electrico.alimentacion, electrico.resuelto));
          if (motivo) return { ok: false, motivo: `[${b.id}] ${motivo}` };
          const chips = chipsDelProyecto(project, t => catalog.find(m => m.type === t), placa.desc, undefined,
            id => electrico.resuelto && electrico.modulos[id]?.ui?.on === true, b.id).chips;
          depuradorDe(b.id).alIniciarCorrida({ proyecto: nombre, placa: b.board, lenguaje: b.language, motor: placa.desc.backend.engine, artefactos: artifacts });
          await target.start(nombre, artifacts, { ...ENGINES[placa.desc.backend.engine]!.opcionesArranque(placa.desc, artifacts), chips, arranqueMs: placa.desc.arranqueMs,
            analogicoAvr: estadoAnalogicoDesdeCircuito(full, b.id, placa.desc, electrico),
            perfilAnalogicoAvr: full.sim.analogicoAvr?.[b.id],
            analogicoEsp: estadoAnalogicoEspDesdeCircuito(b.id, placa.desc, electrico),
            perfilAnalogicoEsp: full.sim.analogicoEsp?.[b.id],
          });
          if (generation !== runGeneration || runningProject !== nombre) { await target.stop(); return { ok: false, motivo: 'se detuvo la ejecución durante la recarga' }; }
          void depuradorDe(b.id).alArrancado();
          return null;
        });
      } finally {
        // READY pudo pedir una lectura mientras el bloqueo seguía activo. Al salir,
        // el actualizador existente garantiza otra lectura aunque ya no haya eventos.
        if (generation === runGeneration && runningProject === nombre) void refrescarEntradasDelCircuito(nombre);
      }
      if (fallo) return fallo;
    }
    for (const pin of await pinsDeCodigo(project, b.id)) target.getBridge()?.watch(pin);
    broadcast({ type: 'project.changed', project: nombre, what: 'file', boardId: b.id, origin: 'server' });
  }
  return { ok: true, modo: compiled ? 'relanzado' : 'repl' };
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
function agendarAutoReload(project: Project, boardId?: string): void {
  if (!project.sim.autoReload) return;
  if (runningProject !== project.name || !emulator.getStatus().running) return;
  const key = `${project.name}:${boardId ?? '*'}`;
  clearTimeout(autoReloadPendiente.get(key));
  autoReloadPendiente.set(
    key,
    setTimeout(() => {
      autoReloadPendiente.delete(key);
      // En fila: dos recargas a la vez se pelearían por el REPL y por el emulador.
      autoReloadEnCurso = autoReloadEnCurso.then(async () => {
        const r = await recargarCodigo(project.name, boardId).catch((err: unknown) => ({
          ok: false,
          motivo: (err as Error).message,
        }));
        if (!r.ok && r.motivo) logBuild(`[recarga] no se recargó: ${r.motivo}`);
      });
    }, RETARDO_AUTORELOAD_MS),
  );
}

async function pararCorridas(invalidar = true): Promise<void> {
  if (invalidar) { runGeneration++; if (executingProject) builder.cancel(executingProject); }
  const targets = new Set([...corridas.values(), emulator]);
  await Promise.all([...targets].map(e => e.stop()));
  corridas.clear();
  nivelesPorPlaca.clear();
  niveles.clear();
  sensadosPorPlaca.clear();
  if (invalidar) { await runQueue.catch(() => {}); await pararCorridas(false); }
}

async function resetearCorridas(boardId?: string): Promise<string> {
  if (boardId && !corridas.has(boardId)) throw new ProjectError('La placa no está ejecutándose.', 404);
  const targets = boardId ? [corridas.get(boardId)!] : [...new Set([...corridas.values(), emulator])];
  return (await Promise.all(targets.map(e => e.reset()))).join('\n');
}

function runProject(project: { name: string }, forceBuild: boolean) {
  const generation = ++runGeneration;
  const job = runQueue.catch(() => {}).then(async () => {
    executingProject = project.name;
    try { return await ejecutarProyecto(project, forceBuild, generation); }
    finally { executingProject = null; }
  });
  runQueue = job;
  return job;
}

async function ejecutarProyecto(
  project: { name: string },
  forceBuild: boolean,
  generation: number,
): Promise<{ ok: boolean; errors: BuildErrorLike[]; sinAlimentacion?: boolean; energizado?: boolean }> {
  const cancelled = () => generation !== runGeneration;
  const cancelledResult = () => ({ ok: false, errors: [{ line: null, file: null, message: 'La ejecución fue cancelada.' }] });
  if (cancelled()) return cancelledResult();
  const full = await store.read(project.name);
  if (cancelled()) return cancelledResult();
  const boards = placasDelProyecto(full);
  if (!boards.length) {
    await pararCorridas(false); runningProject = null;
    energizar(full.name, true);
    logBuild(`Circuito "${full.name}" energizado: las fuentes regulables entregan tensión. ⏹ lo apaga.`);
    return { ok: true, errors: [], energizado: true };
  }
  const catalogo = await loadCatalog();
  const buscarDef = (t: string): ModuloCatalogo | undefined => catalogo.find(m => m.type === t);
  const directions = await direccionesTodas(full);
  const electrico = await analizarCircuito(conPlaca(full), buscarDef, {
    nivelesReales: true,
    direccionesPorPlaca: directions, nivelesPorPlaca: runningProject === full.name ? nivelesPorPlaca : new Map(), cerrados: cerradosDe(full.name), fuentesApagadas: fuentesApagadasDe(full),
  });
  const starts: { boardId: string; board: string; language: Language; placa: Placa; engine: string; target: Emulador }[] = [];
  for (const b of boards) {
    if (cancelled()) return cancelledResult();
    const power = electrico.alimentacionesPorPlaca?.[b.id] ?? electrico.alimentacion;
    const sinArranque = motivoSinArranque(estadoAlimentacion(power, electrico.resuelto));
    if (sinArranque) {
      logBuild(`[${b.id}] [error] ${sinArranque}`);
      return { ok: false, errors: [{ line: null, file: null, message: `[${b.id}] ${sinArranque}` }], sinAlimentacion: true };
    }
    const placa = await buscarPlaca(b.board);
    if (!placa) return { ok: false, errors: [{ line: null, file: null, message: `La placa "${b.board}" no está en el catálogo.` }] };
    try { starts.push({ boardId: b.id, board: b.board, language: b.language, placa, engine: placa.desc.backend.engine, target: emuladorDe(placa.desc.backend.engine, b.id) }); }
    catch (error) { return { ok: false, errors: [{ line: null, file: null, message: (error as Error).message }] }; }
  }
  let result = lastBuild?.project === full.name && !forceBuild ? lastBuild.result : null;
  if (!result?.ok || !result.boardResults || boards.some(b => !result?.boardResults?.[b.id]?.artifacts)) {
    logBuild('Compilando las placas antes de arrancar…');
    result = await runBuild(full);
  }
  if (cancelled()) return cancelledResult();
  if (!result.ok) return { ok: false, errors: result.errors };
  await pararCorridas(false);
  if (cancelled()) return cancelledResult();
  runningProject = full.name;
  primaryBoardId = boards[0]!.id;
  emulator = starts[0]!.target;
  depurador = depuradorDe(primaryBoardId);
  niveles = nivelesDePlaca(primaryBoardId);
  controlesCerrados.clear();
  // La compilación puede tardar y el reset retiró los GPIO de la corrida anterior.
  // El primer analogRead recibe el circuito del arranque, no aquel preflight previo.
  const electricoArranque = await analizarCircuito(conPlaca(full), buscarDef, {
    nivelesReales: true, nivelesPorPlaca, direccionesPorPlaca: directions,
    cerrados: cerradosDe(full.name), fuentesApagadas: fuentesApagadasDe(full),
  });
  if (cancelled()) return cancelledResult();
  for (const s of starts) {
    const motivo = motivoSinArranque(estadoAlimentacion(electricoArranque.alimentacionesPorPlaca?.[s.boardId] ?? electricoArranque.alimentacion, electricoArranque.resuelto));
    if (motivo) {
      runningProject = null;
      return { ok: false, errors: [{ line: null, file: null, message: `[${s.boardId}] ${motivo}` }], sinAlimentacion: true };
    }
  }
  for (const s of starts) depuradorDe(s.boardId).alIniciarCorrida({ proyecto: full.name, placa: s.board, lenguaje: s.language, motor: s.engine, artefactos: result.boardResults![s.boardId]!.artifacts! });
  // Instancias registradas antes de arrancar: sus callbacks READY resuelven su propio puente.
  for (const s of starts) corridas.set(s.boardId, s.target);
  try {
    const settled = await Promise.allSettled(starts.map(async s => {
      const artifacts = result!.boardResults![s.boardId]!.artifacts!;
      const selected = { ...full, board: s.board, language: s.language };
      const enBus = chipsDelProyecto(selected, buscarDef, s.placa.desc, undefined, id => electricoArranque.resuelto && electricoArranque.modulos[id]?.ui?.on === true, s.boardId);
      for (const aviso of enBus.avisos) logBuild(`[chips] ${aviso}`, s.boardId);
      for (const c of enBus.chips) c.guardado = await leerMemoria(store.projectDir(full.name), c.id);
      if (cancelled()) throw new Error('La ejecución fue cancelada.');
      await s.target.start(full.name, artifacts, { ...ENGINES[s.engine]!.opcionesArranque(s.placa.desc, artifacts), chips: enBus.chips, arranqueMs: s.placa.desc.arranqueMs,
        analogicoAvr: estadoAnalogicoDesdeCircuito(full, s.boardId, s.placa.desc, electricoArranque),
        perfilAnalogicoAvr: full.sim.analogicoAvr?.[s.boardId],
        analogicoEsp: estadoAnalogicoEspDesdeCircuito(s.boardId, s.placa.desc, electricoArranque),
        perfilAnalogicoEsp: full.sim.analogicoEsp?.[s.boardId],
      });
      if (cancelled()) { await s.target.stop(); throw new Error('La ejecución fue cancelada.'); }
      if (artifacts.repl && !await subirPorRepl(selected, artifacts, s.boardId, s.target)) throw new Error(`No se pudo cargar el código de ${s.boardId}.`);
      if (cancelled()) { await s.target.stop(); throw new Error('La ejecución fue cancelada.'); }
      for (const pin of await pinsDeCodigo(selected, s.boardId)) s.target.getBridge()?.watch(pin);
    }));
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
  } catch (error) {
    await pararCorridas(false); runningProject = null;
    const message = (error as Error).message;
    logBuild(`[error] ${message}`);
    return { ok: false, errors: [{ line: null, file: null, message }] };
  }
  for (const s of starts) void depuradorDe(s.boardId).alArrancado();
  void refrescarEntradasDelCircuito(full.name);
  return { ok: true, errors: [] };
}

/** Todos los pines que el código del proyecto usa (archivos de código). */
/**
 * Cómo configura el programa cada pin (pinMode, Pin.OUT, output: de ESPHome...): es lo que decide,
 * como en la placa real, si un pin entrega corriente o solo escucha. Ver direccionesDeCodigo.
 */
async function direccionesDe(project: { name: string; language: Language | null }, boardId = placasDelProyecto(project as Project)[0]?.id ?? 'board'): Promise<Map<number, DireccionPin>> {
  const d = new Map<number, DireccionPin>();
  if (!project.language) return d;
  for (const f of await store.listFiles(project.name, project.language, boardId)) {
    const content = await store.readFile(project.name, f.path, project.language, boardId).catch(() => '');
    for (const [g, x] of direccionesDeCodigo(project.language, content)) d.set(g, x);
  }
  return d;
}

async function direccionesTodas(project: Project): Promise<Map<string, Map<number, DireccionPin>>> {
  return new Map(await Promise.all(placasDelProyecto(project).map(async b => [b.id, await direccionesDe({ name: project.name, language: b.language }, b.id)] as const)));
}

async function pinsDeCodigo(project: { name: string; language: Language | null; board: string | null }, boardId = placasDelProyecto(project as Project)[0]?.id ?? 'board'): Promise<number[]> {
  if (!project.language) return []; // sin placa no hay código
  const files = await store.listFiles(project.name, project.language, boardId);
  const desc = project.board ? (await buscarPlaca(project.board))?.desc : undefined;
  const pines = new Set<number>();
  for (const f of files) {
    const content = await store.readFile(project.name, f.path, project.language, boardId).catch(() => '');
    for (const pin of scanPins(project.language, content, desc)) pines.add(pin);
  }
  return [...pines].sort((a, b) => a - b);
}

// --- Alimentación de la placa ------------------------------------------------------


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
const sensadosPorPlaca = new Map<string, Map<number, 0 | 1>>();
const actualizadorElectrico = crearActualizadorElectrico(actualizarEntradasDelCircuito);

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
/** El guardado espera esta actualización: una respuesta tardía no puede ganar al corte de VCC. */
async function actualizarCamarasDelCircuito(nombre: string): Promise<void> {
  if (runningProject !== nombre || !(emulator instanceof EmulatorManager)) return;
  const target = emulator, generacion = runGeneration;
  if (!target.chipsEnCorrida().some(c => c.chip === 'arduchip')) return;
  await vigenciaElectrica.consultar(async () => {
    const original = await store.read(nombre), catalogo = await loadCatalog();
    const buscar = (t: string) => catalogo.find(m => m.type === t);
    const placa = original.board ? await buscarPlaca(original.board) : undefined;
    const r = await analizarCircuito(conPlaca(original), buscar, { nivelesReales: true, niveles, cerrados: cerradosDe(nombre), direcciones: await direccionesDe(original), fuentesApagadas: fuentesApagadasDe(original) });
    return chipsDelProyecto(original, buscar, placa?.desc, undefined, id => r.resuelto && r.modulos[id]?.ui?.on === true).chips;
  }, chips => target.actualizarCamaras(chips),
  () => runningProject === nombre && generacion === runGeneration && emulator === target);
}

/**
 * Le avisa al firmware lo que sus pines de entrada leen **del circuito** (idea del PR #5): la
 * tensión del nodo donde está cableado cada uno, resuelta por el motor con los pull internos que
 * activó el programa y los umbrales del chip (VIL/VIH). Así un mismo interruptor puede cortar la
 * corriente de una carga y a la vez ser leído por otro pin, y un pulsador mal cableado no "anda"
 * por arte de magia: como en la mesa.
 *
 * Una lectura indefinida (entre VIL y VIH, o un pin flotando) no se manda: el pin conserva lo que
 * tenía por política del puente; no simula histéresis ni ruido físico. Se agrupa a 50 ms porque un LED que
 * parpadea manda muchos cambios de salida y cada uno obliga a resolver el circuito de nuevo.
 */
function refrescarEntradasDelCircuito(nombre: string): Promise<void> {
  return actualizadorElectrico.solicitar(nombre);
}


async function actualizarEntradasDelCircuito(nombre: string): Promise<void> {
  try {
    if (runningProject !== nombre || ![...corridas.values()].some(e => e.getStatus().state === 'bridge')) return;
    const generacion = runGeneration;
    await vigenciaElectrica.consultar(async () => {
      const catalogo = await loadCatalog();
      const buscar = (t: string): ModuloCatalogo | undefined => catalogo.find(m => m.type === t);
      const original = await store.read(nombre);
      const r = await analizarCircuito(conPlaca(original), buscar, {
        nivelesReales: true, nivelesPorPlaca, cerrados: cerradosDe(nombre), direccionesPorPlaca: await direccionesTodas(original),
      });
      return { original, buscar, r };
    }, async ({ original, buscar, r }, vigente) => {
      const alimentacionChips = Object.fromEntries(original.modules.map(m => [m.id, r.resuelto && r.modulos[m.id]?.ui?.on === true]));
      for (const target of corridas.values()) target.actualizarAlimentacionChips(alimentacionChips);
      for (const b of placasDelProyecto(original)) {
        const descriptor = buscar(b.board)?.board;
        if (descriptor) {
          const target = corridas.get(b.id);
          target?.actualizarAnalogicoAvr?.(estadoAnalogicoDesdeCircuito(original, b.id, descriptor, r));
          target?.actualizarAnalogicoEsp?.(estadoAnalogicoEspDesdeCircuito(b.id, descriptor, r));
        }
      }
      const placa = original.board ? await buscarPlaca(original.board) : undefined;
      if (!vigente()) return;
      const chips = chipsDelProyecto(original, buscar, placa?.desc, undefined, id => r.resuelto && r.modulos[id]?.ui?.on === true);
      (emulator as Emulador & { actualizarCamaras?: (cs: import('./bus/proyectoChips.js').ChipEnBus[]) => void }).actualizarCamaras?.(chips.chips);
      await aplicarAlimentacionCalculada(original, r, vigente);
      if (!vigente()) return;
      for (const e of r.entradas) {
        const boardId = e.boardId ?? primaryBoardId;
        const target = corridas.get(boardId);
        const bridge = target?.getBridge();
        if (!bridge || target?.getStatus().state !== 'bridge') continue;
        const sensados = sensadosPorPlaca.get(boardId) ?? new Map<number, 0 | 1>();
        sensadosPorPlaca.set(boardId, sensados);
        if (e.nivel === null || sensados.get(e.gpio) === e.nivel) continue;
        sensados.set(e.gpio, e.nivel);
        bridge.setInput(e.gpio, e.nivel);
        depuradorDe(boardId).alEntrada(e.gpio, e.nivel, 'circuito');
      }
    }, () => runningProject === nombre && generacion === runGeneration);
  } catch (err) {
    console.error(`[entradas] no se pudo leer el circuito: ${(err as Error).message}`);
  }
}


async function alimentacionDe(project: Project): Promise<EstadoPlaca> {
  const catalogo = await loadCatalog();
  const buscar = (t: string): ModuloCatalogo | undefined => catalogo.find((m) => m.type === t);
  const { alimentacion, resuelto } = await analizarCircuito(conPlaca(project), buscar, {
    nivelesReales: true,
    direccionesPorPlaca: await direccionesTodas(project),
    nivelesPorPlaca, cerrados: cerradosDe(project.name), fuentesApagadas: fuentesApagadasDe(project),
  });
  return estadoAlimentacion(alimentacion, resuelto);
}


/** Detiene sólo las placas cuyo diagnóstico no permite continuar; conserva las otras corridas. */
async function aplicarAlimentacionCalculada(p: Project, r: AnalisisCircuito, vigente: () => boolean): Promise<void> {
  if (!vigente()) return;
  const diagnosticos = placasDelProyecto(p).map(b => ({
    id: b.id,
    motivo: motivoSinArranque(estadoAlimentacion(r.alimentacionesPorPlaca?.[b.id] ?? r.alimentacion, r.resuelto)),
  }));
  const paradas = await pararPlacasSinEnergia(diagnosticos, new Map(corridas), vigente);
  if (!vigente()) return;
  for (const id of paradas) {
    nivelesPorPlaca.delete(id);
    sensadosPorPlaca.delete(id);
    eventosEmulador.onLog(`[alimentación] [${id}] ${diagnosticos.find(d => d.id === id)?.motivo} Se detuvo esta placa.`);
  }
  if (paradas.length && ![...corridas.values()].some(e => e.getStatus().running)) runningProject = null;
}


/** Después de cambiar el dibujo se vuelve a comprobar la alimentación de cada placa. */
async function revisarAlimentacion(nombre: string): Promise<void> {
  const generacion = runGeneration;
  await vigenciaElectrica.consultar(async () => {
    const p = await store.read(nombre);
    if (!p.board) return null; // sin placa no hay nada que se quede sin energía
    const catalogo = await loadCatalog();
    const r = await analizarCircuito(conPlaca(p), t => catalogo.find(m => m.type === t), {
      nivelesReales: true,
      nivelesPorPlaca: runningProject === nombre ? nivelesPorPlaca : undefined, direccionesPorPlaca: await direccionesTodas(p),
      cerrados: cerradosDe(nombre), fuentesApagadas: fuentesApagadasDe(p),
    });
    return { p, r };
  }, async (resultado, vigente) => {
    if (resultado) await aplicarAlimentacionCalculada(resultado.p, resultado.r, vigente);
  }, () => runningProject === nombre && generacion === runGeneration);
}

function reemplazarPlaca(_nombre: string, _boardId?: string): boolean {
  // Compatibilidad del endpoint: ya no existe un historial de averías inferidas sin modelo.
  return false;
}

/** Avisos de circuito ↔ código (11.6) + Ley de Ohm (cortocircuitos, sobrecorriente): lo que ve la UI y el MCP. */
/**
 * PWM que declaró el firmware de una placa, por GPIO. Solo la placa que está corriendo lo tiene:
 * un proyecto que no corre no tiene PWM, y por eso un buzzer pasivo no suena parado.
 */
function pwmDePlaca(boardId: string): ReadonlyMap<number, PwmPin> {
  const corrida = corridas.get(boardId);
  if (!corrida || !('estadoPwm' in corrida)) return new Map();
  const con = corrida as { estadoPwm: () => ReadonlyMap<number, PwmPin> };
  return typeof con.estadoPwm === 'function' ? con.estadoPwm() : new Map();
}

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
    resuelto: boolean;
    leds: LedElectrico[];
    fuentes: FuenteElectrica[];
    placa: EstadoPlaca | null;
    placas: Record<string, EstadoPlaca>;
    energizado: boolean;
    tensiones: Record<string, number>;
    mediciones: { modulo: string; moduloNombre: string; elemento: string; tipo: string; tensionV: number; corrienteMa: number; potenciaMw: number; resistenciaOhm: number | null }[];
    /** Estado visible que decidió el modelo de cada módulo (`observar` → ui), con la física en vivo. */
    modulos: Record<string, { on?: boolean; brillo?: number }>;
    /**
     * Qué suena y cómo, para que el navegador lo sintetice (ver docs/audio.md). Viaja por la
     * misma instantánea que `modulos` a propósito: el sonido y la luz de un módulo salen del
     * mismo cálculo y tienen que llegar juntos.
     */
    sonidos: EventoSonido[];
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
  const direccionesPorPlaca = await direccionesTodas(project);
  const direcciones = direccionesPorPlaca.get(placasDelProyecto(project)[0]?.id ?? 'board') ?? new Map<number, DireccionPin>();
  const levels = project.name === runningProject ? nivelesPorPlaca : new Map<string, Map<number, 0 | 1>>();
  const vivo = await analizarCircuito(conLaPlaca, buscar, { nivelesReales: true, nivelesPorPlaca: levels, cerrados, fuentesApagadas, estados, direccionesPorPlaca });
  // Lo que cada modelo quiere recordar vuelve en el próximo cálculo (solo del vivo: los otros son hipotéticos).
  for (const [id, m] of Object.entries(vivo.modulos)) if (m.estado) estados.set(id, m.estado);
  estadosModulos.set(project.name, estados);
  const placa = project.board ? estadoAlimentacion(vivo.alimentacion, vivo.resuelto) : null;
  // Misma instantánea para UI, medidas y diagnóstico: LED activo bajo o entre dos
  // GPIO depende de niveles reales. Todos-altos/todos-bajos no son un peor caso general.
  const leds = vivo.leds;
  const { avisos: electricos, fuentes } = vivo;
  return {
    pins,
    electrico: {
      resuelto: vivo.resuelto,
      leds, fuentes, placa, energizado: proyectoEnergizado === project.name, tensiones: vivo.tensiones,
      placas: Object.fromEntries(Object.entries(vivo.alimentacionesPorPlaca ?? {}).map(([id, a]) => [id, estadoAlimentacion(a, vivo.resuelto)])),
      mediciones: vivo.elementos.map((e) => {
        const inst = project.modules.find((m) => m.id === e.dueno);
        const def = inst ? buscar(inst.type) : undefined;
        return {
          modulo: e.dueno,
          moduloNombre: e.dueno === 'board' ? 'Placa' : def?.name ?? e.dueno,
          elemento: e.local,
          tipo: e.tipo,
          tensionV: e.va - e.vb,
          corrienteMa: e.i * 1000,
          potenciaMw: e.p * 1000,
          resistenciaOhm: e.ohms ?? null,
        };
      }),
      modulos: Object.fromEntries(Object.entries(vivo.modulos).map(([id, m]) => [id, m.ui ?? {}])),
      sonidos: sonidosDelCircuito(
        project.modules, (t) => buscar(t)?.salidas, vivo.tensiones,
        (id) => vivo.modulos[id]?.ui,
        // El PWM está indexado por GPIO de la placa; gpioDe sigue el cableado (y los passthrough).
        (id, pin) => {
          if (project.name !== runningProject) return undefined;
          for (const placa of placasDelProyecto(project)) {
            const gpio = gpioDe(project, id, pin, buscar, placa.id);
            if (gpio === null) continue;
            const pwm = pwmDePlaca(placa.id).get(gpio);
            if (pwm) return pwm;
          }
          return undefined;
        },
      ),
    },
    warnings: [
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
    await pararCorridas();
    runningProject = null;
    controlesCerrados.clear();
    if (proyectoEnergizado) energizar(proyectoEnergizado, false);
  },
  resetear: () => resetearCorridas(),
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
  enviarRf: (bits, protocolo, canalRf) => entregarRf(bits, protocolo, canalRf),
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
      const boardId = m.boardId ?? primaryBoardId;
      const target = m.boardId ? corridas.get(boardId) : emulator;
      if (!target) { ws.send(JSON.stringify({ type: 'error', message: 'La placa no está ejecutándose.' })); return; }
      switch (m.type) {
        case 'pin.in':
          target.getBridge()?.setInput(m.pin, m.level);
          depuradorDe(boardId).alEntrada(m.pin, m.level, 'ui');
          break;
        case 'pin.watch':
          target.getBridge()?.watch(m.pin);
          break;
        case 'rf.send':
          void transmitirPorCanalRf(m.bits, m.protocol, m.canalRf, (bits, protocolo, canalRf) => entregarRf(bits, protocolo, canalRf, boardId)).then(r => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'rf.result', boardId, bits: m.bits, protocol: m.protocol, entregado: r.entregado, evaluacion: { ...r.evaluacion } } satisfies ServerEvent));
            if (!r.entregado && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: `RF sin entrega: ${r.evaluacion.estado}. ${r.evaluacion.advertencias.join(' ')}` }));
          }).catch(error => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: `RF: ${error instanceof Error ? error.message : String(error)}` }));
          });
          break;
        case 'console.input':
          target.writeConsole(m.data);
          break;
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
}

/** La misma guarda protege inyección MCP y WebSocket, también en modo funcional. */
async function entregarRf(bits: string, protocolo: number, canalRf?: unknown, boardId = primaryBoardId): Promise<boolean> {
  const target = corridas.get(boardId) ?? (boardId === primaryBoardId ? emulator : undefined);
  if (!target || target.getStatus().state !== 'bridge' || !target.getBridge()) return false;
  validarTramaRf(target, bits, protocolo);
  if (canalRf === undefined) return enviarTramaRf(target, bits, protocolo);
  const nombre = runningProject, generacion = runGeneration;
  if (!nombre) return false;
  let entregado = false;
  await vigenciaElectrica.consultar(async () => {
    const catalogo = await loadCatalog();
    const buscar = (tipo: string) => catalogo.find(m => m.type === tipo);
    const proyecto = conPlaca(await store.read(nombre));
    const analisis = await analizarCircuito(proyecto, buscar, {
      nivelesReales: true, nivelesPorPlaca, direccionesPorPlaca: await direccionesTodas(proyecto), cerrados: cerradosDe(nombre),
    });
    return { proyecto, buscar, analisis };
  }, ({ proyecto, buscar, analisis }, vigente) => {
    const destino = validarDestinoRf(proyecto, buscar, boardId, analisis, canalRf);
    if (!destino.permitirRecepcion) throw new Error(`Destino RF no acreditado: ${destino.problemas.join('; ')}`);
    if (vigente()) entregado = enviarTramaRf(target, bits, protocolo);
  }, () => generacion === runGeneration && nombre === runningProject && corridas.get(boardId) === target);
  return entregado;
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

  const close = async (): Promise<void> => {
    await pararCorridas();
    await Promise.all([...new Set(instancias.values())].map(e => e.shutdown()));
    // Sin esto, close() espera a que el navegador suelte el WebSocket: nunca termina.
    for (const ws of clients) ws.terminate();
    await logger.close();
  };
  const shutdown = async (): Promise<void> => {
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  return { close, port: PORT };
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
