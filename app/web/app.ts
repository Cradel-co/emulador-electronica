import { riesgoDesdeFisica, salidaDesdeFisica } from './estado-electrico.js';
// Orquestación del frontend: componentes persistentes y efectos contra la API local.
import { resolveWorkspaceSelection } from './navigation-selection.js';
import { createWorkspaceNavigation, type WorkspaceRoute } from './navigation.js';
import { crearControladorCamara, detenerCamarasDeOtrosProyectos, desconectarCamara, eventoCamara, solicitarCaptura, errorCamara } from './camera.js';
// Frontend sin bundler: ES modules nativos contra la API local (sección 11).
import { miniatura, ponerImagenPantalla } from './modulos.js';
import { lenguajeDeArchivo, NOMBRE_LENGUAJE, resaltar } from './editor.js';
import { crearDepuracion } from './depuracion.js';
import { crearEditorMicroPython } from './editor-micropython.js';
import { editorPreferences, subscribeEditorPreferences } from './editor-preferences.js';
import { destinoGpio, gpioEnPlaca } from './gpio-destination.js';
import { placasDelProyecto } from './project-boards.js';
import { carpetaDeArchivo, rutaNuevaEntrada, type EntryCreationContext, type EntryKind, type BoardFileTree } from './file-tree.js';
import { defaultDockLayout, normalizeDockLayout, setDockWindowOpen, type DockNode, type DockLayout, type WindowId } from './docking-layout.js';
import { projectDockLayout, saveProjectDockLayout, defaultSavedDockLayout, saveDefaultDockLayout, resetDefaultDockLayout, projectDockFilter, saveProjectDockFilter, clearProjectDockLayout } from './docking-storage.js';
import { formatMicroPython } from './micropython-format.js';
import { montarReact } from './react/montar.js';
import { alLienzoListo, registrarAcciones, registrarCtx, registrarEstado, registrarMenu, registrarPaleta, registrarVistas } from './react/puente.js';
import { ahora, notificar, observable } from './react/estado.js';
import { NOMBRE_LENGUAJE_PROYECTO, SIN_PLACA } from './constantes.js';
import {
  cablesDe as cablesDePuro, esPinSinAlimentar as esPinSinAlimentarPuro, NOMBRE_KIND,
  nombrePinGpio as nombrePinGpioPuro,
  nombreRef as nombreRefPuro, pinesSinAlimentar as pinesSinAlimentarPuro,
} from './consultas.js';
import { fmtMa, fmtV } from './formato.js';
import { contenidoAprendizaje, leccionPorId } from './aprendizaje/contenido.js';
import { almacenLocalAprendizaje, asociarProyecto, CLAVE_PROGRESO_APRENDIZAJE, completarLeccion, quitarAsociacionProyecto, registrarPaso, registroDeLeccion, restablecerRespaldoProgreso } from './aprendizaje/progreso.js';
import { crearConRecuperacion } from './aprendizaje/practica.js';

/**
 * Id de esta pestaña: el server lo devuelve en los eventos para no recargar los cambios propios.
 * `crypto.randomUUID` solo existe en contextos seguros (HTTPS o localhost): si la UI se sirve por
 * http://<ip-de-tailscale> la API no está y sin este fallback el módulo entero revienta al cargar.
 */
const CLIENTE = globalThis.crypto?.randomUUID?.() ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Buscadores por id. Devuelven el tipo concreto que el elemento tiene en el HTML: `$` es
 * el comodín, y los otros cinco existen para no perder `.value` / `.disabled` / `.showModal()`.
 * El `as` es seguro porque el id no cambia entre el HTML y acá; si el elemento no estuviera,
 * el error lo daria la primera lectura de la propiedad, no el typecheck.
 */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;
const inp = (id: string) => document.getElementById(id) as HTMLInputElement;
const ta = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
const sel = (id: string) => document.getElementById(id) as HTMLSelectElement;
/** Diálogo de nuevo proyecto. */
const dlg = () => document.getElementById('dlg-nuevo') as HTMLDialogElement;

/** Id fijo de la placa en el dibujo (shared/project.ts). */
const BOARD_ID = 'board';

// Pines de la DevKitC-1 que usa la propia simulación (guía 6.3 y 8.2).
/** Los del ESP32-S3: solo si el server no manda el descriptor de la placa (versiones viejas). */
const PINES_BLOQUEADOS_S3 = new Map([
  [17, 'lo usa el puente de simulación (UART1 TX)'],
  [18, 'lo usa el puente de simulación (UART1 RX)'],
  [43, 'es la consola del emulador (UART0 TX)'],
  [44, 'es la consola del emulador (UART0 RX)'],
]);
/** @type {(ns: number[], motivo: string) => [number, string][]} */
const conMotivo = (ns, motivo) => ns.map((n) => [n, motivo]);
const PINES_ADVERTENCIA_S3 = new Map([
  ...conMotivo([0, 3, 45, 46], 'pin de arranque (strapping): mejor no usarlo'),
  ...conMotivo([19, 20], 'USB nativo del ESP32-S3'),
  ...conMotivo([35, 36, 37], 'lo ocupa la PSRAM en los módulos N8R8/N16R8'),
  ...conMotivo([47], 'la simulación no lo acepta como entrada'),
  ...conMotivo([48], 'LED RGB integrado en algunas revisiones de la placa'),
]);

/** Orden de las categorías en el catálogo. */
const ORDEN_CATEGORIAS = ['Placas', 'Entradas', 'Salidas', 'Pasivos', 'Radio 433 MHz', 'Inalámbricos'];

/**
 * Estado de la UI. Envuelto en `observable` para que los componentes de React se enteren cuando
 * algo cambia (#9): escribirle un campo acá avisa solo, sin que haya que tocar nada más.
 * Las mutaciones de adentro de un Map o un array no se ven: para esas está `notificar()`.
 */
const state = observable({
  proyectos: [],
  proyecto: null,
  aprendizajeRuta: null as { leccion?: string; paso?: string } | null,
  leccionPracticaId: null as string | null,
  revisionProgresoAprendizaje: 0,
  creandoPracticaAprendizaje: false,
  archivos: [],
  carpetas: [] as string[],
  exploradorPlacas: [] as BoardFileTree[],
  creacionEntrada: null as EntryCreationContext | null,
  activo: null,
  placaActivaId: (null as string | null),
  distribucion: defaultDockLayout(),
  distribucionMensaje: '',
  /** @type {Map<string, any>} */
  catalogo: new Map(),
  /** Chips con lógica (GET /api/chips): id → nombre, entorno que miden, hoja de datos, límites. */
  chips: new Map<string, any>(),
  /** Lo último que publicó cada chip en la corrida (evento chip.salida): id de instancia → salida. */
  salidasChips: new Map<string, Record<string, unknown>>(),
  filtroModulos: '',
  /** Texto del buscador de la pantalla de inicio. Lo lee <Proyectos>. */
  filtroProyectos: '',
  /** Plantillas de proyecto (GET /api/templates): las lista <OpcionesPlantillas>. */
  plantillas: ([] as { id: string; nombre: string; descripcion: string; board: string; language: string }[]),
  /** Placa elegida en el diálogo "Agregar placa": de ella salen los lenguajes que se ofrecen. */
  placaNuevaId: '',
  /** La última importación de módulos (lo muestra <ResultadoImportacion>): cargando, error o resultado. */
  importacion: (null as any),
  /** Sube cada vez que se abre la paleta de comandos: <Paleta> arranca de cero. */
  paletaVez: 0,
  /** El menú principal está abierto (lo mira <Menu> para reevaluar qué acciones están disponibles). */
  menuAbierto: false,
  /** Módulo cuyo pulsador del panel está apretado ahora (lo pinta <Controles>). */
  panelPresionado: (null as any),
  /** Se incrementan para avisarle a React de cambios dentro de un Map (ver react/estado.ts). */
  controlesVersion: 0,
  quemadosVersion: 0,
  /** Herramienta "mover" activa (barra de iconos): no deja empezar cables al tocar un pin, para
   * poder reacomodar módulos sobre un circuito ya cableado sin arrancar un cable por accidente. */
  modoMover: false,
  /** Dibujo del proyecto abierto: se edita en el canvas y se guarda con PUT /diagram. */
  diagrama: { modules: [], wires: [] },
  /** @type {import('./canvas.js').Seleccion} */
  seleccion: null,
  /** Pines que usa el código (GET /pins). */
  codePins: new Set(),
  lineas: { build: [], emu: [] },
  tab: 'build',
  filtro: '',
  marcas: new Map(), // línea -> mensaje
  timerGuardado: null,
  timerDiagrama: null,
  timerNota: null,
  /** Hay cambios en el editor que todavía no se guardaron. */
  editorSucio: false,
  /** Últimas notificaciones (globos), para la ventana de notificaciones. */
  notificaciones: ([] as { texto: string, hora: Date }[]),
  /** Errores de la última compilación (para la pestaña Problemas). */
  errores: ([] as { file?: string, line?: number, message: string }[]),
  /** Avisos circuito ↔ código (para la pestaña Problemas). */
  avisosDibujo: ([] as { message: string, pin?: number }[]),
  /** Placas conocidas (GET /api/boards, o las programables del catálogo si no existe). */
  placas: ([] as any[]),
  /** Hay una instantánea eléctrica resuelta; independiente de la ejecución de firmware. */
  fisicaValida: false,
  /** Veredicto del motor eléctrico por LED (GET /pins → electrico.leds): id → { mA, estado }. */
  electrico: (new Map() as Map<string, { id: string, mA: number, estado: string, mAFijo?: number }>),
  /** ¿La placa tiene con qué andar? (GET /pins → electrico.placa): estado, por dónde, mensaje, quemada. */
  alimentacion: (null as null | { estado: string; via: string | null; pin: string | null; fuenteId: string | null; consumoMa: number | null; mensaje: string; quemada: boolean }),
  /** Lo que entrega cada fuente regulable ahora (GET /pins → electrico.fuentes): V, mA, W, modo CV/CC. */
  /** Proyecto sin placa: ¿el circuito está energizado (▶)? (GET /pins → electrico.energizado) */
  energizado: false,
  /** Mediciones del solver por elemento (GET /pins → electrico.mediciones), actualizadas con el circuito. */
  mediciones: ([] as { modulo: string; moduloNombre: string; elemento: string; tipo: string; tensionV: number; corrienteMa: number; potenciaMw: number; resistenciaOhm: number | null }[]),
  /** Voltajes del solver por pin cableado (GET /pins → electrico.tensiones). */
  tensiones: ({} as Record<string, number>),
  /** Lo que el modelo de cada módulo decidió mostrar (`observar` → ui), según la física en vivo. */
  uiModulos: new Map<string, { on?: boolean; brillo?: number }>(),
  fuentes: ([] as { id: string; vAjuste: number; limiteMa: number | null; demandaMa: number | null; mA: number | null; vSalida: number; potenciaW: number; modo: string }[]),
  placaPorDefecto: '',
  /** Placa del proyecto abierto (GET /api/projects/:name → placa): nombre + descriptor `board`. */
  placa: (null as any),
  sim: {
    /** El puente está listo: los controles de los módulos funcionan. */
    listo: false,
    /** Nivel de salida de cada GPIO (pin.out). */
    niveles: new Map(),
    nivelesPorPlaca: new Map<string, Map<number, unknown>>(),
    estadosPorPlaca: new Map<string, any>(),
    placasListas: new Set<string>(),
    /** Estado de cada control por id de módulo (botón apretado, interruptor, puerta). */
    controles: new Map(),
    /** Hasta cuándo parpadea / suena cada módulo (id → timestamp). */
    flash: new Map(),
    sonando: new Map(),
    /**
     * LEDs quemados (id → cuándo y con cuántos mA). No se borra al parar la simulación ni al
     * arreglar el circuito: un LED quemado queda muerto hasta que se reemplaza, como en la realidad.
     * @type {Map<string, { hora: number, mA: number }>}
     */
    quemados: new Map(),
    boton: new Map(),
    /**
     * Cortocircuitos activos ahora mismo (clave → cuándo se detectó y qué refs "id.PIN"
     * involucra). A diferencia de un LED quemado, no es daño permanente: al arreglar el
     * cableado el aviso deja de llegar y la entrada se borra sola (ver `actualizarCortos`).
     * @type {Map<string, { hora: number, refs: string[] }>}
     */
    cortos: new Map(),
  },
});
registrarEstado(state);
window.addEventListener('storage', event => {
  if (event.key !== CLAVE_PROGRESO_APRENDIZAJE && event.key !== null) return;
  if (event.newValue === null) restablecerRespaldoProgreso(almacenLocalAprendizaje());
  state.revisionProgresoAprendizaje++;
});
// Lo que los componentes de React necesitan disparar (#9). Van por el puente y no importándose,
// para no armar un ciclo entre app.ts y los componentes.
registrarAcciones({
  crearCamara: (project, instance, camera) => crearControladorCamara(project, instance, `/api/projects/${encodeURIComponent(project)}/cameras/${encodeURIComponent(instance)}`, {
    media: navigator.mediaDevices,
    permissions: navigator.permissions,
    fetch: async (url, init) => {
      if (String(url).endsWith('/status') || String(url).endsWith('/session')) await esperarDiagramaCamara(project);
      return fetch(url, init);
    },
  }, camera),
  agregarModulo: (type) => agregarModulo(type),
  quitarDelCatalogo: (m) => void quitarDelCatalogo(m),
  filtrarModulos: (texto) => {
    state.filtroModulos = texto;
    if (state.proyecto) saveProjectDockFilter(state.proyecto.name, texto);
  },
  abrirProyecto: (nombre) => void cambiarDeProyecto(nombre),
  navegarAprendizaje: (leccion, paso) => {
    if (leccion && paso) {
      const contenido = leccionPorId(leccion);
      if (contenido) registrarPaso(almacenLocalAprendizaje(), leccion, contenido.revision, paso);
    }
    const reemplazarPasoActual = Boolean(leccion && paso
      && navegacion.current.project === null && navegacion.current.aprender?.leccion === leccion);
    void navegacion.navigate({ project: null, aprender: {
      ...(leccion ? { leccion } : {}), ...(paso ? { paso } : {}),
    } }, { replace: reemplazarPasoActual });
  },
  completarAprendizaje: (leccion, revision, paso) => {
    completarLeccion(almacenLocalAprendizaje(), leccion, revision, paso);
    void navegacion.navigate({ project: null, aprender: {} });
  },
  crearPracticaAprendizaje: (plantillaId) => void crearPracticaAprendizaje(plantillaId),
  continuarPracticaAprendizaje: (leccion) => void continuarPracticaAprendizaje(leccion),
  volverALeccionAprendizaje: () => void volverALeccionAprendizaje(),
  irAInicio: () => void navegacion.navigate({ project: null }),
  eliminarProyecto: (nombre) => void eliminarProyecto(nombre),
  eliminarModulo: (id) => eliminarModulo(id),
  eliminarCable: (indice) => eliminarCable(indice),
  desconectar: (indice) => {
    state.diagrama.wires.splice(indice, 1);
    notificar();
    guardarDiagrama();
    lienzo.render();
  },
  girar: (inst, grados, fin) => fijarRotacion(inst, grados, fin),
  cambiarProp: (inst, clave, valor) => {
    inst.props = { ...inst.props, [clave]: valor };
    notificar();
    guardarDiagrama();
    lienzo.render();
  },
  controlModulo: (inst, control, indice) => controlModulo(inst, control, indice, 'down'),
  presionarMomentario: (inst) => {
    state.panelPresionado = inst;
    controlModulo(inst, 'momentary', 0, 'down');
  },
  reemplazarQuemado: (id) => reemplazarQuemado(id),
  abrirArchivo: (ruta) => { seleccionar(null); void navegarArchivo(ruta); },
  abrirArchivoDePlaca: async (boardId, path) => {
    await navegarArchivo(path, boardId);
    if (state.placaActivaId === boardId && state.activo === path) seleccionar(null);
  },
  cargarExplorador: () => cargarExplorador(),
  nuevoArchivo: abrirNuevoArchivo,
  actualizarExplorador,
  nuevaCarpeta: (parent, boardId) => abrirCreacionEntrada('directory', parent, boardId),
  crearEntrada,
  importarModulos: abrirImportador,
  mostrarHerramienta,
  aplicarDistribucion: layout => actualizarDistribucion(normalizeDockLayout(layout)),
  guardarDistribucionPredeterminada: () => {
    saveDefaultDockLayout(state.distribucion);
    state.distribucionMensaje = 'Predeterminado guardado. Los proyectos existentes conservan su distribución.';
  },
  restaurarDistribucionProyecto: () => {
    actualizarDistribucion(defaultSavedDockLayout());
    state.distribucionMensaje = 'Este proyecto usa ahora la distribución predeterminada.';
  },
  restaurarDistribucionOriginal: () => {
    resetDefaultDockLayout();
    state.distribucionMensaje = 'Predeterminado original restablecido. Los proyectos existentes conservan su distribución.';
  },
  irALinea: (archivo, linea) => irALinea(archivo, linea),
  moverEntorno: (id, valores) => {
    void api(`/api/projects/${state.proyecto.name}/modules/${encodeURIComponent(id)}/entorno`, {
      method: 'PUT', body: JSON.stringify({ valores }),
    }).catch((err) => nota(`No se pudo mover el entorno: ${(err as Error).message}`));
  },
  agregarPlaca: () => abrirAgregarPlaca(state.placaPorDefecto || state.placas[0]?.id),
});
registrarVistas({
  nombrePlaca: () => nombrePlaca(),
  sinPlaca: () => sinPlaca(),
  textoEsperaSimulacion: () => textoEsperaSimulacion(),
});

// --- Íconos -------------------------------------------------------------

const ICONOS = {
  modulo:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/></svg>',
  cable:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H13a3 3 0 0 1 3 3v6.5"/></svg>',
};

/**
 * Bloque de estado vacío con ícono + explicación, para no dejar un panel en blanco.
 * @param {string} icono @param {string} titulo @param {string} subtexto
 */
function vacioPanel(icono, titulo, subtexto) {
  return `<div class="vacio-panel">${icono}<p>${titulo}</p><span>${subtexto}</span></div>`;
}

/** @param {string} s */
const escapar = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Globo de notificación abajo a la derecha (como los de Android Studio); queda en el historial. */
function nota(texto) {
  $('nota').textContent = texto;
  clearTimeout(state.timerNota);
  if (!texto) return;
  state.timerNota = setTimeout(() => ($('nota').textContent = ''), 7000);
  state.notificaciones.unshift({ texto, hora: new Date() });
  state.notificaciones.length = Math.min(state.notificaciones.length, 30);
  // <Notificaciones> la muestra (#9); como el array se cambia en el lugar, hay que avisar.
  notificar();
  if ($('lista-notificaciones').hidden) $('punto-notificaciones').hidden = false;
}


// --- API --------------------------------------------------------------------

async function api(path: string, opts: RequestInit = {}) {
  // content-type solo con cuerpo: Fastify rechaza (400) un JSON vacío, y Parar/Reset no mandan cuerpo.
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-cliente': CLIENTE, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
  });
  const texto = await res.text();
  const datos = texto ? JSON.parse(texto) : {};
  if (!res.ok) throw new Error(datos.error ?? `HTTP ${res.status}`);
  return datos;
}

// --- Consola ----------------------------------------------------------------

const MAX_LINEAS = 10000;

/**
 * La consola se pinta a lo sumo una vez por frame y, si no cambió la pestaña ni el filtro,
 * solo agrega las líneas nuevas: una compilación de ESPHome larga manda miles de líneas
 * seguidas y repintar todo en cada una trababa la página.
 */
const consola = {
  frame: 0,
  /** Qué hay pintado ahora en el <pre>: pestaña, filtro y cuántas líneas del arreglo ya se mostraron. */
  pintado: { tab: '', filtro: '', hasta: 0, recortes: 0 },
  /** Cuántas veces se recortó cada arreglo (si cambió, lo pintado ya no coincide: se repinta todo). */
  recortes: { build: 0, emu: 0 },
};

function log(tab, texto) {
  const lineas = state.lineas[tab];
  lineas.push(texto);
  // Recorte por tandas: `shift()` en cada línea es O(n) sobre 10.000 elementos.
  if (lineas.length > MAX_LINEAS + 1000) {
    lineas.splice(0, lineas.length - MAX_LINEAS);
    consola.recortes[tab]++;
  }
  if (state.tab === tab) pedirConsola();
}

function pedirConsola() {
  if (!consola.frame) consola.frame = requestAnimationFrame(pintarConsola);
}

function pintarConsola() {
  cancelAnimationFrame(consola.frame);
  consola.frame = 0;
  const problemas = state.tab === 'problemas';
  const debug = state.tab === 'debug';
  $('consola').hidden = problemas || debug;
  $('problemas').hidden = !problemas;
  $('debug').hidden = !debug;
  $('entrada-console').closest('label').hidden = problemas || debug;
  if (problemas) return; // la pestaña la rinde <Problemas>
  if (debug) return depuracion?.alMostrar();
  const pre = $('consola');
  const tab = state.tab;
  const lineas = state.lineas[tab];
  const filtro = state.filtro.toLowerCase();
  const p = consola.pintado;
  const alFinal = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  const pasa = (/** @type {string} */ l) => !filtro || l.toLowerCase().includes(filtro);
  if (p.tab === tab && p.filtro === filtro && p.recortes === consola.recortes[tab] && p.hasta <= lineas.length) {
    const nuevas = lineas.slice(p.hasta).filter(pasa);
    if (nuevas.length) pre.append((pre.firstChild ? '\n' : '') + nuevas.join('\n'));
  } else {
    pre.textContent = lineas.filter(pasa).join('\n');
  }
  Object.assign(p, { tab, filtro, hasta: lineas.length, recortes: consola.recortes[tab] });
  if (alFinal) pre.scrollTop = pre.scrollHeight;
}

/** Pestaña "Problemas": errores de compilación + avisos del circuito, clickeables. */

/** Contadores de problemas (pestaña y franja izquierda). */
function actualizarCuentaProblemas() {
  const n = state.errores.length + state.avisosDibujo.length;
  $('cuenta-problemas-tab').textContent = n ? String(n) : '';
  const punto = $('cuenta-problemas');
  punto.hidden = state.errores.length === 0;
  punto.textContent = String(state.errores.length);
}

// --- WebSocket --------------------------------------------------------------

let ws = null;
function conectarWS() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.project && state.proyecto?.name !== msg.project && /^(emu\.|bridge\.|pin\.|rf\.|debug\.|build\.)/.test(msg.type)) return;
    switch (msg.type) {
      case 'build.log':
        log('build', msg.line);
        break;
      case 'build.start':
        log('build', `── compilando ${msg.project} ──`);
        limpiarMarcas();
        break;
      case 'build.done':
        log(
          'build',
          msg.ok
            ? `── compilación OK en ${(msg.durationMs / 1000).toFixed(1)} s ──`
            : `── compilación FALLÓ (${(msg.durationMs / 1000).toFixed(1)} s) ──`,
        );
        if (!msg.ok && (msg.boardId ? msg.boardId === state.placaActivaId : placasDelProyecto(state.proyecto).length <= 1)) {
          mostrarErrores(msg.errors ?? []);
          mostrarVentana('der', true);
          seleccionar(null); // los errores son del código: mostrar el editor
        }
        break;
      case 'emu.log':
        log('emu', msg.boardId && placasDelProyecto(state.proyecto).length > 1 ? `[${msg.boardId}] ${msg.line}` : msg.line);
        break;
      case 'emu.state':
        aplicarEstadoEmulador(msg.status ?? { state: msg.state }, msg.boardId);
        if (!msg.boardId || msg.boardId === state.placaActivaId) depuracion?.alMensaje(msg);
        break;
      case 'bridge.state':
        $('puente').textContent = `puente: ${msg.connected ? 'conectado' : 'caído'}`;
        if (!msg.connected) {
          if (msg.boardId) state.sim.placasListas.delete(msg.boardId); else state.sim.placasListas.clear();
          marcarSimulacion(state.sim.placasListas.size > 0);
        }
        break;
      case 'bridge.ready':
        log('emu', `puente listo (protocolo ${msg.version})`);
        state.sim.placasListas.add(msg.boardId ?? placasDelProyecto(state.proyecto)[0]?.id ?? BOARD_ID);
        marcarSimulacion(true);
        break;
      case 'pin.out':
        // Un firmware que parpadea rápido manda muchos: se redibuja una vez por frame.
        const idPlaca = msg.boardId ?? placasDelProyecto(state.proyecto)[0]?.id ?? BOARD_ID;
        if (!state.sim.nivelesPorPlaca.has(idPlaca)) state.sim.nivelesPorPlaca.set(idPlaca, new Map());
        state.sim.nivelesPorPlaca.get(idPlaca)?.set(msg.pin, msg.level);
        if (idPlaca === (placasDelProyecto(state.proyecto)[0]?.id ?? BOARD_ID)) state.sim.niveles.set(msg.pin, msg.level);
        revisarQuemaduras();
        lienzo.pedirRender();
        recalcularConsumo();
        break;
      case 'rf.tx':
        log('emu', `[rf] ${nombrePlaca()} transmitió ${msg.bits} (protocolo ${msg.protocol})`);
        recibirRfTx(msg.bits);
        break;
      case 'bridge.error':
        log('emu', `[puente] error ${msg.code}: ${msg.message}`);
        break;
      case 'error':
        log('build', `[error] ${msg.message}`);
        break;
      case 'catalog.changed':
        void recargarCatalogo();
        break;
      case 'chip.entorno':
        if (msg.project === state.proyecto?.name) {
          const inst = state.diagrama.modules.find((m) => m.id === msg.id);
          if (inst) inst.entorno = { ...inst.entorno, ...msg.entorno };
          // El panel es de React (#9): alcanza con avisar. Antes había que esquivar el repintado
          // para no perder el foco del control; ahora el valor es estado del componente.
          notificar();
        }
        break;
      case 'camera.capture.request':
        solicitarCaptura(msg.project, msg.instance, msg.requestId);
        break;
      case 'camera.state':
        eventoCamara(msg.project, msg.instance, msg.state);
        break;
      case 'chip.salida':
        if (msg.id.endsWith(':arduchip') && typeof msg.salida.cameraError === 'string') errorCamara(msg.project, msg.id.slice(0, -':arduchip'.length), msg.salida.cameraError);
        if (msg.project === state.proyecto?.name) {
          state.salidasChips.set(msg.id, msg.salida);
          // Una pantalla refresca seguido: se cambia solo su imagen, sin redibujar todo el circuito.
          const imgs = document.querySelectorAll(`#lienzo image[data-pantalla-de="${CSS.escape(msg.id)}"]`);
          const inst = state.diagrama.modules.find((m) => m.id === msg.id);
          const color = String(inst?.props?.color ?? state.catalogo.get(inst?.type)?.props?.color?.default ?? 'blanco');
          if (imgs.length) for (const img of imgs) ponerImagenPantalla(img, state.sim.listo ? msg.salida : undefined, color);
          else if (msg.salida?.tipo === 'pantalla') lienzo.render();
        }
        break;
      case 'debug.stopped':
      case 'debug.continued':
      case 'debug.trace':
      case 'debug.exception':
        if (msg.boardId && msg.boardId !== state.placaActivaId) break;
        depuracion?.alMensaje(msg);
        if (msg.type === 'debug.stopped') $('punto-debug').hidden = false;
        if (msg.type === 'debug.continued') $('punto-debug').hidden = true;
        break;
      case 'project.changed':
        if (msg.project === state.proyecto?.name && msg.origin !== CLIENTE) void aplicarCambioExterno(msg);
        break;
    }
  };
  // Una conexión nueva no trae historia: `pin.out` y los controles solo viajan cuando algo cambia,
  // y los `pin.watch` se registran por conexión. Sin resincronizar, lo que cambió mientras el
  // WebSocket estaba caído no se entera nunca (issue #8).
  ws.onopen = () => { if (state.proyecto) void resincronizar(); };
  ws.onclose = () => { desconectarCamara(); setTimeout(conectarWS, 1500); };
}

/**
 * Trae del server el estado que no se puede deducir de los eventos: niveles de salida, controles
 * cerrados y estado del emulador. Se usa al reconectar; en la carga inicial lo hace `main()`.
 */
async function resincronizar() {
  const emu = await api('/api/emulator').catch(() => null);
  if (!emu?.status) return;
  if (emu.running && emu.running !== state.proyecto?.name) { marcarSimulacion(false); return; }
  aplicarEstadoEmulador(emu.status);
  aplicarEstadoEnVivo(emu);
  if (emu.status.running) vigilarSalidasDelDibujo();
  await refrescarAvisos();
}

/**
 * Pisa los niveles de pin y los controles con los del server: es él quien tiene la verdad, y lo
 * que tuviéramos de antes puede ser de una corrida anterior. Al terminar se repinta: un LED que
 * quedó encendido en pantalla con el pin ya en 0 se apaga acá.
 */
function aplicarEstadoEnVivo(emu) {
  state.sim.niveles.clear();
  state.sim.nivelesPorPlaca.clear();
  state.sim.estadosPorPlaca.clear();
  state.sim.placasListas.clear();
  for (const [id, status] of Object.entries(emu.boards ?? {})) {
    state.sim.estadosPorPlaca.set(id, status);
    if ((status as { state?: string }).state === 'bridge') state.sim.placasListas.add(id);
  }
  if (emu.boards && !sinPlaca()) {
    const actual = state.sim.estadosPorPlaca.get(state.placaActivaId) ?? emu.status;
    if (actual) aplicarEstadoEmulador(actual, state.placaActivaId ?? undefined);
  }
  for (const [id, niveles] of Object.entries(emu.nivelesPorPlaca ?? {})) state.sim.nivelesPorPlaca.set(id, new Map(Object.entries(niveles as Record<string, unknown>).map(([pin, level]) => [Number(pin), level])));
  for (const [pin, nivel] of Object.entries(emu.niveles ?? {})) state.sim.niveles.set(Number(pin), nivel);
  const principal = placasDelProyecto(state.proyecto)[0]?.id ?? BOARD_ID;
  if (!state.sim.nivelesPorPlaca.has(principal)) state.sim.nivelesPorPlaca.set(principal, new Map(state.sim.niveles));
  state.sim.controles.clear();
  for (const id of emu.cerrados ?? []) state.sim.controles.set(id, true);
  revisarQuemaduras();
  lienzo.pedirRender();
  recalcularConsumo();
}

function enviar(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const NOMBRE_ESTADO = {
  stopped: 'detenido',
  starting: 'compilando / arrancando…',
  booted: 'arrancó',
  wifi: 'WiFi conectado',
  bridge: 'corriendo',
  crashed: 'se reinició con error',
  hung: 'colgado',
};

/** ¿El proyecto abierto es sin placa (solo circuito)? */
const sinPlaca = (): boolean => Boolean(state.proyecto) && placasDelProyecto(state.proyecto).length === 0;

/**
 * Proyecto sin placa: ▶/⏹ prenden y apagan el circuito (no hay emulador). Se ve igual que
 * la simulación corriendo: "En vivo", ⏹ habilitado y los controles de los módulos activos.
 */
function aplicarEnergia() {
  const on = state.energizado;
  $('estado').textContent = on ? 'energizado' : 'apagado';
  $('estado').dataset.s = on ? 'bridge' : 'stopped';
  document.body.classList.toggle('corriendo', on);
  btn('ejecutar').disabled = on;
  btn('parar').disabled = !on;
  btn('abrir-web').disabled = true;
  btn('recargar').disabled = true;
  marcarSimulacion(on);
}

function aplicarEstadoEmulador(status, boardId?: string) {
  if (boardId) state.sim.estadosPorPlaca.set(boardId, status);
  const boardStates = placasDelProyecto(state.proyecto).map(b => state.sim.estadosPorPlaca.get(b.id)).filter(Boolean);
  if (boardId) {
    if (status.state === 'bridge') state.sim.placasListas.add(boardId);
    else state.sim.placasListas.delete(boardId);
  }

  if (boardId) status = state.sim.estadosPorPlaca.get(state.placaActivaId) ?? status;
  // El emulador es global: en un proyecto sin placa, ▶/⏹ siguen a la energía del circuito.
  if (sinPlaca()) return aplicarEnergia();
  $('estado').textContent = NOMBRE_ESTADO[status.state] ?? status.state;
  $('estado').dataset.s = status.state;
  const corriendo = boardId && boardStates.length ? boardStates.some(s => s.running) : Boolean(status.running);
  document.body.classList.toggle('corriendo', corriendo);
  btn('ejecutar').disabled = corriendo;
  btn('parar').disabled = !corriendo;
  const web = status.ports?.web;
  btn('recargar').disabled = !corriendo;
  btn('abrir-web').disabled = !(corriendo && web && status.usesWeb !== false);
  btn('abrir-web').dataset.url = web ? `http://127.0.0.1:${web}` : '';
  marcarSimulacion(boardId ? state.sim.placasListas.size > 0 : status.state === 'bridge');
  // Por si el panel de un módulo está abierto mostrando "Apretá Ejecutar": que pase a "esperando..." sin
  // que haga falta reseleccionarlo (marcarSimulacion no repinta en los estados intermedios, solo al llegar a "bridge").
  pintarPanelDerecho();
}

/**
 * Pide al server que vigile las salidas que hay en el dibujo (las del código ya las vigila él).
 * Los watch viven en la conexión: cada WebSocket nuevo arranca sin ninguno, así que esto hay que
 * repetirlo al reconectar o los cambios de pin dejan de llegar (issue #8).
 */
function vigilarSalidasDelDibujo() {
  for (const inst of state.diagrama.modules) {
    const def = state.catalogo.get(inst.type);
    if (def?.bridge?.role !== 'output') continue;
    const gpio = gpioDe(inst.id, def.bridge.pin);
    const destino = destinoGpioDe(inst.id, def.bridge.pin);
    if (destino) enviar({ type: 'pin.watch', pin: gpio, boardId: destino.boardId });
  }
}

function marcarSimulacion(listo) {
  if (state.sim.listo === listo) return;
  state.sim.listo = listo;
  if (listo) {
    vigilarSalidasDelDibujo();
  } else {
    state.sim.niveles.clear();
    state.sim.nivelesPorPlaca.clear();
    state.sim.controles.clear();
    // Sin alimentación las pantallas se apagan (la RAM del controlador se pierde).
    state.salidasChips.clear();
    // Al parar se sueltan los interruptores (el server también): hay que recalcular la corriente.
    void refrescarAvisos();
  }
  $('ayuda-lienzo').textContent = listo
    ? sinPlaca()
      ? 'Circuito energizado: usá los pulsadores e interruptores. ⏹ lo apaga.'
      : 'Simulación corriendo: usá los controles de los módulos (botones, interruptores, control remoto).'
    : 'Para cablear: click en un pin y después en otro.';
  $('badge-modo').hidden = !listo;
  document.body.classList.toggle('simulando', listo);
  lienzo.render();
  pintarPanelDerecho(); // si hay un módulo seleccionado, sus controles aparecen/desaparecen con el modo
}

// --- Editor -----------------------------------------------------------------

const ALTO_LINEA = 19.5; // igual a --alto-linea en style.css
/** Padding superior del editor (el mismo en el textarea, el resaltado y el gutter). */
const PAD_EDITOR = 8;

const editor = {
  frame: 0,
  /** Cantidad de líneas pintadas en el gutter: solo se rearma si cambia. */
  lineas: 0,
  lenguaje: 'texto',
};

let microPythonActivo = false;
let proyectoEditor: string | null = null;
let placaEditor: string | null = null;
const queryPlaca = (id = state.placaActivaId) => id && id !== 'board' ? `?boardId=${encodeURIComponent(id)}` : '';
const urlArchivo = (proyecto: string, ruta: string, id = state.placaActivaId) => `/api/projects/${encodeURIComponent(proyecto)}/files/${ruta.split('/').map(encodeURIComponent).join('/')}${queryPlaca(id)}`;
const microPython = crearEditorMicroPython($('editor-micropython'), {
  change: (text) => {
    ta('editor').value = text; // puente para integraciones que leen el textarea legacy
    state.editorSucio = true;
    state.marcas.clear();
    state.errores = [];
    actualizarCuentaProblemas();
    guardarAuto();
  },
  cursor: (line, column) => { $('pos-cursor').textContent = state.activo ? `${line}:${column}` : ''; },
  breakpoint: (line) => {
    if (depuracionPlacaDisponible()) depuracion?.alternarBreakpointEnCursor(line);
    else nota('Seleccioná una placa en el circuito para depurar.');
  },
});
subscribeEditorPreferences(() => microPython.preferences(editorPreferences()));

let formateandoMicroPython = false;
async function formatearMicroPython() {
  if (!microPythonActivo || !state.activo || formateandoMicroPython) return;
  const proyecto = state.proyecto?.name;
  const archivo = state.activo;
  const revision = microPython.version();
  const fuente = microPython.text();
  const sangria = editorPreferences().indentWidth;
  formateandoMicroPython = true;
  notificar();
  try {
    const resultado = await formatMicroPython(fuente, archivo, sangria);
    if (!microPythonActivo || state.proyecto?.name !== proyecto || state.activo !== archivo || microPython.version() !== revision || editorPreferences().indentWidth !== sangria) {
      nota('El archivo cambió durante el formateo: se conservaron tus cambios.');
      return;
    }
    microPython.format(resultado);
  } catch (e) { nota(`No se pudo formatear: ${String((e as Error)?.message ?? e)}`); }
  finally { formateandoMicroPython = false; notificar(); }
}

const contenidoEditor = () => microPythonActivo ? microPython.text() : ta('editor').value;
const scrollEditor = () => microPythonActivo ? microPython.scroll() : ta('editor').scrollTop;
function ponerScrollEditor(scroll: number) {
  if (microPythonActivo) microPython.setScroll(scroll);
  else ta('editor').scrollTop = scroll;
}

function pintarGutter() {
  const n = ta('editor').value.split('\n').length;
  if (n === editor.lineas) return;
  editor.lineas = n;
  $('gutter-num').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
}

/** Resalta y actualiza gutter/línea actual en el próximo frame (tipear rápido no repinta por tecla). */
function pedirEditor() {
  if (!editor.frame) editor.frame = requestAnimationFrame(pintarEditor);
}

function pintarEditor() {
  if (microPythonActivo) return;
  cancelAnimationFrame(editor.frame);
  editor.frame = 0;
  const t = ta('editor');
  $('resaltado').innerHTML = resaltar(t.value, editor.lenguaje);
  pintarGutter();
  sincronizarScroll();
  pintarCursor();
}

function sincronizarScroll() {
  if (microPythonActivo) return;
  const t = ta('editor');
  const r = $('resaltado');
  r.scrollTop = t.scrollTop;
  r.scrollLeft = t.scrollLeft;
  $('gutter').scrollTop = t.scrollTop;
  pintarMarcas();
  pintarCursor();
  depuracion?.alScroll();
}

/** Resalta la línea del cursor y muestra "Ln, Col" en la barra de estado, como el IDE. */
function pintarCursor() {
  if (microPythonActivo) return;
  const t = ta('editor');
  const antes = t.value.slice(0, t.selectionStart);
  const linea = antes.split('\n').length;
  const col = t.selectionStart - antes.lastIndexOf('\n');
  const la = $('linea-actual');
  la.style.transform = `translateY(${PAD_EDITOR + (linea - 1) * ALTO_LINEA - t.scrollTop}px)`;
  la.hidden = document.activeElement !== t;
  $('pos-cursor').textContent = state.activo ? `${linea}:${col}` : '';
}

function pintarMarcas() {
  const erroresArchivo = state.errores.flatMap(e => e.line && (!e.file || e.file === state.activo || e.file.endsWith('/' + state.activo))
    ? [{ line: e.line, message: e.message }] : []);
  if (microPythonActivo) {
    microPython.errors(erroresArchivo);
    return;
  }
  const cont = $('marcas');
  cont.textContent = '';
  for (const { line: linea, message: msg } of erroresArchivo) {
    const div = document.createElement('div');
    div.className = 'marca-error';
    div.style.top = `${(linea - 1) * ALTO_LINEA - ta('editor').scrollTop}px`;
    div.textContent = `línea ${linea}: ${msg}`;
    cont.append(div);
  }
}

function mostrarErrores(errores) {
  limpiarMarcas();
  // La lista de debajo del editor y la pestaña Problemas las rinde React (#9) a partir de esto.
  state.errores = errores;
  for (const e of errores) if (e.line) state.marcas.set(e.line, e.message);
  pintarMarcas();
  actualizarCuentaProblemas();
}

function limpiarMarcas() {
  state.marcas.clear();
  state.errores = [];
  $('avisos').textContent = '';
  pintarMarcas();
  actualizarCuentaProblemas();
}

function editarContenido(contenido, preservarErrores = false) {
  proyectoEditor = state.proyecto?.name ?? null;
  placaEditor = state.placaActivaId;
  microPythonActivo = /\.py$/i.test(state.activo ?? '');
  $('editor-micropython').hidden = !microPythonActivo;
  $('editor-micropython').parentElement.classList.toggle('con-micropython', microPythonActivo);
  ta('editor').value = contenido;
  if (microPythonActivo) microPython.open(`${state.proyecto?.name}/${state.placaActivaId}/${state.activo}`, contenido);
  else microPython.hide();
  ta('editor').scrollTop = 0;
  if (preservarErrores) pintarMarcas();
  else limpiarMarcas();
  pintarEditor();
  depuracion?.alCambiarArchivo();
}

/** Abre el archivo (si hace falta) y lleva el cursor a esa línea. */
async function irALinea(archivo, linea) {
  mostrarVentana('der', true);
  seleccionar(null);
  const destino = archivo && state.archivos.some((f) => f.path === archivo) ? archivo : state.activo;
  if (destino && destino !== state.activo) await navegarArchivo(destino);
  if (microPythonActivo) { microPython.go(linea); return; }
  const t = ta('editor');
  const lineas = t.value.split('\n');
  let pos = 0;
  for (let i = 0; i < Math.min(linea - 1, lineas.length); i++) pos += lineas[i].length + 1;
  t.focus();
  t.setSelectionRange(pos, pos);
  t.scrollTop = Math.max(0, (linea - 5) * ALTO_LINEA);
  sincronizarScroll();
}

function guardarAuto() {
  clearTimeout(state.timerGuardado);
  state.timerGuardado = setTimeout(() => guardar(true), 1000);
}

async function guardar(silencioso = false) {
  if (!state.proyecto || !state.activo) return true;
  clearTimeout(state.timerGuardado);
  const proyecto = state.proyecto.name;
  const archivo = state.activo;
  const boardId = state.placaActivaId;
  const contenido = contenidoEditor();
  try {
    await api(urlArchivo(proyecto, archivo, boardId), {
      method: 'PUT',
      body: JSON.stringify({ content: contenido }),
    });
    if (state.proyecto?.name === proyecto && state.placaActivaId === boardId && state.activo === archivo && contenidoEditor() === contenido) state.editorSucio = false;
    if (!silencioso) log('build', `guardado ${archivo}`);
    void refrescarAvisos();
    return true;
  } catch (e: any) {
    log('build', `[error] no se pudo guardar: ${String(((e as Error))?.message ?? e)}`);
    return false;
  }
}


let aperturasArchivo = 0;
async function abrirArchivo(ruta) {
  const version = ++aperturasArchivo;
  if (!state.proyecto) return;
  const proyecto = state.proyecto.name;
  const boardId = state.placaActivaId;
  if (!boardId) return;
  if (state.activo && state.activo !== ruta && !await guardar(true)) return;
  if (version !== aperturasArchivo) return;
  const { content } = await api(urlArchivo(proyecto, ruta, boardId));
  // Si mientras cargaba se cambió de proyecto, este contenido es de otro: no se muestra
  // (si no, el autoguardado lo escribiría en el proyecto equivocado).
  if (version !== aperturasArchivo || state.proyecto?.name !== proyecto || state.placaActivaId !== boardId) return;
  if (state.editorSucio && state.activo !== ruta && (!await guardar(true) || state.editorSucio)) return;
  if (version !== aperturasArchivo || state.proyecto?.name !== proyecto || state.placaActivaId !== boardId) return;
  const preservarErrores = proyectoEditor === proyecto && placaEditor === boardId && Boolean(state.activo) && state.activo !== ruta;
  mostrarContenidoArchivo(ruta, content, preservarErrores);
}

/** Aplica contenido que ya se cargó: no deja una selección parcial si falla la red. */
function mostrarContenidoArchivo(ruta: string, content: string, preservarErrores = false): void {
  state.activo = ruta;
  editor.lenguaje = lenguajeDeArchivo(ruta);
  $('lenguaje-status').textContent = NOMBRE_LENGUAJE[editor.lenguaje];
  editarContenido(content, preservarErrores);
}

let seleccionPlacaVersion = 0;
/** Cambia el contexto desde el circuito o al abrir un archivo de otra placa. */
async function seleccionarPlaca(boardId: string, archivo?: string) {
  if (!state.proyecto) return;
  const version = ++seleccionPlacaVersion;
  if (state.placaActivaId === boardId) {
    if (archivo) await abrirArchivo(archivo);
    return;
  }
  const nombre = state.proyecto.name;
  try {
    if (!await guardar(true)) return;
    const anterior = state.placaActivaId;
    const resultado = await api(`/api/projects/${encodeURIComponent(nombre)}${queryPlaca(boardId)}`);
    if (version !== seleccionPlacaVersion || state.proyecto?.name !== nombre || state.placaActivaId !== anterior) return;
    if (state.editorSucio && !await guardar(true)) return;
    if (version !== seleccionPlacaVersion || state.proyecto?.name !== nombre || state.placaActivaId !== anterior) return;
    if (state.editorSucio) { nota('El archivo sigue cambiando: guardalo antes de cambiar de placa.'); return; }
    const files = resultado.files.filter(f => !/(^|\/)(secrets\.yaml|project\.json)$/.test(f.path));
    const main = archivo ? files.find(f => f.path === archivo) : files.find(f => /(^|\/)main\.py$/.test(f.path)) ?? files[0];
    const loaded = main ? await api(urlArchivo(nombre, main.path, boardId)) : null;
    if (version !== seleccionPlacaVersion || state.proyecto?.name !== nombre || state.placaActivaId !== anterior) return;
    if (state.editorSucio && (!await guardar(true) || state.editorSucio)) return;
    if (version !== seleccionPlacaVersion || state.proyecto?.name !== nombre || state.placaActivaId !== anterior) return;
    state.placaActivaId = boardId;
    depuracion?.alCambiarContexto();
    state.placa = resultado.placa ?? null;
    state.carpetas = resultado.directories ?? [];
    state.archivos = files;
    state.activo = null;
    if (main && loaded) mostrarContenidoArchivo(main.path, loaded.content);
    else editarContenido('');
    pintarPanelDerecho(); pintarWidgetsProyecto(); pintarAlimentacion(); lienzo.render();
    const status = state.sim.estadosPorPlaca.get(boardId);
    if (status) aplicarEstadoEmulador(status, boardId);
    await refrescarAvisos();
    depuracion?.alCambiarArchivo();
  } catch (e) { nota(`No se pudo abrir la placa: ${String((e as Error)?.message ?? e)}`); }
}

function abrirNuevoArchivo(parent?: string, boardId?: string) {
  abrirCreacionEntrada('file', parent, boardId);
}

function abrirCreacionEntrada(kind: EntryKind, parent = carpetaDeArchivo(state.activo), boardId = state.placaActivaId) {
  const board = placasDelProyecto(state.proyecto).find(board => board.id === boardId);
  if (!state.proyecto || !board) return;
  ahora(() => { state.creacionEntrada = { project: state.proyecto.name, boardId: board.id, parent, kind, language: board.language }; });
  const dialog = $('dlg-nuevo-archivo') as HTMLDialogElement;
  dialog.setAttribute('aria-label', kind === 'directory' ? 'Nueva carpeta' : board.language === 'micropython' ? 'Nuevo archivo MicroPython' : 'Nuevo archivo');
  inp('nuevo-archivo-nombre').value = '';
  dialog.showModal();
}

async function crearEntrada(name: string, kind: EntryKind): Promise<void> {
  const context = state.creacionEntrada;
  if (!context || context.kind !== kind) throw new Error('No hay una creación pendiente.');
  const path = rutaNuevaEntrada(context.parent, name, kind, context.language);
  if (state.proyecto?.name !== context.project || !placasDelProyecto(state.proyecto).some(board => board.id === context.boardId)) throw new Error('Cambió el proyecto o se quitó la placa. Volvé a abrir el formulario.');
  if (!await guardar(true)) throw new Error('No se pudo guardar el archivo actual.');
  const endpoint = kind === 'directory'
    ? `/api/projects/${encodeURIComponent(context.project)}/directories${queryPlaca(context.boardId)}`
    : urlArchivo(context.project, path, context.boardId);
  await api(endpoint, { method: 'POST', body: JSON.stringify(kind === 'directory' ? { path } : { content: '' }) });
  if (state.proyecto?.name !== context.project) return;
  await cargarExplorador(true);
  if (state.proyecto?.name !== context.project) return;
  if (kind === 'file') {
    await navegarArchivo(path, context.boardId);
    if (state.placaActivaId === context.boardId && state.activo === path) seleccionar(null);
  } else if (state.placaActivaId === context.boardId) {
    const summary = state.exploradorPlacas.find(board => board.id === context.boardId);
    if (summary) { state.archivos = summary.files; state.carpetas = summary.directories; }
  }
}

// --- Dibujo: consultas ------------------------------------------------------

/** GPIO de la placa en una punta "board.GPIO6", o null. */
// --- Placa del proyecto (descriptor del module.json: `board`) -------------------------
// Todo lo específico de la placa sale de acá: los nombres de sus pines (GPIO6 en un ESP32,
// D13 en un Uno), qué GPIO es cada uno, cuáles están reservados y cuáles conviene evitar.

/** Descriptor `board` de la placa del proyecto abierto, o null. */
const descriptorPlaca = (id = state.placaActivaId) => {
  const board = placasDelProyecto(state.proyecto).find(b => b.id === id);
  return state.catalogo.get(board?.board ?? '')?.board ?? (id === state.placaActivaId ? state.placa?.board : null) ?? null;
};

/** Nombre corto para textos: "Arduino Uno R3", "ESP32-S3 DevKitC-1"… */
const depuracionPlacaDisponible = () => Boolean(state.placaActivaId);
const placaActiva = () => placasDelProyecto(state.proyecto).find(b => b.id === state.placaActivaId);
const nombrePlaca = () => state.placa?.nombre ?? state.catalogo.get(placaActiva()?.board ?? state.proyecto?.board ?? '')?.name ?? 'la placa';

/** @param {Record<string, string> | undefined} obj claves = número de GPIO */
const mapaDePines = (obj) => new Map(Object.entries(obj ?? {}).map(([k, v]) => [Number(k), v]));

/** GPIO → motivo por el que no se puede usar (lo usa la simulación, la consola…). */
function pinesBloqueados(id = state.placaActivaId) {
  const d = descriptorPlaca(id);
  return d ? mapaDePines(d.reservedPins) : PINES_BLOQUEADOS_S3;
}

/** GPIO → motivo por el que conviene no usarlo (arranque, USB, LED de la placa…). */
function pinesAdvertencia(id = state.placaActivaId) {
  const d = descriptorPlaca(id);
  return d ? mapaDePines(d.warningPins) : PINES_ADVERTENCIA_S3;
}

/** GPIO de una punta en la placa ("board.GPIO6" → 6, "board.D13" → 13), o null si no es un GPIO. */
function gpioDeRef(ref) {
  return gpioEnPlaca(ref, placasDelProyecto(state.proyecto), state.catalogo)?.gpio ?? null;
}
const destinoGpioDe = (id: string, pin: string) => destinoGpio(`${id}.${pin}`, state.diagrama.modules, state.diagrama.wires, placasDelProyecto(state.proyecto), state.catalogo);
const nivelGpio = (boardId: string, gpio: number) => state.sim.nivelesPorPlaca.get(boardId)?.get(gpio);

/** Nombre del pin de la placa para un GPIO ("D13" en un Uno, "GPIO13" en un ESP32). */
const nombrePinGpio = (g: number) => nombrePinGpioPuro(g, descriptorPlaca());

/** Cables que tocan un pin "id.PIN". */
/** Los cables que llegan a una punta. El cálculo está en consultas.ts (puro y probado). */
const cablesDe = (ref) => cablesDePuro(ref, state.diagrama.wires);

/**
 * GPIO del ESP32 al que está cableado un pin de un módulo, o null.
 * Atraviesa componentes "de paso" (p. ej. una resistencia en serie con un LED):
 * para la lógica digital es como si el cable siguiera derecho (eléctricamente
 * sí cuenta su resistencia — eso lo maneja el chequeo de Ley de Ohm aparte).
 */
function gpioDe(id, pin) {
  return destinoGpioDe(id, pin)?.gpio ?? null;
}

/** Nombre legible de una punta de cable: "ESP32 · GPIO6" / "Pulsador btn1 · OUT". */
const nombreRef = (ref) =>
  nombreRefPuro(ref, state.diagrama.modules, (t) => state.catalogo.get(t), nombrePlaca());

/**
 * Pines de alimentación (GND/VCC) de un módulo que no están cableados a nada.
 * Como en la vida real: sin tierra (y sin VCC si lo necesita) el módulo no funciona,
 * aunque su pin de señal sí esté conectado.
 */
const pinesSinAlimentar = (inst, def) => pinesSinAlimentarPuro(inst, def, state.diagrama.wires);

/** Módulos de un rol, cableados a un GPIO y alimentados (p. ej. el receptor RF listo para recibir). */
function cableadosConRol(rol) {
  return state.diagrama.modules.filter((inst) => {
    const def = state.catalogo.get(inst.type);
    if (def?.bridge?.role !== rol) return false;
    if (gpioDe(inst.id, def.bridge.pin) === null) return false;
    return pinesSinAlimentar(inst, def).length === 0;
  });
}

// --- Dibujo: cambios --------------------------------------------------------

let revisionDiagrama = 0;
let guardadoDiagrama: Promise<unknown> = Promise.resolve();

/** Serializa guardados para que la cámara no abra una instancia aún sin persistir. */
function enviarDiagrama(proyecto: string, contenido: string) {
  guardadoDiagrama = guardadoDiagrama.catch(() => {}).then(() => api(`/api/projects/${encodeURIComponent(proyecto)}/diagram`, { method: 'PUT', body: contenido }));
  return guardadoDiagrama;
}

async function esperarDiagramaCamara(proyecto: string) {
  while (true) {
    if (state.proyecto?.name !== proyecto) throw new Error('El proyecto cambió.');
    const revision = revisionDiagrama;
    if (state.timerDiagrama) {
      clearTimeout(state.timerDiagrama);
      state.timerDiagrama = null;
      void enviarDiagrama(proyecto, JSON.stringify(state.diagrama));
    }
    await guardadoDiagrama;
    if (state.proyecto?.name !== proyecto) throw new Error('El proyecto cambió.');
    if (revisionDiagrama === revision && !state.timerDiagrama) return;
  }
}
function guardarDiagrama() {
  revisionDiagrama++;
  // Todos los cambios del dibujo pasan por acá: es el lugar para avisarle a React, que no ve
  // las mutaciones de adentro de `wires`/`modules` (ver react/estado.ts).
  notificar();
  clearTimeout(state.timerDiagrama);
  const proyecto = state.proyecto?.name;
  if (!proyecto) return;
  // La tarea pendiente pertenece a esta versión, aunque se cambie de proyecto antes de ejecutarla.
  const contenido = JSON.stringify(state.diagrama);
  state.timerDiagrama = setTimeout(async () => {
    state.timerDiagrama = null;
    try {
      await enviarDiagrama(proyecto, contenido);
      if (state.proyecto?.name === proyecto) await refrescarAvisos();
    } catch (e: any) {
      nota(`No se pudo guardar el circuito: ${String(((e as Error))?.message ?? e)}`);
    }
  }, 300);
}

/** Manda ya el guardado pendiente (al recargar/cerrar la pestaña o cambiar de proyecto). */
function guardarDiagramaYa() {
  if (!state.timerDiagrama || !state.proyecto) return;
  clearTimeout(state.timerDiagrama);
  state.timerDiagrama = null;
  // keepalive: el pedido sale aunque la página se esté cerrando.
  void fetch(`/api/projects/${state.proyecto.name}/diagram`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-cliente': CLIENTE },
    body: JSON.stringify(state.diagrama),
    keepalive: true,
  }).catch(() => {});
}
window.addEventListener('pagehide', guardarDiagramaYa);

function nuevoId(type) {
  const PREFIJOS = {
    button: 'btn', switch: 'sw', led: 'led', relay: 'rele', resistor: 'r', rxb6: 'rx', stx882: 'tx',
    'remote-433': 'control', 'door-sensor-433': 'puerta', 'siren-433': 'sirena',
  };
  const base = PREFIJOS[type] ?? (type.replace(/[^a-z0-9]/g, '').slice(0, 10) || 'mod');
  const usados = new Set(state.diagrama.modules.map((m) => m.id));
  let n = 1;
  while (usados.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** Posiciones candidatas alrededor de (0,0), de la más cercana a la más lejana (en pasos de 30). */
const CANDIDATOS = (() => {
  const lista = [];
  for (let i = -30; i <= 30; i++) for (let j = -30; j <= 30; j++) lista.push([i * 30, j * 30]);
  return lista.sort((a, b) => Math.hypot(a[0], a[1] * 1.3) - Math.hypot(b[0], b[1] * 1.3));
})();

/** Primer lugar cerca de `centro` donde un módulo de w×h no pisa a otro (ni su etiqueta de arriba). */
function lugarLibre(w, h, centro) {
  const M = 24;
  const cajas = state.diagrama.modules.map((m) => {
    const d = state.catalogo.get(m.type) ?? { width: 110, height: 50 };
    return { x0: m.x - M, y0: m.y - 30 - M, x1: m.x + d.width + M, y1: m.y + d.height + M };
  });
  const x0 = centro.x - w / 2;
  const y0 = centro.y - h / 2;
  for (const [dx, dy] of CANDIDATOS) {
    const x = x0 + dx;
    const y = y0 + dy;
    if (cajas.every((c) => x + w < c.x0 || x > c.x1 || y + h < c.y0 - 0 || y - 30 > c.y1)) return { x, y };
  }
  return { x: x0, y: y0 };
}

function agregarModulo(type, x?: number, y?: number) {
  const def = state.catalogo.get(type);
  if (!def || !state.proyecto) return;
  if (def.programmable) {
    return abrirAgregarPlaca(type, x, y);
  }
  const props = {};
  for (const [k, p] of Object.entries(def.props ?? {})) {
    if ((p as any).default !== undefined) props[k] = (p as any).default;
  }
  // Click en el catálogo: el lugar libre más cercano al centro de lo visible.
  // Soltado con el mouse: donde se soltó.
  const pos = x === undefined
    ? lugarLibre(def.width, def.height, lienzo.centroVisible())
    : { x: x - def.width / 2, y: y - def.height / 2 };
  const inst = {
    id: nuevoId(type), type,
    x: Math.round(pos.x), y: Math.round(pos.y), props,
  };
  state.diagrama.modules.push(inst);
  guardarDiagrama();
  seleccionar({ tipo: 'modulo', id: inst.id });
  nota(def.pins.length
    ? `${def.name} agregado: conectá sus pines ${state.proyecto.board ? `a la ${nombrePlaca()}` : 'al circuito'} (click en un pin y después en otro).`
    : def.camera ? `${def.name} agregada: seleccioná Activar para usar la webcam.` : `${def.name} agregado: es inalámbrico, no lleva cables.`);
}

// --- Agregar y quitar la placa ---------------------------------------------------------
// La placa es un módulo que se agrega (eligiendo en qué se programa) y se quita. Sin placa,
// el proyecto es solo un circuito: ▶ lo energiza. Quitarla no borra su código (queda en disco).

const dlgPlaca = () => document.getElementById('dlg-placa') as HTMLDialogElement;
let posPlacaNueva: { x?: number; y?: number } = {};

function abrirAgregarPlaca(tipo: string, x?: number, y?: number) {
  // Las placas las rinde <OpcionesPlacas> y los lenguajes <OpcionesLenguajePlaca> (#9), que
  // dependen de cuál está elegida: `ahora` para que estén listos antes de abrir el diálogo.
  sel('placa-nueva').value = tipo;
  ahora(() => { state.placaNuevaId = tipo; });
  const def = state.catalogo.get(tipo);
  posPlacaNueva = x === undefined || !def ? {} : { x: Math.round(x - def.width / 2), y: Math.round(y - def.height / 2) };
  dlgPlaca().showModal();
}

sel('placa-nueva').addEventListener('change', () => { state.placaNuevaId = sel('placa-nueva').value; });

dlgPlaca().addEventListener('close', async () => {
  if (dlgPlaca().returnValue !== 'agregar' || !state.proyecto) return;
  const nombre = state.proyecto.name;
  const board = sel('placa-nueva').value;
  const language = sel('placa-lenguaje').value;
  try {
    if (!await guardar(true)) return;
    await api(`/api/projects/${nombre}/board`, { method: 'POST', body: JSON.stringify({ board, language, ...posPlacaNueva }) });
    await recargarProyecto(nombre);
    nota(`${nombrePlaca()} agregada (${NOMBRE_LENGUAJE_PROYECTO[language] ?? language}): ya podés programarla. ▶ ahora compila y ejecuta.`);
  } catch (e: any) {
    nota(String((e as Error)?.message ?? e));
  }
});

async function quitarPlaca(boardId = state.placaActivaId) {
  if (!state.proyecto || !boardId) return;
  const nombre = state.proyecto.name;
  const elegida = placasDelProyecto(state.proyecto).find(b => b.id === boardId);
  const placa = state.catalogo.get(elegida?.board ?? '')?.name ?? boardId;
  if (!confirm(`¿Quitar ${placa} (${boardId}) del proyecto?\nSe borran sus cables. Las otras placas y sus archivos se conservan.`)) return;
  try {
    if (!await guardar(true)) return;
    await api(`/api/projects/${nombre}/board${queryPlaca(boardId)}`, { method: 'DELETE' });
    await recargarProyecto(nombre);
    nota(`${placa} quitada: ${sinPlaca() ? 'el proyecto queda como circuito sin placa' : 'las demás placas siguen en el circuito'}.`);
  } catch (e: any) {
    nota(String((e as Error)?.message ?? e));
  }
}

function eliminarModulo(id) {
  if (placasDelProyecto(state.proyecto).some(b => b.id === id)) {
    void quitarPlaca(id);
    return;
  }
  const prefijo = `${id}.`;
  state.diagrama.modules = state.diagrama.modules.filter((m) => m.id !== id);
  state.diagrama.wires = state.diagrama.wires.filter((w) => !w.from.startsWith(prefijo) && !w.to.startsWith(prefijo));
  guardarDiagrama();
  seleccionar(null);
}

function eliminarCable(indice) {
  state.diagrama.wires.splice(indice, 1);
  guardarDiagrama();
  seleccionar(null);
}

/** Motivo por el que no se puede cablear a este pin, o null si se puede. */
function motivoBloqueo(ref) {
  const g = gpioDeRef(ref);
  const bloqueados = pinesBloqueados();
  if (g !== null && bloqueados.has(g)) return `${nombrePinGpio(g)} no se puede usar: ${bloqueados.get(g)}.`;
  return null;
}

function conectar(a, b) {
  const idA = a.slice(0, a.indexOf('.'));
  const idB = b.slice(0, b.indexOf('.'));
  if (idA === idB) {
    nota('Conectá el pin con un pin de otro módulo.');
    return;
  }
  const bloqueo = motivoBloqueo(a) ?? motivoBloqueo(b);
  if (bloqueo) {
    nota(bloqueo);
    return;
  }
  if (state.diagrama.wires.some((w) => (w.from === a && w.to === b) || (w.from === b && w.to === a))) {
    nota('Esos dos pines ya están conectados.');
    return;
  }
  // Convención de la guía (6.1): el módulo en `from`, la placa en `to`.
  const wire = idA === BOARD_ID ? { from: b, to: a } : { from: a, to: b };
  state.diagrama.wires.push(wire);
  guardarDiagrama();
  nota(`Conectado: ${nombreRef(wire.from)} → ${nombreRef(wire.to)}`);
  // Si el módulo está seleccionado, el panel muestra la conexión nueva.
  pintarPanelDerecho();
  lienzo.render();
}

// --- Simulación sobre el canvas ----------------------------------------------

/** El mensaje correcto según si hay que arrancar la simulación o ya está arrancando (no confundir las dos cosas). */
function textoEsperaSimulacion() {
  const s = $('estado').dataset.s;
  if (s === 'starting' || s === 'booted' || s === 'wifi') return 'Esperando a que la simulación termine de arrancar…';
  return sinPlaca() ? 'Apretá ▶ para energizar el circuito y poder usarlo.' : 'Apretá ▶ Ejecutar para poder usarlo.';
}

/**
 * Lo que consume cada fuente depende de los pines que maneja el código (un LED en un GPIO).
 * Cuando el firmware cambia un pin se recalcula, agrupado (un LED que parpadea rápido manda
 * muchos cambios) y solo si hay fuentes regulables que mostrar.
 */
let timerConsumo = 0;
function recalcularConsumo() {
  if (!state.fuentes.length || timerConsumo) return;
  timerConsumo = window.setTimeout(() => {
    timerConsumo = 0;
    void refrescarAvisos();
  }, 300);
}

/** Pedidos de interruptores en fila: apretar y soltar rápido no puede llegar al revés. */
let colaInterruptores: Promise<unknown> = Promise.resolve();

/** Le dice al server que el interruptor se cerró/abrió (para el motor eléctrico) y trae el resultado. */
function avisarInterruptor(id: string, cerrado: boolean) {
  const proyecto = state.proyecto?.name;
  if (!proyecto) return;
  colaInterruptores = colaInterruptores
    .then(() => api(`/api/projects/${proyecto}/controls`, { method: 'POST', body: JSON.stringify({ id, cerrado }) }))
    .then(() => refrescarAvisos())
    .catch((e) => nota(String((e as Error)?.message ?? e)));
}

function controlModulo(inst, control, indice, evento) {
  const def = state.catalogo.get(inst.type);
  if (!def) return;
  if (!state.sim.listo) {
    if (evento === 'down') {
      seleccionar({ tipo: 'modulo', id: inst.id });
      nota(`Los controles funcionan con la simulación corriendo. ${textoEsperaSimulacion()}`);
    }
    return;
  }
  const rol = def.bridge?.role;
  if (rol === 'input') {
    const gpio = gpioDe(inst.id, def.bridge.pin);
    // Un interruptor (pulsador, llave) también sirve sin GPIO: cierra un circuito sin código.
    const esInterruptor = Boolean(def.switch);
    if (gpio === null && !esInterruptor) {
      if (evento === 'down') nota(`Conectá el pin ${def.bridge.pin} del ${def.name} a un pin de la ${nombrePlaca()}.`);
      return;
    }
    // Un interruptor no se "alimenta": sus dos patas son terminales del circuito. El pin que
    // el fabricante llama GND puede ir a una resistencia (pulsador en serie con la carga) sin
    // que eso sea un error; exigirle tierra es tratar la etiqueta como si fuera electricidad.
    const faltan = gpio === null || esInterruptor ? [] : pinesSinAlimentar(inst, def);
    if (faltan.length > 0) {
      if (evento === 'down') nota(`${def.name} sin alimentación: conectá también ${faltan.join(' y ')}, como en la vida real.`);
      return;
    }
    const activo = def.bridge.activeLevel ?? 1;
    let presionado;
    if (control === 'momentary') {
      presionado = evento === 'down';
    } else {
      if (evento !== 'down') return;
      presionado = !state.sim.controles.get(inst.id);
    }
    state.sim.controles.set(inst.id, presionado);
    // Un interruptor cambia el circuito, y lo que lee el pin lo calcula el server con el motor
    // eléctrico (pull interno, umbrales del chip): si está mal cableado, el programa no ve nada,
    // como en la placa real. Otro módulo de entrada le dice su nivel directo.
    if (esInterruptor) avisarInterruptor(inst.id, presionado);
    else if (gpio !== null) enviar({ type: 'pin.in', pin: gpio, boardId: destinoGpioDe(inst.id, def.bridge.pin)?.boardId, level: presionado ? activo : 1 - activo });
    lienzo.render();
    return;
  }
  if (rol === 'air' && evento === 'down') {
    let bits = null;
    if (def.type === 'remote-433') {
      const letra = 'ABCD'[indice] ?? 'A';
      bits = inst.props?.[`code${letra}`];
      state.sim.boton.set(inst.id, indice);
      setTimeout(() => {
        state.sim.boton.delete(inst.id);
        lienzo.render();
      }, 250);
    } else if (def.type === 'door-sensor-433') {
      const abierta = !state.sim.controles.get(inst.id);
      state.sim.controles.set(inst.id, abierta);
      bits = abierta ? inst.props?.code : null; // el sensor solo transmite al abrir
    } else {
      nota(`${def.name}: se activa sola cuando la ${nombrePlaca()} transmite su código.`);
      return;
    }
    if (bits) enviarRf(inst, String(bits), Number(inst.props?.protocol ?? 1));
    lienzo.render();
  }
}

/** Control "momentary" apretado desde el panel (no desde el dibujo): para soltarlo aunque el mouse se vaya del botón. */
function soltarPanelPresionado() {
  const inst = state.panelPresionado;
  if (!inst) return;
  controlModulo(inst, 'momentary', 0, 'up');
  state.panelPresionado = null;
}
window.addEventListener('mouseup', soltarPanelPresionado);
window.addEventListener('touchend', soltarPanelPresionado);
window.addEventListener('touchcancel', soltarPanelPresionado);

/** Módulos de un rol con el pin de señal cableado, sin importar si les falta alimentación (para avisos). */
function cableadosSinFiltrarAlimentacion(rol) {
  return state.diagrama.modules.filter((inst) => {
    const def = state.catalogo.get(inst.type);
    return def?.bridge?.role === rol && gpioDe(inst.id, def.bridge.pin) !== null;
  });
}

function enviarRf(inst, bits, protocolo) {
  const receptores = cableadosConRol('rf-rx');
  if (receptores.length === 0) {
    const sinAlimentar = cableadosSinFiltrarAlimentacion('rf-rx')[0];
    if (sinAlimentar) {
      const def = state.catalogo.get(sinAlimentar.type);
      nota(`${def.name} sin alimentación: conectá también ${pinesSinAlimentar(sinAlimentar, def).join(' y ')}, como en la vida real.`);
    } else {
      nota(`Nadie recibe la señal: agregá un Receptor RF RXB6 y conectá su DATA a un pin de la ${nombrePlaca()}.`);
    }
    return;
  }
  if (!/^[01]+$/.test(bits)) {
    nota(`El código "${bits}" no es válido: tiene que ser una secuencia de 0 y 1.`);
    return;
  }
  enviar({ type: 'rf.send', bits, protocol: protocolo });
  log('emu', `[rf] ${inst.id} transmitió ${bits} (protocolo ${protocolo})`);
  destellar([inst.id, ...receptores.map((r) => r.id)]);
}

function recibirRfTx(bits) {
  const transmisores = cableadosConRol('rf-tx').map((m) => m.id);
  destellar(transmisores);
  if (transmisores.length === 0) return;
  for (const inst of state.diagrama.modules) {
    if (inst.type !== 'siren-433') continue;
    const aprendido = String(inst.props?.learnedCode ?? '');
    if (aprendido && aprendido !== bits) continue;
    state.sim.sonando.set(inst.id, Date.now() + 3000);
    setTimeout(() => lienzo.render(), 3050);
  }
  lienzo.render();
}

function destellar(ids) {
  const hasta = Date.now() + 400;
  for (const id of ids) state.sim.flash.set(id, hasta);
  setTimeout(() => lienzo.render(), 450);
  lienzo.render();
}

/** Estado visual en vivo de un módulo durante la simulación. */
function vivoDe(inst) {
  const def = state.catalogo.get(inst.type);
  const ahora = Date.now();
  const vivo = {
    flash: (state.sim.flash.get(inst.id) ?? 0) > ahora,
    sonando: (state.sim.sonando.get(inst.id) ?? 0) > ahora,
    presionado: Boolean(state.sim.controles.get(inst.id)),
    activo: Boolean(state.sim.controles.get(inst.id)),
    boton: state.sim.boton.get(inst.id),
    on: false,
    quemado: false,
    explotando: false,
    /** Lo último que mostró la pantalla del chip del módulo (si tiene una). */
    pantalla: state.sim.listo ? state.salidasChips.get(inst.id) : undefined,
  };
  vivo.on = salidaDesdeFisica({
    valida: state.fisicaValida,
    led: state.electrico.get(inst.id),
    modelo: state.uiModulos.get(inst.id),
  });
  const quemado = state.sim.quemados.get(inst.id);
  // El estado latched del servidor solo representa la política de placas, no LEDs.
  if (quemado && def?.programmable) {
    vivo.on = false;
    vivo.quemado = true;
    vivo.explotando = ahora - quemado.hora < 1400;
  }
  return vivo;
}

// --- Riesgo de sobrecorriente en la instantánea viva ----------------------------
// El límite simplificado informa riesgo: el modelo no calcula daño térmico ni
// cambia la topología del LED. No se apaga ni recuerda una avería ficticia.
function revisarQuemaduras() {
  // Limpia marcas visuales heredadas de LED; la política de placas sigue separada.
  for (const inst of state.diagrama.modules) {
    if (!state.catalogo.get(inst.type)?.programmable) state.sim.quemados.delete(inst.id);
  }
  if (!state.fisicaValida) return;
  const selected = state.seleccion;
  if (selected?.tipo === 'modulo' && riesgoDesdeFisica({ valida: true, led: state.electrico.get(selected.id) })) {
    pintarPanelDerecho();
  }
}

function reemplazarQuemado(id) {
  state.sim.quemados.delete(id);
  nota(`${id} reemplazado por uno nuevo.`);
  lienzo.render();
  pintarPanelDerecho();
}

// --- Alimentación de la placa ---------------------------------------------------------
// El server decide (motor eléctrico) si la placa tiene energía: USB, o una Fuente regulable
// en rango en uno de sus pines de alimentación. Sin eso no arranca; con sobretensión se quema.
// La quemadura la guarda el server; acá se refleja con el mismo efecto que un LED quemado.

function reflejarPlacaQuemada() {
  const quemada = Boolean(state.alimentacion?.quemada);
  if (quemada && !state.sim.quemados.has(state.placaActivaId)) {
    state.sim.quemados.set(state.placaActivaId, { hora: Date.now(), mA: 0 });
    nota(`Se quemó ${nombrePlaca()}: ${state.alimentacion!.mensaje} Queda muerta hasta reemplazarla.`);
    log('emu', `[alimentación] ${state.alimentacion!.mensaje}`);
    setTimeout(() => lienzo.render(), 1450); // termina la explosión, queda el humo
  } else if (!quemada && state.sim.quemados.has(state.placaActivaId)) {
    state.sim.quemados.delete(state.placaActivaId);
  }
}

async function reemplazarPlaca() {
  if (!state.proyecto) return;
  await api(`/api/projects/${state.proyecto.name}/board/replace${queryPlaca()}`, { method: 'POST' });
  state.sim.quemados.delete(state.placaActivaId);
  nota(`${nombrePlaca()} reemplazada por una nueva.`);
  await refrescarAvisos();
}

function instanciaPlaca() {
  return state.diagrama.modules.find((m) => m.id === state.placaActivaId);
}

/** El "USB conectado" de la placa (prop `usb`), o null si la placa no lo tiene (descriptor sin `power`). */
function usbDePlaca(): boolean | null {
  const inst = instanciaPlaca();
  const def = inst && state.catalogo.get(inst.type);
  if (!def?.props?.usb) return null;
  return Boolean(inst.props?.usb ?? def.props.usb.default);
}

function alternarUsb() {
  const inst = instanciaPlaca();
  if (!inst || usbDePlaca() === null) return;
  const on = !usbDePlaca();
  inst.props = { ...inst.props, usb: on };
  nota(on ? `USB conectado: ${nombrePlaca()} alimentada por USB.` : `USB desconectado: ${nombrePlaca()} necesita una Fuente regulable para arrancar.`);
  pintarAlimentacion();
  guardarDiagrama();
}


/** Botón USB de la barra + píldora de alimentación del circuito + columna de la ventana Debug. */
function pintarAlimentacion() {
  const usb = usbDePlaca();
  const boton = $('usb') as HTMLButtonElement;
  boton.hidden = usb === null;
  boton.classList.toggle('activa', Boolean(usb));
  boton.setAttribute('aria-pressed', String(Boolean(usb)));

  const a = state.alimentacion;
  const pildora = $('badge-alimentacion') as HTMLButtonElement;
  pildora.hidden = !a && !sinPlaca();
  if (sinPlaca()) {
    // Sin placa: la píldora muestra si el circuito está energizado y cuánto entregan las fuentes.
    const total = state.fuentes.reduce((s, f) => s + (f.mA ?? 0), 0);
    pildora.className = `badge-alim ${state.energizado ? 'ok' : 'sin'}`;
    pildora.textContent = state.energizado
      ? `⚡ Energizado · ${fmtMa(total)}`
      : `⚡ Apagado${state.fuentes.length ? '' : ' · sin fuentes'}`;
    pildora.title = state.energizado ? 'Las fuentes regulables entregan tensión. ⏹ apaga el circuito.' : '▶ energiza el circuito (prende las fuentes regulables).';
    pildora.disabled = true;
  } else if (a) {
    const f = state.fuentes.find((x) => x.id === a.fuenteId);
    const [clase, texto] = a.quemada
      ? ['quemada', 'Placa quemada · Reemplazar']
      : a.estado === 'ok'
        ? ['ok', a.via === 'usb' ? 'USB' : a.via === 'fuente' && f ? `${a.fuenteId} · ${fmtV(f.vSalida)} · ${fmtMa(f.mA)}` : 'Alimentada']
        : ['sin', a.estado === 'baja' ? 'Tensión insuficiente' : 'Sin alimentación'];
    pildora.className = `badge-alim ${clase}`;
    pildora.textContent = `⚡ ${texto}`;
    pildora.title = a.quemada ? `${a.mensaje}\nClick para reemplazar la placa.` : a.mensaje;
    pildora.disabled = !a.quemada;
  }
}


// --- Cortocircuitos -----------------------------------------------------------------
// El motor eléctrico del server manda, con cada aviso de cortocircuito, las refs "id.PIN"
// involucradas. Mientras el aviso siga llegando el pin/cable queda resaltado; al arreglar
// el cableado el aviso deja de llegar y el efecto se borra solo (no es daño permanente).

/** Clave estable para un cortocircuito, sin importar el orden de sus refs. */
const claveCorto = (refs) => [...refs].sort().join('|');

/** Sincroniza `state.sim.cortos` con los avisos de este refresco: alta al aparecer, baja al arreglarse. */
function actualizarCortos(warnings) {
  const activos = new Set();
  for (const w of warnings) {
    if (w.kind !== 'peligro-electrico' || !w.refs?.length) continue;
    const clave = claveCorto(w.refs);
    activos.add(clave);
    if (!state.sim.cortos.has(clave)) {
      state.sim.cortos.set(clave, { hora: Date.now(), refs: w.refs });
      setTimeout(() => lienzo.render(), 1450); // termina la explosión, queda el resaltado
    }
  }
  for (const clave of state.sim.cortos.keys()) if (!activos.has(clave)) state.sim.cortos.delete(clave);
}

/** Todas las refs "id.PIN" que están en corto ahora mismo. */
function refsEnCorto() {
  const refs = new Set();
  for (const c of state.sim.cortos.values()) for (const r of c.refs) refs.add(r);
  return refs;
}

/** ¿Esta ref "id.PIN" es parte de un cortocircuito activo? */
const estaEnCorto = (ref) => refsEnCorto().has(ref);

/** ¿El corto que involucra esta ref se detectó hace menos de 1.4s (recién "explotó")? */
function cortoExplotando(ref) {
  const ahora = Date.now();
  for (const c of state.sim.cortos.values()) if (c.refs.includes(ref) && ahora - c.hora < 1400) return true;
  return false;
}

/** ¿Este pin de un módulo (no de la placa) es de alimentación y le falta cablear? */
const esPinSinAlimentar = (ref) =>
  esPinSinAlimentarPuro(ref, state.diagrama.modules, (t) => state.catalogo.get(t), state.diagrama.wires);

/** Texto extra del tooltip de un pin (por qué está reservado, conviene evitarlo, o hace falta cablearlo). */
function descripcionPin(ref) {
  if (estaEnCorto(ref)) return 'en cortocircuito: desconectalo o agregá algo que limite la corriente';
  const g = gpioDeRef(ref);
  if (g === null) {
    return esPinSinAlimentar(ref) ? 'sin esto el módulo no funciona, como en la vida real' : '';
  }
  if (pinesBloqueados(ref.split('.')[0]).has(g)) return `reservado: ${pinesBloqueados(ref.split('.')[0]).get(g)}`;
  if (pinesAdvertencia(ref.split('.')[0]).has(g)) return `ojo: ${pinesAdvertencia(ref.split('.')[0]).get(g)}`;
  if (ref.split('.')[0] === state.placaActivaId && state.codePins.has(g) && cablesDe(ref).length === 0) return 'el código lo usa pero no tiene nada conectado';
  return '';
}

/** Clases de un pin según su estado: bloqueado, conectado, lo usa el código sin cable... */
function clasePin(ref) {
  const clases = [];
  if (cablesDe(ref).length > 0) clases.push('conectado');
  const g = gpioDeRef(ref);
  if (g !== null) {
    if (pinesBloqueados(ref.split('.')[0]).has(g)) clases.push('bloqueado');
    else if (pinesAdvertencia(ref.split('.')[0]).has(g)) clases.push('advertencia');
    if (ref.split('.')[0] === state.placaActivaId && state.codePins.has(g)) clases.push(cablesDe(ref).length > 0 ? 'en-codigo' : 'falta-modulo');
    const destino = gpioEnPlaca(ref, placasDelProyecto(state.proyecto), state.catalogo);
    if (destino && nivelGpio(destino.boardId, g) === 1) clases.push('alto');
  } else if (esPinSinAlimentar(ref)) {
    clases.push('sin-alimentar');
  }
  if (estaEnCorto(ref)) clases.push('en-corto');
  return clases.join(' ');
}

// --- Canvas -----------------------------------------------------------------

/**
 * El lienzo lo crea el componente `<Lienzo>` de React contra su propio `<svg>` (#9): acá se deja
 * el contexto que necesita y se recibe la instancia cuando monta. Lo que sigue usando `lienzo`
 * en este archivo no cambió — corre después del montaje, que pasa al arrancar `main()`.
 */
let lienzo;
alLienzoListo((l) => { lienzo = l; });
registrarCtx({
  diagrama: () => state.diagrama,
  def: (type) => state.catalogo.get(type),
  seleccion: () => state.seleccion,
  vivo: vivoDe,
  clasePin,
  descripcionPin,
  enCorto: estaEnCorto,
  cortoExplotando,
  seleccionar,
  moverModulo(id, x, y, fin) {
    const inst = state.diagrama.modules.find((m) => m.id === id);
    if (!inst) return;
    inst.x = x;
    inst.y = y;
    if (fin) {
      guardarDiagrama();
      lienzo.render();
    } else {
      // Mientras se arrastra: solo se mueve ese módulo y sus cables, sin rearmar todo el dibujo.
      lienzo.moverVisual(id);
    }
  },
  rotarModulo(id, grados, fin) {
    const inst = state.diagrama.modules.find((m) => m.id === id);
    if (!inst) return;
    fijarRotacion(inst, grados, fin);
  },
  conectar,
  puedeEmpezarCable(ref) {
    if (state.modoMover) return false;
    const bloqueo = motivoBloqueo(ref);
    if (bloqueo) nota(bloqueo);
    return !bloqueo;
  },
  control: controlModulo,
  soltarModulo: (type, x, y) => agregarModulo(type, x, y),
});

// --- Rotación -------------------------------------------------------------------

/** Guarda el ángulo (0–359) de un módulo; `fin` = soltó el mouse o fue un paso de teclado. */
function fijarRotacion(inst, grados, fin) {
  const r = ((Math.round(grados) % 360) + 360) % 360;
  if (r === 0) delete inst.rotation;
  else inst.rotation = r;
  if (!fin) {
    lienzo.moverVisual(inst.id); // mientras se arrastra el asa: solo ese módulo y sus cables
    return;
  }
  guardarDiagrama();
  lienzo.render();
  const campo = (document.querySelector<HTMLElement>('#panel-modulo [data-rotacion]') as HTMLInputElement | null);
  if (campo) campo.value = String(r);
}

/** Gira el módulo seleccionado (R: +90°, Shift+R: −90°). */
function girarSeleccion(delta) {
  const s = state.seleccion;
  if (s?.tipo !== 'modulo') return;
  const inst = state.diagrama.modules.find((m) => m.id === s.id);
  if (inst) fijarRotacion(inst, (inst.rotation ?? 0) + delta, true);
}

// --- Selección y panel derecho ------------------------------------------------

function seleccionar(s) {
  if (s?.tipo === 'modulo' && placasDelProyecto(state.proyecto).some(b => b.id === s.id) && s.id !== state.placaActivaId) void navegarPlaca(s.id);
  state.seleccion = s;
  pintarPanelDerecho();
  lienzo.render();
}

/** El panel derecho muestra el código si se eligió el ESP32 (o nada); si no, el módulo o el cable. */
/**
 * Qué se ve a la derecha: el editor de código o el panel del módulo. El contenido del panel lo
 * rinde <PanelDerecho> (#9); acá solo queda decidir cuál de los dos se muestra, porque es `app.ts`
 * el que sabe del editor.
 */
function pintarPanelDerecho() {
  const s = state.seleccion;
  const inst = s?.tipo === 'modulo' ? state.diagrama.modules.find((m) => m.id === s.id) : null;
  const def = inst ? state.catalogo.get(inst.type) : null;
  const muestraCodigo = !s || (s.tipo === 'modulo' && (!inst || def?.programmable));
  // Sin placa no hay código: en su lugar, el panel cuenta qué es un proyecto sin placa.
  const codigo = muestraCodigo && Boolean(state.placaActivaId);
  $('panel-codigo').hidden = !codigo;
  $('panel-modulo').hidden = codigo;
}

// --- Catálogo -----------------------------------------------------------------
// El catálogo lo rinde <Catalogo> (#9): acá solo queda traerlo del server. Antes había además un
// cache de tarjetas por tipo, porque armar cada miniatura SVG es lo caro y el buscador repintaba
// la lista entera en cada tecla; ahora eso lo resuelve el diffing de React.

// --- Chips (sensores con lógica) ----------------------------------------------------

async function cargarChips() {
  const { chips } = await api('/api/chips').catch(() => ({ chips: [] }));
  state.chips = new Map(chips.map((c) => [c.id, c]));
}

/** Los chips de un módulo del catálogo (una placa puede traer varios en el mismo bus). */
const chipsDe = (def): any[] => (def?.chips ?? []).map((u) => state.chips.get(u.id)).filter(Boolean);

async function recargarCatalogo() {
  const { modules } = await api('/api/modules').catch(() => ({ modules: [] }));
  state.catalogo = new Map(modules.map((m) => [m.type, m]));
  await cargarChips();
  pintarPanelDerecho();
  lienzo.render();
}

async function aplicarCambioExterno(msg) {
  const nombre = state.proyecto?.name;
  if (!nombre) return;
  // Solo cambió la física (un pulsador apretado desde el MCP u otra pestaña): se recalcula, nada más.
  if (msg.what === 'electrico') {
    await refrescarAvisos();
    lienzo.render();
    return;
  }
  const resumen = await api(`/api/projects/${nombre}`);
  const project = resumen.project;
  let files = resumen.files;
  let directories = resumen.directories ?? [];
  if (state.proyecto?.name !== nombre) return;
  // Se agregó o se quitó la placa (otra pestaña, el MCP): cambian el código, la barra y el modo de ▶.
  if (JSON.stringify(placasDelProyecto(project)) !== JSON.stringify(placasDelProyecto(state.proyecto))) {
    await recargarProyecto(nombre);
    return;
  }
  if (msg.what !== 'diagram' && state.placaActivaId && state.placaActivaId !== placasDelProyecto(project)[0]?.id) {
    const contexto = await api(`/api/projects/${nombre}${queryPlaca()}`);
    if (state.proyecto?.name !== nombre) return;
    files = contexto.files;
    directories = contexto.directories ?? [];
  }
  if (msg.what === 'diagram') {
    // El cambio de afuera gana: lo pendiente de esta pestaña se descarta.
    clearTimeout(state.timerDiagrama);
    state.timerDiagrama = null;
    state.diagrama = { modules: [...project.modules], wires: [...project.wires] };
    for (const board of placasDelProyecto(project)) {
      if (!state.diagrama.modules.some(m => m.id === board.id)) state.diagrama.modules.unshift({ id: board.id, type: board.board, x: 0, y: 0, props: {} });
    }
    const s = state.seleccion;
    if (s?.tipo === 'cable' || (s?.tipo === 'modulo' && !state.diagrama.modules.some((m) => m.id === s.id))) {
      state.seleccion = null;
    }
    pintarPanelDerecho();
    lienzo.render();
    nota(msg.origin === 'mcp' ? 'Circuito actualizado por MCP.' : 'Circuito actualizado desde otra pestaña.');
  } else {
    state.carpetas = directories ?? [];
    state.archivos = files.filter((f) => !/(^|\/)(secrets\.yaml|project\.json)$/.test(f.path));
    if (msg.file === state.activo) {
      if (state.editorSucio) {
        nota(`${msg.file} cambió afuera, pero tenés cambios sin guardar: se mantienen los tuyos.`);
      } else {
        const { content } = await api(urlArchivo(nombre, msg.file));
        const scroll = scrollEditor();
        editarContenido(content);
        ponerScrollEditor(scroll);
        nota(`${msg.file} actualizado ${msg.origin === 'mcp' ? 'por MCP' : 'desde otra pestaña'}.`);
      }
    }
  }
  await refrescarAvisos();
}

// --- Importador de módulos ---------------------------------------------------------

let fuenteImportacion = 'carpeta';

const bytesABase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Lo que se va a mandar al server según la fuente elegida. */
async function solicitudImportacion() {
  switch (fuenteImportacion) {
    case 'carpeta': {
      const archivos = {};
      const lista = [...(inp('imp-carpeta').files ?? [])].filter((f) => /\.(json|svg|js)$/i.test(f.name));
      if (lista.length === 0) throw new Error('Elegí una carpeta que tenga module.json (o .chip.json).');
      if (lista.length > 1000) throw new Error('La carpeta tiene demasiados archivos .json/.svg.');
      for (const f of lista) {
        if (f.size > 512 * 1024) continue;
        archivos[f.webkitRelativePath || f.name] = await f.text();
      }
      return { fuente: 'archivos', archivos };
    }
    case 'zip': {
      const f = inp('imp-zip').files?.[0];
      if (!f) throw new Error('Elegí un archivo .zip.');
      return { fuente: 'zip', base64: bytesABase64(new Uint8Array(await f.arrayBuffer())) };
    }
    case 'wokwi': {
      const f = inp('imp-chip').files?.[0];
      if (!f) throw new Error('Elegí el .chip.json del chip de Wokwi.');
      return { fuente: 'wokwi', chipJson: await f.text() };
    }
    default: {
      const url = inp('imp-url').value.trim();
      if (!url) throw new Error('Pegá una URL https://');
      return { fuente: 'url', url };
    }
  }
}


async function ejecutarImportacion(soloValidar) {
  const botones = [btn('imp-importar'), btn('imp-validar')];
  try {
    const solicitud = await solicitudImportacion();
    const rol = sel('imp-rol').value;
    const categoria = inp('imp-categoria').value.trim();
    botones.forEach((b) => (b.disabled = true));
    state.importacion = { tipo: 'cargando', soloValidar };
    const res = await fetch('/api/modules/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cliente': CLIENTE },
      body: JSON.stringify({
        ...solicitud,
        sobrescribir: ($('imp-reemplazar') as HTMLInputElement).checked,
        soloValidar,
        wokwi: { ...(rol ? { role: rol } : {}), ...(categoria ? { category: categoria } : {}) },
      }),
    });
    const datos = await res.json();
    if (datos.error) throw new Error(datos.error);
    state.importacion = { tipo: 'resultado', datos };
    if (datos.importados.length && !soloValidar) {
      await recargarCatalogo();
      nota(`Importado(s): ${datos.importados.map((m) => m.name).join(', ')}`);
    }
  } catch (e: any) {
    state.importacion = { tipo: 'error', mensaje: String((e as Error)?.message ?? e) };
  } finally {
    botones.forEach((b) => (b.disabled = false));
  }
}

function elegirFuente(fuente) {
  fuenteImportacion = fuente;
  for (const b of document.querySelectorAll('.imp-fuentes [data-fuente]')) {
    b.classList.toggle('activa', (b as HTMLElement).dataset.fuente === fuente);
  }
  for (const p of document.querySelectorAll('#dlg-importar [data-panel]')) {
    (p as HTMLElement).hidden = (p as HTMLElement).dataset.panel !== fuente;
  }
  state.importacion = null;
}

async function quitarDelCatalogo(m) {
  if (!confirm(`¿Quitar "${m.name}" del catálogo?\nLos circuitos que lo usan lo van a mostrar como desconocido.`)) return;
  try {
    await api(`/api/modules/${m.type}`, { method: 'DELETE' });
    await recargarCatalogo();
    nota(`"${m.name}" quitado del catálogo.`);
  } catch (e: any) {
    nota(String((e as Error)?.message ?? e));
  }
}

// --- Avisos dibujo ↔ código -----------------------------------------------------

let revisionObservacionFisica = 0;
/** Suelta medidas anteriores e invalida respuestas pendientes de otro contexto. */
function invalidarObservacionFisica(avisos: typeof state.avisosDibujo = []): void {
  revisionObservacionFisica++;
  state.fisicaValida = false;
  state.electrico = new Map();
  state.uiModulos = new Map();
  state.fuentes = [];
  state.mediciones = [];
  state.tensiones = {};
  state.alimentacion = null;
  state.energizado = false;
  state.codePins = new Set();
  state.avisosDibujo = avisos;
  state.sim.quemados.clear();
  actualizarCortos([]);
  actualizarCuentaProblemas();
}

async function refrescarAvisos() {
  if (!state.proyecto) return;
  const revision = ++revisionObservacionFisica;
  const proyecto = state.proyecto.name;
  let avisosFallidos: typeof state.avisosDibujo | null = null;
  try {
    const respuesta = await api(`/api/projects/${proyecto}/pins`);
    if (revision !== revisionObservacionFisica || state.proyecto?.name !== proyecto) return;
    if (respuesta.electrico?.resuelto !== true || !Array.isArray(respuesta.electrico.leds)) {
      avisosFallidos = Array.isArray(respuesta.warnings) ? respuesta.warnings : null;
      throw new Error('El servidor no entregó una instantánea eléctrica resuelta.');
    }
    const { pins, warnings } = respuesta;
    state.fisicaValida = respuesta.electrico.resuelto === true;
    state.codePins = new Set(pins);
    state.avisosDibujo = warnings;
    state.electrico = new Map((respuesta.electrico?.leds ?? []).map((l) => [l.id, l]));
    state.fuentes = respuesta.electrico?.fuentes ?? [];
    state.mediciones = respuesta.electrico?.mediciones ?? [];
    state.tensiones = respuesta.electrico?.tensiones ?? {};
    state.uiModulos = new Map(Object.entries(respuesta.electrico?.modulos ?? {}));
    state.alimentacion = respuesta.electrico?.placas?.[state.placaActivaId] ?? respuesta.electrico?.placa ?? null;
    const energizado = Boolean(respuesta.electrico?.energizado);
    if (energizado !== state.energizado) {
      state.energizado = energizado;
      if (sinPlaca()) aplicarEnergia();
    }
    reflejarPlacaQuemada();
    pintarAlimentacion();

    actualizarCortos(warnings);
    actualizarCuentaProblemas();
    revisarQuemaduras();
    // Los avisos los rinde <Avisos> (#9): alcanza con haber asignado `state.avisosDibujo`.
    lienzo.render();
  } catch (error) {
    if (revision !== revisionObservacionFisica || state.proyecto?.name !== proyecto) return;
    invalidarObservacionFisica(avisosFallidos?.length ? avisosFallidos : [{ message: `Análisis eléctrico no válido: ${String((error as Error)?.message ?? error)}` }]);
    lienzo.render();
    pintarPanelDerecho();
  }
}

// --- Proyectos --------------------------------------------------------------

async function cargarProyectos(seleccionarNombre?: string) {
  const { projects } = await api('/api/projects');
  ahora(() => { state.proyectos = projects; });
  sel('proyecto').value = state.proyecto?.name ?? '';
  if (seleccionarNombre) await navegacion.navigate({ project: seleccionarNombre });
}

// --- Pantalla de inicio: lista de proyectos ----------------------------------

function mostrarInicio() {
  detenerCamarasDeOtrosProyectos(null);
  document.body.classList.add('inicio');
  invalidarObservacionFisica();
  document.body.classList.remove('aprender');
  $('bienvenida-proyectos').classList.add('activa');
  $('bienvenida-acerca').classList.remove('activa');
  state.aprendizajeRuta = null;
  state.leccionPracticaId = null;
  state.proyecto = null;
  state.placaActivaId = null;
  state.activo = null;
  sel('proyecto').value = '';
  pintarWidgetsProyecto();
  cerrarMenus();
}

/** Color estable por nombre de proyecto (la insignia y el tinte de la barra, como en Android Studio). */
function colorProyecto(nombre) {
  let h = 0;
  for (const c of nombre) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 42% 46%)`;
}

/** Iniciales para la insignia: "demo-boton-led" → "DB". */
function iniciales(nombre) {
  const partes = nombre.split(/[-_\s]+/).filter(Boolean);
  return ((partes[0]?.[0] ?? '') + (partes[1]?.[0] ?? partes[0]?.[1] ?? '')).toUpperCase() || '?';
}


/** Barra de título y de estado según el proyecto abierto (o ninguno). */
function pintarWidgetsProyecto() {
  const p = state.proyecto;
  const raiz = document.body.style;
  btn('volver-aprendizaje').hidden = !p || !state.leccionPracticaId;
  if (p) {
    raiz.setProperty('--color-proyecto', colorProyecto(p.name));
    raiz.setProperty('--tinte', colorProyecto(p.name).replace(')', ' / .22)'));
    $('insignia-proyecto').textContent = iniciales(p.name);
    const contextoPlaca = placaActiva();
    const placa = contextoPlaca ? state.catalogo.get(contextoPlaca.board) : null;
    $('dispositivo-texto').textContent = contextoPlaca ? `${placa?.name ?? contextoPlaca.board} · ${contextoPlaca.id}` : 'Sin placa';
    $('dispositivo').title = p.board ? 'Placa que se emula' : 'Proyecto sin placa: solo circuito. Agregá una placa desde el catálogo para programarla.';
    // Sin placa no hay lenguaje, ni reset, ni web del dispositivo: ▶ solo energiza el circuito.
    $('config-run').hidden = !p.board;
    $('quitar-placa').hidden = !p.board;
    $('reset').hidden = !p.board;
    $('recargar').hidden = !p.board;
    $('abrir-web').hidden = !p.board;
    $('config-run-texto').textContent = contextoPlaca?.language ? (NOMBRE_LENGUAJE_PROYECTO[contextoPlaca.language] ?? contextoPlaca.language) : '';
    btn('ejecutar').title = p.board ? 'Compilar y ejecutar placas (Shift+F10 · Ctrl+Enter)' : 'Energizar el circuito: prende las fuentes regulables (Shift+F10 · Ctrl+Enter)';
    btn('parar').title = p.board ? 'Parar (Ctrl+F2)' : 'Apagar el circuito (Ctrl+F2)';
    document.title = `${p.name} – Emulador de electrónica`;
  } else {
    raiz.removeProperty('--color-proyecto');
    raiz.removeProperty('--tinte');
    $('insignia-proyecto').textContent = '–';
    $('pos-cursor').textContent = '';
    $('lenguaje-status').textContent = '';
    document.title = 'Emulador de electrónica';
  }
}

/** Migas de pan de la barra de estado: proyecto › archivo. */

// La lista de proyectos la rinde <Proyectos> (#9): alcanza con mantener `state.proyectos`.

async function eliminarProyecto(nombre) {
  if (!confirm(`¿Eliminar el proyecto "${nombre}"? No se puede deshacer.`)) return;
  try {
    await api(`/api/projects/${nombre}`, { method: 'DELETE' });
    clearProjectDockLayout(nombre);
    // Si era el proyecto abierto (p.ej. desde la barra de iconos), hay que soltarlo antes de
    // recargar la lista: si no, cargarProyectos() intenta reabrir un proyecto que ya no existe.
    if (state.proyecto?.name === nombre) {
      mostrarInicio();
      navegacion.replace({ project: null });
    }
    await cargarProyectos();
  } catch (e: any) {
    nota(String((e as Error)?.message ?? e));
  }
}

async function irAInicio() {
  await navegacion.navigate({ project: null });
}

/** Cuenta las aperturas: si se pide otro proyecto mientras uno carga, la carga vieja se descarta. */
let aperturas = 0;

let cargasExplorador = 0;
/** Carga metadatos de todas las placas sin cambiar el contexto del editor. */
async function cargarExplorador(sincronizarActivo = false): Promise<void> {
  const project = state.proyecto?.name;
  if (!project) return;
  const version = ++cargasExplorador;
  const result = await api(`/api/projects/${encodeURIComponent(project)}/explorer`);
  if (version !== cargasExplorador || state.proyecto?.name !== project) return;
  const boards: BoardFileTree[] = result.boards.map((board: BoardFileTree) => ({
    ...board, files: board.files.filter(file => !/(^|\/)(secrets\.yaml|project\.json)$/.test(file.path)),
  }));
  ahora(() => {
    state.exploradorPlacas = boards;
    if (sincronizarActivo) {
      const active = boards.find(board => board.id === state.placaActivaId);
      if (active) { state.archivos = active.files; state.carpetas = active.directories; }
    }
  });
}

async function actualizarExplorador(): Promise<void> {
  if (!await guardar(true)) throw new Error('No se pudo guardar el archivo actual.');
  await cargarExplorador(true);
}

async function abrirProyecto(nombre) {
  const mia = ++aperturas;
  const { project, files, directories, placa } = await api(`/api/projects/${encodeURIComponent(nombre)}`);
  const visibles = files.filter((f) => !/(^|\/)(secrets\.yaml|project\.json)$/.test(f.path));
  const board = placasDelProyecto(project)[0];
  const main = visibles.find(f => /^(main\.(yaml|c|cpp|py)|sketch\.cpp)$/.test(f.path)) ?? visibles[0];
  const loaded = board && main ? await api(urlArchivo(nombre, main.path, board.id)) : null;
  if (mia !== aperturas) return;
  // Se puede seguir escribiendo mientras llega el proyecto: guardar también esa versión.
  if (state.editorSucio && (!await guardar(true) || state.editorSucio)) return;
  if (mia !== aperturas) return;
  document.body.classList.remove('inicio');
  const cambioProyecto = state.proyecto?.name !== nombre;
  if (cambioProyecto) detenerCamarasDeOtrosProyectos(nombre);
  if (cambioProyecto) state.exploradorPlacas = [];
  invalidarObservacionFisica();
  state.proyecto = project;
  if (cambioProyecto) {
    state.filtroModulos = projectDockFilter(nombre);
    actualizarDistribucion(projectDockLayout(nombre));
  }
  state.placaActivaId = placasDelProyecto(project)[0]?.id ?? null;
  depuracion?.alCambiarContexto();
  state.placa = placa ?? null;
  // project.json lo edita el canvas; secrets.yaml no se muestra.
  state.carpetas = directories ?? [];
  state.archivos = visibles;
  sel('proyecto').value = nombre;
  state.diagrama = { modules: [...project.modules], wires: [...project.wires] };
  for (const board of placasDelProyecto(project)) {
    // Proyectos anteriores al canvas: completar sólo las instancias reales del proyecto.
    if (!state.diagrama.modules.some(m => m.id === board.id)) state.diagrama.modules.unshift({ id: board.id, type: board.board, x: 0, y: 0, props: {} });
  }
  state.energizado = false; // lo confirma refrescarAvisos (GET /pins)
  state.seleccion = null;
  state.activo = null;
  editarContenido('');
  if (main && loaded) mostrarContenidoArchivo(main.path, loaded.content);
  if (mia !== aperturas) return;
  pintarPanelDerecho();
  pintarWidgetsProyecto();
  lienzo.render();
  lienzo.ajustar();
  log('build', `── proyecto ${nombre} (${project.board ? project.language : 'sin placa: solo circuito'}) ──`);
  void depuracion?.alAbrirProyecto();
  await refrescarAvisos();
  // Con placa, el estado de ▶/⏹ lo manda el emulador; sin placa, si el circuito está energizado.
  if (project.board) void api('/api/emulator').then((r) => aplicarEstadoEmulador(r.status)).catch(() => {});
  else aplicarEnergia();
}

// --- Eventos ----------------------------------------------------------------

ta('editor').addEventListener('input', () => {
  state.editorSucio = true;
  pedirEditor();
  guardarAuto();
});
ta('editor').addEventListener('scroll', sincronizarScroll, { passive: true });
for (const ev of ['keyup', 'mouseup', 'focus', 'blur']) ta('editor').addEventListener(ev, pintarCursor);
ta('editor').addEventListener('keydown', (e) => {
  const t = (e.target as HTMLTextAreaElement);
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    // insertText (y no tocar .value): conserva Ctrl+Z y dispara "input" como una tecla normal.
    document.execCommand('insertText', false, editor.lenguaje === 'python' ? '    ' : '  ');
    return;
  }
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    // Sangría automática, como en el IDE: mantiene la de la línea y suma un nivel tras ":" o "{".
    const inicio = t.value.lastIndexOf('\n', t.selectionStart - 1) + 1;
    const linea = t.value.slice(inicio, t.selectionStart);
    let sangria = /^[ \t]*/.exec(linea)?.[0] ?? '';
    if (/[:{(\[]\s*$/.test(linea)) sangria += editor.lenguaje === 'python' ? '    ' : '  ';
    e.preventDefault();
    document.execCommand('insertText', false, '\n' + sangria);
  }
});

for (const b of document.querySelectorAll('.imp-fuentes [data-fuente]')) {
  (b as HTMLElement).onclick = () => elegirFuente((b as HTMLElement).dataset.fuente);
}
$('imp-importar').onclick = () => void ejecutarImportacion(false);
$('imp-validar').onclick = () => void ejecutarImportacion(true);

$('zoom-mas').onclick = () => lienzo.zoom(1.2);
$('zoom-menos').onclick = () => lienzo.zoom(1 / 1.2);
$('zoom-ajustar').onclick = () => lienzo.ajustar();

async function cambiarDeProyecto(nombre: string) {
  if (nombre) await navegacion.navigate({ project: nombre });
}

sel('proyecto').addEventListener('change', () => void cambiarDeProyecto(sel('proyecto').value));

$('ir-inicio').onclick = () => void irAInicio();
$('volver-aprendizaje').onclick = () => void volverALeccionAprendizaje();
$('act-proyectos').onclick = () => void irAInicio();

// --- Nuevo proyecto: placa y lenguaje ----------------------------------------------

/** Placas: las del server (GET /api/boards) o, si no existe, las programables del catálogo. */
async function cargarPlacas() {
  const r = await api('/api/boards').catch(() => null);
  state.placas = r?.boards?.length
    ? r.boards
    : [...state.catalogo.values()].filter((m) => m.programmable).map((m) => ({ id: m.type, name: m.name }));
  state.placaPorDefecto = r?.porDefecto ?? state.placas[0]?.id ?? '';
}

function abrirNuevoProyecto() {
  cerrarMenus();
  // Las opciones (las placas y "sin placa") las rinde <OpcionesPlacaNueva> (#9) desde que llegan
  // las placas, así que ya están: solo queda elegir.
  const s = sel('nuevo-placa');
  // La última que eligió el usuario, no `s.value`: con las opciones ya puestas, el navegador
  // selecciona una por su cuenta (la que hubiera cuando el <select> tenía una sola opción) y no
  // hay forma de distinguirla de una elección real.
  const antes = placaNuevaRecordada;
  // La última elegida en esta sesión; si no, la que el server marca por defecto (no la primera
  // de la lista: está en orden alfabético y sería el Arduino Uno).
  s.value = antes && (antes === SIN_PLACA || state.placas.some((b) => b.id === antes)) ? antes : state.placaPorDefecto;
  filtrarLenguajesNuevo();
  elegirPlantillaNuevo();
  void cargarPlantillasNuevo();
  dlg().showModal();
}

/** Plantillas de projects/_template/ (GET /api/templates) para el diálogo de nuevo proyecto. */

async function cargarPlantillasNuevo() {
  const plantillas = await api('/api/templates').catch(() => []);
  const s = sel('nuevo-plantilla');
  const antes = s.value;
  // Las opciones las rinde <OpcionesPlantillas> (#9); `ahora` porque abajo se fija el value.
  ahora(() => { state.plantillas = plantillas; });
  s.value = plantillas.some((t) => t.id === antes) ? antes : '';
  $('nuevo-plantilla-label').hidden = plantillas.length === 0;
  elegirPlantillaNuevo();
}

/** Con plantilla, placa y lenguaje los define ella: se ocultan y se muestra su descripción. */
function elegirPlantillaNuevo() {
  const t = state.plantillas.find((x) => x.id === sel('nuevo-plantilla').value);
  actualizarDialogoNuevo();
  const desc = $('nuevo-plantilla-desc');
  desc.hidden = !t;
  desc.textContent = t ? `${t.descripcion} (${t.board ? `${t.board}, ${t.language}` : 'sin placa'})` : '';
}

/** Con plantilla, placa y lenguaje los define ella; sin placa, no hay lenguaje que elegir. */
function actualizarDialogoNuevo() {
  const conPlantilla = Boolean(sel('nuevo-plantilla').value);
  const sinPlacaElegido = sel('nuevo-placa').value === SIN_PLACA;
  (sel('nuevo-placa').closest('label') as HTMLElement).hidden = conPlantilla;
  (dlg().querySelector<HTMLElement>('select[name="language"]')!.closest('label') as HTMLElement).hidden = conPlantilla || sinPlacaElegido;
}
sel('nuevo-plantilla').addEventListener('change', elegirPlantillaNuevo);

/** Deshabilita los lenguajes que la placa elegida no soporta (si el server lo informa). */
/** Valor del selector de placa de "Nuevo proyecto" para un proyecto sin placa. */

function filtrarLenguajesNuevo() {
  actualizarDialogoNuevo();
  const placa = state.placas.find((b) => b.id === sel('nuevo-placa').value);
  const soportados = placa?.languages ?? placa?.lenguajes ?? null;
  const lenguaje = (dlg().querySelector<HTMLElement>('select[name="language"]') as HTMLSelectElement);
  for (const o of lenguaje.options) o.disabled = Array.isArray(soportados) && !soportados.includes(o.value);
  if (lenguaje.selectedOptions[0]?.disabled) lenguaje.value = [...lenguaje.options].find((o) => !o.disabled)?.value ?? '';
}
/** La placa que eligió el usuario en "Nuevo proyecto" en esta sesión (vacía: la de por defecto). */
let placaNuevaRecordada = '';
sel('nuevo-placa').addEventListener('change', () => {
  placaNuevaRecordada = sel('nuevo-placa').value;
  filtrarLenguajesNuevo();
});
$('nuevo').onclick = abrirNuevoProyecto;
$('nuevo-inicio').onclick = abrirNuevoProyecto;

$('dlg-nuevo').addEventListener('close', async () => {
  const d = dlg();
  if (d.returnValue !== 'crear') return;
  const form = (d.querySelector<HTMLElement>('form') as HTMLFormElement);
  const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
  const language = (form.elements.namedItem('language') as HTMLSelectElement).value;
  const board = sel('nuevo-placa').value || undefined;
  const template = sel('nuevo-plantilla').value || undefined;
  try {
    const cuerpo = template ? { name, template } : board === SIN_PLACA ? { name, board: null } : { name, language, board };
    await api('/api/projects', { method: 'POST', body: JSON.stringify(cuerpo) });
    await cargarProyectos(name);
  } catch (e: any) {
    log('build', `[error] ${String(((e as Error))?.message ?? e)}`);
    nota(String(((e as Error))?.message ?? e));
  }
});

// --- Simulación ----------------------------------------------------------------------

$('ejecutar').onclick = async () => {
  if (!state.proyecto) return;
  // Como "Run" en el IDE: se abre la consola de compilación si estaba oculta.
  if (!ventanaVisible('consola')) {
    mostrarVentana('abajo', true);
    elegirTabConsola('build');
  }
  await guardar(true);
  await refrescarAvisos();
  // Como en la vida real: sin la energía adecuada la placa no arranca (el server también lo controla).
  const a = state.alimentacion;
  if (a && (a.quemada || a.estado !== 'ok')) {
    const motivo = a.quemada ? `La placa está quemada: reemplazala (click en "⚡ Placa quemada").` : a.mensaje;
    log('build', `[error] ${motivo}`);
    nota(motivo);
    return;
  }
  const avisos = state.avisosDibujo.length;
  if (avisos > 0) log('build', `Chequeo ${sinPlaca() ? 'del circuito' : 'circuito ↔ código'}: ${avisos} aviso(s) (no bloquea)`);
  await api(`/api/projects/${state.proyecto.name}/run`, { method: 'POST', body: JSON.stringify({}) }).catch((e) =>
    nota(String((e as Error)?.message ?? e)),
  );
  // Sin placa no hay emulador que avise: ▶ energizó el circuito, se trae el estado ya.
  if (sinPlaca()) await refrescarAvisos();
};

$('parar').onclick = async () => {
  await api('/api/emulator/stop', { method: 'POST' });
  if (sinPlaca()) await refrescarAvisos();
};
$('usb').onclick = alternarUsb;
$('quitar-placa').onclick = () => void quitarPlaca();
$('badge-alimentacion').onclick = () => {
  if (state.alimentacion?.quemada) void reemplazarPlaca();
};
/**
 * Lleva al chip el código guardado sin reiniciar el emulador. En MicroPython es un
 * soft reboot (instantáneo); en los lenguajes que compilan, el server compila y relanza.
 */
async function recargarCodigo() {
  if (!state.proyecto) return;
  const b = btn('recargar');
  b.disabled = true;
  try {
    const r = await api(`/api/projects/${state.proyecto.name}/reload`, { method: 'POST' });
    if (!r.ok) log('emu', `[recarga] no se recargó: ${r.motivo ?? 'sin detalle'}`);
    else log('emu', r.modo === 'relanzado' ? '[recarga] firmware nuevo: corrida relanzada' : '[recarga] código recargado en el chip');
  } catch (e: any) {
    log('emu', `[recarga] ${String((e as Error)?.message ?? e)}`);
  } finally {
    // No se adivina si quedó corriendo (un relanzado puede haber fallado): se relee el estado,
    // que es el que decide si el botón vuelve a quedar habilitado.
    await api('/api/emulator').then((r) => aplicarEstadoEmulador(r.status)).catch(() => {
      b.disabled = false;
    });
  }
}
$('recargar').onclick = () => void recargarCodigo();

/** Activa/desactiva `sim.autoReload`: recargar el chip solo, cada vez que se guarda. */
async function alternarAutoReload() {
  const p = state.proyecto;
  if (!p) return;
  const sim = { ...p.sim, autoReload: !p.sim?.autoReload };
  try {
    const r = await api(`/api/projects/${p.name}`, { method: 'PUT', body: JSON.stringify({ sim }) });
    state.proyecto = r.project;
    log('build', `[recarga] recargar al guardar: ${r.project.sim.autoReload ? 'activado' : 'desactivado'}`);
  } catch (e: any) {
    log('build', `[recarga] ${String((e as Error)?.message ?? e)}`);
  }
}

$('reset').onclick = async () => {
  try {
    const r = await api('/api/emulator/reset', { method: 'POST' });
    log('emu', `[control] ${r.output}`);
  } catch (e: any) {
    log('emu', `[control] ${String(((e as Error))?.message ?? e)}`);
  }
};
$('abrir-web').onclick = () => {
  const url = btn('abrir-web').dataset.url;
  if (url) window.open(url, '_blank');
};

// --- Ventanas de herramientas (se muestran/ocultan como en Android Studio y VS Code) ---

const VENTANAS = { izq: 'sin-izq', der: 'sin-der', abajo: 'sin-abajo' };
const VISTA_VENTANA = { izq: 'componentes', der: 'codigo', abajo: 'consola' } as const;

function grupoDeVentana(id: WindowId, node: DockNode = state.distribucion.root) {
  if (node.kind === 'group') return node.views.includes(id) ? node : null;
  for (const child of node.children) {
    const group = grupoDeVentana(id, child);
    if (group) return group;
  }
  return null;
}

function ventanaVisible(id: WindowId) {
  const group = grupoDeVentana(id);
  const active = group && (state.distribucion.open[group.active] ? group.active : group.views.find(view => state.distribucion.open[view]));
  return state.distribucion.open[id] && active === id;
}

function actualizarDistribucion(layout: DockLayout) {
  ahora(() => { state.distribucion = layout; });
  if (state.proyecto) saveProjectDockLayout(state.proyecto.name, layout);
  sincronizarFranjas();
}

function abrirVentana(id: WindowId, visible?: boolean) {
  actualizarDistribucion(setDockWindowOpen(state.distribucion, id, visible ?? !ventanaVisible(id)));
}

/** @param {'izq' | 'der' | 'abajo'} cual @param {boolean} [visible] sin valor: alterna */
function mostrarVentana(cual, visible?: boolean) {
  abrirVentana(VISTA_VENTANA[cual], visible);
  if (state.distribucion.open.consola && cual === 'abajo') pintarConsola();
}

function sincronizarFranjas() {
  for (const [id, button] of [['componentes', 'tw-catalogo'], ['explorador', 'tw-explorador']] as const) {
    const visible = state.distribucion.open[id];
    $(button).classList.toggle('activa', visible);
    $(button).setAttribute('aria-expanded', String(visible));
  }
  $('act-codigo').classList.toggle('activa', state.distribucion.open.codigo);
  $('act-codigo').setAttribute('aria-expanded', String(state.distribucion.open.codigo));
  $('tw-circuito').classList.toggle('activa', state.distribucion.open.circuito);
  $('tw-circuito').setAttribute('aria-expanded', String(state.distribucion.open.circuito));
  const abajo = state.distribucion.open.consola;
  for (const id of ['tw-build', 'tw-emu', 'tw-debug', 'tw-problemas']) {
    $(id).classList.toggle('activa', abajo && $(id).dataset.twTab === state.tab);
  }
}

const tabsConsola = ([...document.querySelectorAll('.consola-tabs [data-tab]')] as HTMLElement[]);

function elegirTabConsola(tab) {
  state.tab = tab;
  for (const o of tabsConsola) o.classList.toggle('activa', o.dataset.tab === tab);
  sincronizarFranjas();
  pintarConsola();
}

/** Click en la franja: abre la consola en esa pestaña; si ya estaba ahí, la oculta. */
function alternarConsola(tab) {
  const visible = ventanaVisible('consola');
  if (visible && state.tab === tab) return mostrarVentana('abajo', false);
  mostrarVentana('abajo', true);
  elegirTabConsola(tab);
}

for (const b of tabsConsola) b.onclick = () => elegirTabConsola(b.dataset.tab);
for (const b of document.querySelectorAll('[data-tw-tab]')) {
  (b as HTMLElement).onclick = () => alternarConsola((b as HTMLElement).dataset.twTab);
}
for (const b of document.querySelectorAll('[data-ocultar]')) {
  (b as HTMLElement).onclick = () => mostrarVentana(((b as HTMLElement).dataset.ocultar as any), false);
}
for (const b of document.querySelectorAll('[data-close-window]')) {
  (b as HTMLElement).onclick = () => abrirVentana((b as HTMLElement).dataset.closeWindow as WindowId, false);
}
$('tw-catalogo').onclick = () => mostrarHerramienta('componentes');
$('tw-explorador').onclick = () => mostrarHerramienta('explorador');
$('tw-circuito').onclick = () => abrirVentana('circuito');
$('act-codigo').onclick = () => {
  // Oculto: se abre. Abierto con un módulo elegido: vuelve al código. Abierto con el código: se oculta.
  if (!ventanaVisible('codigo')) mostrarVentana('der', true);
  else if (state.seleccion) seleccionar(null);
  else mostrarVentana('der', false);
};

function alternarModoMover() {
  state.modoMover = !state.modoMover;
  btn('act-mover').classList.toggle('activa', state.modoMover);
  document.body.classList.toggle('modo-mover', state.modoMover);
  nota(state.modoMover ? 'Modo mover: los pines no arrancan cables (M para volver).' : '');
}
$('act-mover').onclick = alternarModoMover;

function restaurarVentanas() {
  document.body.classList.remove(...Object.values(VENTANAS));
  sincronizarFranjas();
}

function mostrarHerramienta(id: 'explorador' | 'componentes', visible?: boolean) {
  abrirVentana(id, visible);
}


inp('filtro').addEventListener('input', () => {
  state.filtro = inp('filtro').value;
  pintarConsola();
});
$('limpiar').onclick = () => {
  state.lineas.build = [];
  state.lineas.emu = [];
  consola.recortes.build++;
  consola.recortes.emu++;
  pintarConsola();
};
inp('entrada-console').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const data = inp('entrada-console').value;
  inp('entrada-console').value = '';
  log('emu', `> ${data}`);
  enviar({ type: 'console.input', data: data + '\n', ...(state.placaActivaId ? { boardId: state.placaActivaId } : {}) });
});
inp('buscar-proyectos').addEventListener('input', () => {
  // <Proyectos> se entera por el estado observable.
  state.filtroProyectos = inp('buscar-proyectos').value;
});

// --- Notificaciones -------------------------------------------------------------------

$('globo-cerrar').onclick = () => nota('');
$('tw-notificaciones').onclick = () => {
  const c = $('lista-notificaciones');
  c.hidden = !c.hidden;
  $('tw-notificaciones').classList.toggle('activa', !c.hidden);
  if (!c.hidden) $('punto-notificaciones').hidden = true;
};

// --- Acciones: una sola lista para el menú, la paleta de comandos y los atajos ---------

const hayProyecto = () => Boolean(state.proyecto);

function abrirImportador() {
  cerrarMenus();
  state.importacion = null;
  ($('dlg-importar') as HTMLDialogElement).showModal();
}

function borrarSeleccion() {
  const s = state.seleccion;
  if (s?.tipo === 'modulo') eliminarModulo(s.id);
  else if (s?.tipo === 'cable') eliminarCable(s.indice);
}

function buscarModulo() {
  mostrarHerramienta('componentes', true);
  inp('buscar-modulos').focus();
  inp('buscar-modulos').select();
}

/**
 * @typedef {{ id: string, titulo: string, menu: string, atajo?: string, teclas?: string[],
 *   hacer: () => void, habilitada?: () => boolean }} Accion
 * `atajo` es lo que se muestra; `teclas`, las combinaciones que la disparan (si no, la del atajo).
 */
/** @type {Accion[]} */
const ACCIONES = [
  { id: 'nuevo', titulo: 'Nuevo proyecto…', menu: 'Archivo', hacer: abrirNuevoProyecto },
  { id: 'abrir', titulo: 'Abrir otro proyecto…', menu: 'Archivo', hacer: () => void irAInicio(), habilitada: hayProyecto },
  { id: 'guardar', titulo: 'Guardar', menu: 'Archivo', atajo: 'Ctrl+S', hacer: () => void guardar(false), habilitada: hayProyecto },
  { id: 'formatear-micropython', titulo: 'Formatear MicroPython', menu: 'Editar', atajo: 'Ctrl+Shift+I', hacer: () => void formatearMicroPython(), habilitada: () => microPythonActivo && !formateandoMicroPython },
  { id: 'ajustes-editor', titulo: 'Ajustes del editor…', menu: 'Editar', hacer: () => ($('dlg-editor-preferences') as HTMLDialogElement).showModal() },
  { id: 'importar', titulo: 'Importar módulos…', menu: 'Archivo', hacer: abrirImportador },
  {
    id: 'eliminar-proyecto', titulo: 'Eliminar este proyecto…', menu: 'Archivo',
    hacer: () => state.proyecto && void eliminarProyecto(state.proyecto.name), habilitada: hayProyecto,
  },
  {
    id: 'borrar', titulo: 'Borrar lo seleccionado', menu: 'Editar', atajo: 'Supr', teclas: ['Delete', 'Backspace'],
    hacer: borrarSeleccion, habilitada: () => Boolean(state.seleccion),
  },
  {
    id: 'deseleccionar', titulo: 'Deseleccionar / cancelar el cable', menu: 'Editar', atajo: 'Esc', teclas: ['Escape'],
    hacer: () => {
      if (!lienzo.cancelarCable()) seleccionar(null);
    },
    habilitada: hayProyecto,
  },
  {
    id: 'girar', titulo: 'Girar 90° a la derecha', menu: 'Editar', atajo: 'R', hacer: () => girarSeleccion(90),
    habilitada: () => state.seleccion?.tipo === 'modulo',
  },
  {
    id: 'girar-izq', titulo: 'Girar 90° a la izquierda', menu: 'Editar', atajo: 'Shift+R', hacer: () => girarSeleccion(-90),
    habilitada: () => state.seleccion?.tipo === 'modulo',
  },
  { id: 'buscar-modulo', titulo: 'Buscar un módulo en el catálogo', menu: 'Editar', hacer: buscarModulo, habilitada: hayProyecto },
  { id: 'ver-catalogo', titulo: 'Componentes', menu: 'Ver', atajo: 'Alt+1', teclas: ['Alt+1', 'Ctrl+B'], hacer: () => mostrarHerramienta('componentes') },
  { id: 'ver-explorador', titulo: 'Explorador de archivos', menu: 'Ver', atajo: 'Ctrl+Shift+E', hacer: () => mostrarHerramienta('explorador', true) },
  { id: 'ver-codigo', titulo: 'Código / propiedades', menu: 'Ver', atajo: 'Alt+2', hacer: () => mostrarVentana('der') },
  { id: 'ver-circuito', titulo: 'Circuito', menu: 'Ver', hacer: () => abrirVentana('circuito') },
  { id: 'ver-consola', titulo: 'Consola', menu: 'Ver', atajo: 'Ctrl+J', teclas: ['Ctrl+J', 'Ctrl+`'], hacer: () => mostrarVentana('abajo') },
  { id: 'ver-build', titulo: 'Compilación', menu: 'Ver', atajo: 'Alt+0', hacer: () => alternarConsola('build') },
  { id: 'ver-emu', titulo: 'Emulador (consola serie)', menu: 'Ver', atajo: 'Alt+F12', hacer: () => alternarConsola('emu') },
  { id: 'ver-problemas', titulo: 'Problemas', menu: 'Ver', atajo: 'Alt+6', hacer: () => alternarConsola('problemas') },
  { id: 'ocultar-consola', titulo: 'Ocultar la consola', menu: 'Ver', atajo: 'Shift+Esc', teclas: ['Shift+Escape'], hacer: () => mostrarVentana('abajo', false) },
  { id: 'modo-mover', titulo: 'Modo mover (sin cablear)', menu: 'Ver', atajo: 'M', hacer: alternarModoMover, habilitada: hayProyecto },
  { id: 'zoom-ajustar', titulo: 'Encuadrar el circuito', menu: 'Ver', atajo: 'Ctrl+0', hacer: () => lienzo.ajustar(), habilitada: hayProyecto },
  { id: 'zoom-mas', titulo: 'Acercar', menu: 'Ver', atajo: 'Ctrl+=', teclas: ['Ctrl+=', 'Ctrl++', 'Ctrl+Shift++'], hacer: () => lienzo.zoom(1.2), habilitada: hayProyecto },
  { id: 'zoom-menos', titulo: 'Alejar', menu: 'Ver', atajo: 'Ctrl+−', teclas: ['Ctrl+-'], hacer: () => lienzo.zoom(1 / 1.2), habilitada: hayProyecto },
  {
    id: 'ejecutar', titulo: 'Ejecutar', menu: 'Simulación', atajo: 'Shift+F10', teclas: ['Shift+F10', 'Ctrl+Enter', 'F5'],
    hacer: () => btn('ejecutar').click(), habilitada: () => hayProyecto() && !btn('ejecutar').disabled,
  },
  {
    id: 'parar', titulo: 'Parar', menu: 'Simulación', atajo: 'Ctrl+F2', teclas: ['Ctrl+F2', 'Shift+F5'],
    hacer: () => btn('parar').click(), habilitada: () => !btn('parar').disabled,
  },
  { id: 'reset', titulo: 'Reset', menu: 'Simulación', hacer: () => btn('reset').click(), habilitada: hayProyecto },
  {
    id: 'recargar', titulo: 'Recargar el código en el chip', menu: 'Simulación', atajo: 'Ctrl+Shift+F5',
    hacer: () => btn('recargar').click(), habilitada: () => !btn('recargar').disabled,
  },
  {
    id: 'auto-recarga', titulo: 'Recargar al guardar (activar / desactivar)', menu: 'Simulación',
    hacer: () => void alternarAutoReload(), habilitada: () => Boolean(state.proyecto?.board),
  },
  { id: 'abrir-web', titulo: 'Abrir la web del dispositivo', menu: 'Simulación', hacer: () => btn('abrir-web').click(), habilitada: () => !btn('abrir-web').disabled },
  { id: 'ver-debug', titulo: 'Ventana Debug', menu: 'Depurar', atajo: 'Alt+5', hacer: () => alternarConsola('debug') },
  {
    id: 'dbg-continuar', titulo: 'Continuar', menu: 'Depurar', atajo: 'F9', hacer: () => void depuracion.control('continue'),
    habilitada: () => depuracion.estaParado(),
  },
  { id: 'dbg-pausa', titulo: 'Pausar', menu: 'Depurar', hacer: () => void depuracion.control('pause'), habilitada: () => !btn('parar').disabled },
  { id: 'dbg-sobre', titulo: 'Paso por encima', menu: 'Depurar', atajo: 'F8', hacer: () => void depuracion.control('next'), habilitada: () => depuracion.estaParado() },
  { id: 'dbg-adentro', titulo: 'Paso adentro', menu: 'Depurar', atajo: 'F7', hacer: () => void depuracion.control('stepIn'), habilitada: () => depuracion.estaParado() },
  { id: 'dbg-afuera', titulo: 'Salir de la función', menu: 'Depurar', atajo: 'Shift+F8', hacer: () => void depuracion.control('stepOut'), habilitada: () => depuracion.estaParado() },
  {
    id: 'dbg-breakpoint', titulo: 'Poner / sacar breakpoint en esta línea', menu: 'Depurar', atajo: 'Ctrl+F8',
    hacer: () => {
      const t = ta('editor');
      depuracion.alternarBreakpointEnCursor(microPythonActivo ? microPython.line() : t.value.slice(0, t.selectionStart).split('\n').length);
    },
    habilitada: () => Boolean(state.activo) && depuracionPlacaDisponible(),
  },
  { id: 'buscar-todo', titulo: 'Buscar en todo…', menu: 'Ayuda', atajo: 'Ctrl+Shift+P', teclas: ['Ctrl+Shift+P', 'Ctrl+K', 'Ctrl+Shift+A'], hacer: () => abrirPaleta() },
  { id: 'acerca', titulo: 'Atajos y acerca de', menu: 'Ayuda', hacer: () => ($('dlg-acerca') as HTMLDialogElement).showModal() },
];
const MENUS = ['Archivo', 'Editar', 'Ver', 'Simulación', 'Depurar', 'Ayuda'];
registrarMenu({ grupos: MENUS, acciones: ACCIONES, cerrar: () => cerrarMenus() });

/** Combinación de teclas normalizada: "Ctrl+Shift+P", "Alt+1", "Delete". */
function combo(e) {
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return '';
  // Alt+número: en algunos teclados e.key trae otro símbolo; e.code no depende de la distribución.
  if (e.altKey && /^Digit\d$/.test(e.code)) k = e.code.slice(5);
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', k].filter(Boolean).join('+');
}

const ATAJOS = new Map();
for (const a of ACCIONES) for (const t of a.teclas ?? (a.atajo ? [a.atajo] : [])) ATAJOS.set(t, a);

/** Shift doble abre "Buscar en todo", como en Android Studio. */
let ultimoShift = 0;

document.addEventListener('keydown', (e) => {
  const t = (e.target as HTMLElement);
  if (e.key === 'Shift' && !e.repeat) {
    const ahora = performance.now();
    if (ahora - ultimoShift < 350 && !document.querySelector<HTMLElement>('dialog[open]')) {
      ultimoShift = 0;
      abrirPaleta();
    } else {
      ultimoShift = ahora;
    }
    return;
  }
  ultimoShift = 0;
  if (e.key === 'Escape' && (!$('menu').hidden || !$('lista-notificaciones').hidden)) {
    cerrarMenus();
    return;
  }
  if (t.closest?.('dialog')) return; // cada diálogo maneja sus teclas
  const accion = ATAJOS.get(combo(e));
  if (!accion) return;
  // Las teclas sueltas (M, Supr, Esc) no cuentan mientras se escribe en un campo.
  const suelta = !e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key) && !(e.shiftKey && e.key === 'Escape');
  if (suelta && t.closest?.('input, textarea, select, [contenteditable]')) return;
  if (accion.habilitada && !accion.habilitada()) return;
  e.preventDefault();
  accion.hacer();
});

// --- Menú principal (hamburguesa) ---------------------------------------------------------

// El menú lo rinde <Menu> (#9) a partir de `ACCIONES`: acá solo se abre y se cierra.


function cerrarMenus() {
  $('menu').hidden = true;
  state.menuAbierto = false;
  $('menu-principal').setAttribute('aria-expanded', 'false');
  $('lista-notificaciones').hidden = true;
  $('tw-notificaciones').classList.remove('activa');
}

$('menu-principal').onclick = () => {
  if (!$('menu').hidden) return cerrarMenus();
  // <Menu> se entera y reevalúa qué acciones están disponibles ahora.
  state.menuAbierto = true;
  $('menu').hidden = false;
  $('menu-principal').setAttribute('aria-expanded', 'true');
  ($('menu').querySelector<HTMLElement>('.menu-item') as HTMLElement | null)?.focus();
};
document.addEventListener('mousedown', (e) => {
  const t = (e.target as HTMLElement);
  if (!$('menu').hidden && !t.closest('#menu, #menu-principal')) cerrarMenus();
  if (!$('lista-notificaciones').hidden && !t.closest('#lista-notificaciones, #tw-notificaciones')) cerrarMenus();
});

// --- Buscar en todo (paleta de comandos) -------------------------------------------------

// La lista, la búsqueda y el teclado los maneja <Paleta> (#9), y el puntaje y el resaltado son
// puros (paleta.ts). Acá queda abrirla y decidir qué se puede buscar, que es lo que sabe app.ts.

function abrirPaleta() {
  cerrarMenus();
  const d = ($('dlg-buscar') as HTMLDialogElement);
  if (d.open) return;
  state.paletaVez++;
  d.showModal();
}

function candidatosPaleta() {
  const out = [];
  for (const a of ACCIONES) {
    if (!a.habilitada || a.habilitada()) out.push({ tipo: 'Acción', titulo: a.titulo, atajo: a.atajo, hacer: a.hacer });
  }
  for (const p of state.proyectos) {
    if (p.name !== state.proyecto?.name) out.push({ tipo: 'Proyecto', titulo: `Abrir ${p.name}`, hacer: () => void cambiarDeProyecto(p.name) });
  }
  if (state.proyecto) {
    for (const f of state.archivos) {
      out.push({ tipo: 'Archivo', titulo: f.path, hacer: () => { mostrarVentana('der', true); seleccionar(null); void navegarArchivo(f.path); } });
    }
    for (const inst of state.diagrama.modules) {
      const def = state.catalogo.get(inst.type);
      out.push({ tipo: 'Circuito', titulo: `${def?.name ?? inst.type} · ${inst.id}`, hacer: () => { mostrarVentana('der', true); seleccionar({ tipo: 'modulo', id: inst.id }); } });
    }
    for (const m of state.catalogo.values()) {
      out.push({ tipo: 'Módulo', titulo: `Agregar ${m.name}`, hacer: () => agregarModulo(m.type) });
    }
  }
  return out;
}

registrarPaleta({ candidatos: () => candidatosPaleta() });

$('dlg-buscar').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) ($('dlg-buscar') as HTMLDialogElement).close(); // click en el fondo
});
$('buscar-todo').onclick = () => abrirPaleta();
$('act-ajustes').onclick = () => { state.distribucionMensaje = ''; ($('dlg-ajustes') as HTMLDialogElement).showModal(); };
$('bienvenida-acerca').onclick = () => void navegacion.navigate({ project: null, aprender: {} });
$('bienvenida-importar').onclick = abrirImportador;

async function crearPracticaAprendizaje(plantillaId: string): Promise<void> {
  if (state.creandoPracticaAprendizaje) return;
  const nombre = window.prompt('Nombre del proyecto de práctica:', 'practica-led')?.trim();
  if (!nombre || state.creandoPracticaAprendizaje) return;
  state.creandoPracticaAprendizaje = true;
  const leccion = state.aprendizajeRuta?.leccion ? leccionPorId(state.aprendizajeRuta.leccion) : undefined;
  try {
    await crearConRecuperacion(
      () => api('/api/projects', { method: 'POST', body: JSON.stringify({ name: nombre, template: plantillaId }) }),
      async () => {
        const encontrado = await api(`/api/projects/${encodeURIComponent(nombre)}`);
        return encontrado.project?.name === nombre ? encontrado : null;
      },
    );
    if (leccion) asociarProyecto(almacenLocalAprendizaje(), leccion.id, leccion.revision, nombre);
    await cargarProyectos();
    await navegacion.navigate({ project: nombre, ...(leccion ? { leccion: leccion.id } : {}) });
  } catch (error) {
    nota('No se pudo crear la práctica: ' + String((error as Error)?.message ?? error));
  } finally {
    state.creandoPracticaAprendizaje = false;
  }
}

async function continuarPracticaAprendizaje(leccionId: string): Promise<void> {
  const leccion = leccionPorId(leccionId);
  const progreso = leccion && registroDeLeccion(almacenLocalAprendizaje(), leccion.id);
  const nombre = progreso?.proyectoNombre;
  if (!leccion || !nombre) return;
  try {
    const { projects } = await api('/api/projects');
    if (!projects.some((project: { name: string }) => project.name === nombre)) {
      quitarAsociacionProyecto(almacenLocalAprendizaje(), leccion.id, leccion.revision);
      const ultimoPaso = leccion.pasos[leccion.pasos.length - 1]?.id;
      nota('La práctica se eliminó. Podés crear una nueva desde el último paso de la lección.');
      await navegacion.navigate({ project: null, aprender: { leccion: leccion.id, ...(ultimoPaso ? { paso: ultimoPaso } : {}) } });
      return;
    }
    await cargarProyectos();
    await navegacion.navigate({ project: nombre, leccion: leccion.id });
  } catch (error) {
    nota('No se pudo abrir la práctica: ' + String((error as Error)?.message ?? error));
  }
}

async function volverALeccionAprendizaje(): Promise<void> {
  const leccion = state.leccionPracticaId ? leccionPorId(state.leccionPracticaId) : undefined;
  if (!leccion) return;
  const paso = registroDeLeccion(almacenLocalAprendizaje(), leccion.id)?.ultimoPasoId;
  await navegacion.navigate({ project: null, aprender: { leccion: leccion.id, ...(paso ? { paso } : {}) } });
}

// --- Arranque ---------------------------------------------------------------

// --- Depuración (ventana Debug) ------------------------------------------------------------

const depuracion = crearDepuracion({
  api: async (path, opts) => {
    const boardId = state.placaActivaId;
    const proyecto = state.proyecto?.name;
    let scoped = path;
    if (boardId && boardId !== 'board') {
      scoped += `${scoped.includes('?') ? '&' : '?'}boardId=${encodeURIComponent(boardId)}`;
      if (proyecto && !/[?&]project=/.test(scoped)) scoped += `&project=${encodeURIComponent(proyecto)}`;
    }
    const resultado = await api(scoped, opts);
    if (state.placaActivaId !== boardId || state.proyecto?.name !== proyecto) throw new Error('Cambió el contexto de depuración.');
    return resultado;
  }, $, escapar, nota, log,
  contexto: () => `${state.proyecto?.name}/${state.placaActivaId}`,
  proyecto: () => state.proyecto,
  archivoActivo: () => depuracionPlacaDisponible() ? state.activo : null,
  disponible: depuracionPlacaDisponible,
  archivos: () => state.archivos,
  irALinea: async (archivo, linea) => { if (depuracionPlacaDisponible()) await irALinea(archivo, linea); },
  abrirVentanaDebug: () => {
    mostrarVentana('abajo', true);
    elegirTabConsola('debug');
    mostrarVentana('der', true);
  },
  debugVisible: () => state.tab === 'debug' && ventanaVisible('consola'),
  nombrePin: nombrePinGpio,
  altoLinea: ALTO_LINEA,
  padEditor: PAD_EDITOR,
  scrollEditor,
  pintarEditorDebug: (marks) => { if (!microPythonActivo) return false; microPython.debug(marks); return true; },
});

/** El estado visible es la fuente para canonicalizar rutas resueltas o recuperadas. */
function rutaActual(): WorkspaceRoute {
  if (state.aprendizajeRuta) return { project: null, aprender: { ...state.aprendizajeRuta } };
  return state.proyecto ? {
    project: state.proyecto.name,
    ...(state.placaActivaId ? { board: state.placaActivaId } : {}),
    ...(state.activo ? { file: state.activo } : {}),
    ...(state.leccionPracticaId ? { leccion: state.leccionPracticaId } : {}),
  } : { project: null };
}

async function navegarArchivo(file: string, board = state.placaActivaId): Promise<void> {
  if (state.proyecto && board) await navegacion.navigate({ project: state.proyecto.name, board, file });
}

async function navegarPlaca(board: string): Promise<void> {
  if (state.proyecto) await navegacion.navigate({ project: state.proyecto.name, board });
}

/** Una actualización de metadatos conserva la selección válida y no agrega historial. */
async function recargarProyecto(nombre: string): Promise<void> {
  const anterior = rutaActual();
  const apertura = aperturas + 1;
  await abrirProyecto(nombre);
  if (aperturas !== apertura || state.proyecto?.name !== nombre) return;
  await aplicarContextoRuta({ ...anterior, project: nombre });
  if (aperturas !== apertura || state.proyecto?.name !== nombre) return;
  navegacion.replace(rutaActual());
}

async function aplicarContextoRuta(route: WorkspaceRoute): Promise<void> {
  if (state.proyecto?.name !== route.project) return;
  await cargarExplorador();
  if (state.proyecto?.name !== route.project) return;
  const target = resolveWorkspaceSelection(route, placasDelProyecto(state.proyecto), state.exploradorPlacas);
  if (!target.board) return;
  if (state.placaActivaId !== target.board || (target.file && state.activo !== target.file)) {
    await seleccionarPlaca(target.board, target.file);
  }
}

async function aplicarRuta(route: WorkspaceRoute): Promise<WorkspaceRoute> {
  try {
    if (route.aprender) {
      state.leccionPracticaId = null;
      const aprender = { ...route.aprender };
      const leccion = aprender.leccion ? leccionPorId(aprender.leccion) : undefined;
      if (leccion) {
        const guardado = registroDeLeccion(almacenLocalAprendizaje(), leccion.id)?.ultimoPasoId;
        const solicitado = aprender.paso ?? guardado;
        if (solicitado && leccion.pasos.some(paso => paso.id === solicitado)) aprender.paso = solicitado;
        else aprender.paso = leccion.pasos[0]?.id;
        if (aprender.paso) registrarPaso(almacenLocalAprendizaje(), leccion.id, leccion.revision, aprender.paso);
      }
      state.aprendizajeRuta = aprender;
      document.body.classList.remove('inicio');
      document.body.classList.add('aprender');
      $('bienvenida-proyectos').classList.remove('activa');
      $('bienvenida-acerca').classList.add('activa');
      return rutaActual();
    }
    state.aprendizajeRuta = null;
    document.body.classList.remove('aprender');
    if (!route.project) {
      mostrarInicio();
      await cargarProyectos();
      return rutaActual();
    }
    const leccionDeUrl = route.leccion ? leccionPorId(route.leccion) : undefined;
    const leccionAsociada = contenidoAprendizaje.find(leccion =>
      registroDeLeccion(almacenLocalAprendizaje(), leccion.id)?.proyectoNombre === route.project);
    state.leccionPracticaId = leccionDeUrl?.id ?? leccionAsociada?.id ?? null;
    if (state.proyecto?.name === route.project) pintarWidgetsProyecto();
    if (!state.proyectos.some(project => project.name === route.project)) await cargarProyectos();
    if (!state.proyectos.some(project => project.name === route.project)) {
      nota('El proyecto de la dirección no existe.');
      mostrarInicio();
      return rutaActual();
    }
    if (state.proyecto?.name !== route.project) await abrirProyecto(route.project);
    if (state.proyecto?.name !== route.project) return rutaActual();
    await aplicarContextoRuta(route);
    return rutaActual();
  } catch (error) {
    // Una parte del contexto puede haberse cargado: la URL debe describir lo visible.
    sel('proyecto').value = state.proyecto?.name ?? '';
    nota(`No se pudo abrir la dirección: ${String((error as Error)?.message ?? error)}`);
    if (!state.proyecto) mostrarInicio();
    return rutaActual();
  }
}

/** Espera el circuito pendiente y el editor antes de cualquier cambio de ruta. */
async function guardarAntesDeNavegar(): Promise<boolean> {
  const revision = revisionDiagrama;
  if (state.proyecto) {
    try {
      if (state.timerDiagrama) {
        clearTimeout(state.timerDiagrama);
        state.timerDiagrama = null;
        void enviarDiagrama(state.proyecto.name, JSON.stringify(state.diagrama));
      }
      await guardadoDiagrama;
    } catch (error) {
      guardarDiagrama();
      nota(`No se pudo guardar el circuito: ${String((error as Error).message)}`);
      sel('proyecto').value = state.proyecto?.name ?? '';
      return false;
    }
  }
  if (!await guardar(true)) {
    sel('proyecto').value = state.proyecto?.name ?? '';
    nota('No se pudo guardar el archivo. La navegación quedó pendiente; reintentá cuando se recupere la conexión.');
    return false;
  }
  if (state.editorSucio || revisionDiagrama !== revision || state.timerDiagrama) {
    sel('proyecto').value = state.proyecto?.name ?? '';
    nota('Hubo cambios durante el guardado. Reintentá la navegación para conservarlos.');
    return false;
  }
  return true;
}

const navegacion = createWorkspaceNavigation({
  apply: aplicarRuta,
  canLeave: guardarAntesDeNavegar,
  onError: error => {
    sel('proyecto').value = state.proyecto?.name ?? '';
    nota(`No se pudo abrir la dirección: ${String((error as Error)?.message ?? error)}`);
  },
});

(async function main() {
  // Antes que nada: React monta el lienzo (sincrónico, ver montarReact) y todo lo que viene
  // después ya puede dibujar en él.
  montarReact();
  restaurarVentanas();
  const { modules } = await api('/api/modules').catch(() => ({ modules: [] }));
  state.catalogo = new Map(modules.map((m) => [m.type, m]));
  await cargarChips();
  pintarGutter();
  conectarWS();
  await cargarPlacas();
  await cargarProyectos();
  await navegacion.start();
  const emu = await api('/api/emulator').catch(() => null);
  if (emu?.status) {
    aplicarEstadoEmulador(emu.status);
    aplicarEstadoEnVivo(emu);
    if (emu.status.running) vigilarSalidasDelDibujo();
    for (const line of emu.recentLog ?? []) log('emu', line);
  }
})();
