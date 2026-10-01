import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_BOARD, LANGUAGES, type Language, type Project } from '@emu/shared';
import type { ModuloCatalogo } from './catalog.js';
import type { ProjectStore } from './projectStore.js';
import type { EmulatorStatus } from './emulator.js';
import type { ResultadoImportacion, SolicitudImportacion, OpcionesImportacion } from './moduleImporter.js';
import type { ResultadoValidacion } from './boardRegistry.js';
import type { ReporteCertificacion } from './certificacion.js';
import { nombreDePin } from '@emu/shared';
import type { Depurador } from './debug/depurador.js';
import { INSTRUCCIONES_DEBUG, registrarHerramientasDepuracion } from './debug/mcpDepuracion.js';
import {
  agregarModulo,
  cableadosConRol,
  conPlaca,
  conectar,
  configurarModulo,
  desconectar,
  gpioDe,
  moverModulo,
  pinesSinAlimentar,
  quitarModulo,
} from './diagramOps.js';

/**
 * Server MCP: control completo de la app para un agente (Claude Code, etc.).
 * Hace lo mismo que la UI y por los mismos caminos; los cambios se ven en vivo
 * en el navegador (eventos `project.changed` / `catalog.changed`).
 */

export interface McpContexto {
  store: ProjectStore;
  /** Crea un proyecto para una placa (valida placa ↔ lenguaje y escribe la plantilla). */
  crearProyecto: (nombre: string, lenguaje: Language | null, placa?: string | null, plantilla?: string) => Promise<Project>;
  plantillas: () => Promise<{ id: string; nombre: string; descripcion: string; board: string | null; language: string | null }[]>;
  /** Registro de placas (del catálogo), con su nivel de soporte. */
  placas: () => Promise<unknown[]>;
  esquemaPlaca: () => unknown;
  validarPlaca: (moduloJson: unknown) => ResultadoValidacion;
  certificarPlaca: (id: string, lenguaje?: Language) => Promise<ReporteCertificacion>;
  catalogo: () => Promise<ModuloCatalogo[]>;
  /** Lee el proyecto, aplica el cambio, lo guarda y avisa a la UI. */
  cambiarDiagrama: (nombre: string, cambio: (p: Project) => Project) => Promise<Project>;
  escribirArchivo: (nombre: string, ruta: string, contenido: string) => Promise<void>;
  pinesYAvisos: (nombre: string) => Promise<{
    pins: number[];
    warnings: { message: string }[];
    electrico?: { fuentes: unknown[]; placa: { estado: string; quemada: boolean; mensaje: string } | null; energizado: boolean };
  }>;
  /** La placa es un módulo: se agrega a un proyecto sin placa eligiendo su lenguaje, y se quita. */
  agregarPlaca: (nombre: string, tipo: string, lenguaje: Language, pos?: { x?: number; y?: number }) => Promise<Project>;
  quitarPlaca: (nombre: string) => Promise<Project>;
  /** Proyecto sin placa con el circuito energizado (▶), o null. */
  proyectoEnergizado: () => string | null;
  /** true si la placa estaba quemada (y ya no). */
  reemplazarPlaca: (nombre: string) => Promise<boolean>;
  /** Interruptor (pulsador, llave) cerrado/abierto, para el motor eléctrico. */
  fijarControl: (nombre: string, id: string, cerrado: boolean) => Promise<void>;
  compilar: (nombre: string) => Promise<{ ok: boolean; durationMs: number; errors: { line?: number | null; file?: string | null; message: string }[] }>;
  /** `sinAlimentacion`: no arrancó porque la placa no tiene energía adecuada (o está quemada), no por el código. */
  ejecutar: (nombre: string, recompilar: boolean) => Promise<{ ok: boolean; errors: { message: string }[]; sinAlimentacion?: boolean; energizado?: boolean }>;
  parar: () => Promise<void>;
  resetear: () => Promise<string>;
  estadoEmulador: () => EmulatorStatus;
  proyectoCorriendo: () => string | null;
  esperarEstado: (estados: string[], timeoutMs: number) => Promise<string | null>;
  /** false si la simulación no está corriendo con el puente listo. */
  ponerPin: (gpio: number, nivel: 0 | 1) => boolean;
  enviarRf: (bits: string, protocolo: number) => boolean;
  niveles: () => Record<number, 0 | 1>;
  logs: (fuente: 'build' | 'emu', n: number) => string[];
  esperarLog: (re: RegExp, timeoutMs: number) => Promise<string | null>;
  importar: (s: SolicitudImportacion, o: OpcionesImportacion) => Promise<ResultadoImportacion>;
  quitarDelCatalogo: (type: string) => Promise<void>;
  /** Modo debug (debug/mcpDepuracion.ts): herramientas debug_*. */
  depurador?: Depurador;
}

type Resultado = { content: { type: 'text'; text: string }[]; isError?: boolean };

const texto = (t: string): Resultado => ({ content: [{ type: 'text', text: t }] });
const json = (titulo: string, datos: unknown): Resultado => texto(`${titulo}\n${JSON.stringify(datos, null, 2)}`);
const falla = (t: string): Resultado => ({ content: [{ type: 'text', text: t }], isError: true });
const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Envuelve una herramienta: los errores vuelven como texto para el agente, no como excepción. */
function seguro<A>(fn: (args: A) => Promise<Resultado>): (args: A) => Promise<Resultado> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return falla(`Error: ${(err as Error).message}`);
    }
  };
}

const proyecto = z.string().describe('Nombre del proyecto (ver listar_proyectos)');

export function crearServidorMcp(ctx: McpContexto): McpServer {
  const server = new McpServer(
    { name: 'emulador-esp32', version: '1.0.0' },
    {
      instructions:
        'Emulador de electrónica con circuito visual, para varias placas (ESP32-S3/C3/C6 con esp-emu, Arduino Uno con avr8js, ' +
        'y las que se importen). Flujo típico: placas → listar_proyectos/crear_proyecto (con placa y lenguaje) → ver_proyecto → ' +
        'catalogo → agregar_modulo + conectar ("btn1.OUT" con "GPIO6" o "D2", según la placa) → escribir_archivo → ejecutar → ' +
        'accionar_modulo / leer_pines / esperar_log → parar. La placa ("board") es el único módulo con código; ' +
        'los demás se cablean a sus pines. Los pines reservados de cada placa están en `placas` (board.reservedPins). ' +
        'Placas nuevas: esquema_placa → armar el module.json con su bloque "board" → validar_placa → importar_modulo → certificar_placa. ' +
        'Todo lo que hagas se ve en vivo en la UI (http://127.0.0.1:5180). ' +
        INSTRUCCIONES_DEBUG,
    },
  );
  if (ctx.depurador) registrarHerramientasDepuracion(server, ctx.depurador);
  const defs = async (): Promise<Map<string, ModuloCatalogo>> => new Map((await ctx.catalogo()).map((m) => [m.type, m]));

  // --- Estado y proyectos --------------------------------------------------------

  server.registerTool('estado', {
    title: 'Estado de la simulación',
    description: 'Estado del emulador (detenido, corriendo...), proyecto en ejecución, puertos y niveles conocidos de los pines de salida.',
    inputSchema: {},
  }, seguro(async () => {
    const s = ctx.estadoEmulador();
    return json('Estado:', {
      estado: s.state,
      corriendo: s.running,
      simulacionLista: s.state === 'bridge',
      proyecto: ctx.proyectoCorriendo(),
      ip: s.ip,
      web: s.ports?.web ? `http://127.0.0.1:${s.ports.web}` : null,
      pinesEnAlto: Object.entries(ctx.niveles()).filter(([, v]) => v === 1).map(([k]) => Number(k)),
    });
  }));

  server.registerTool('listar_proyectos', {
    title: 'Listar proyectos',
    description: 'Lista los proyectos con su lenguaje y cuántos módulos tiene su circuito.',
    inputSchema: {},
  }, seguro(async () => {
    const lista = await ctx.store.list();
    return json(`${lista.length} proyecto(s):`, lista.map((p) => ({ nombre: p.name, placa: p.board, lenguaje: p.language, modulos: p.modules.length })));
  }));

  server.registerTool('crear_proyecto', {
    title: 'Crear proyecto',
    description:
      'Crea un proyecto para una placa. Arranca con el circuito de prueba de la placa ya cableado (botón → LED: ' +
      'GPIO6 → GPIO7 en los ESP32, D2 → D13 en el Arduino Uno) y un código que lo usa. Ver `placas` para los lenguajes de cada una. ' +
      'Con `plantilla` (ver `plantillas`) copia un proyecto de ejemplo de projects/_template/ (su placa y lenguaje mandan). ' +
      'Con `sin_placa: true` crea un proyecto SIN placa: solo un circuito (Fuente regulable + pulsador + LED + resistencia, ' +
      'cerrado contra el GND de la fuente), sin código; `ejecutar` lo energiza y `parar` lo apaga. Una placa se le agrega después con agregar_modulo.',
    inputSchema: {
      nombre: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).describe('Solo [a-z0-9-], hasta 40 caracteres'),
      lenguaje: z.enum(LANGUAGES).default('esphome'),
      placa: z.string().default(DEFAULT_BOARD).describe('Id de la placa (ver la herramienta placas), p. ej. "arduino-uno"'),
      plantilla: z.string().optional().describe('Id de una plantilla (ver la herramienta plantillas)'),
      sin_placa: z.boolean().default(false).describe('Proyecto sin placa: solo circuito (fuente regulable y componentes)'),
    },
  }, seguro(async ({ nombre, lenguaje, placa, plantilla, sin_placa }) => {
    const p = sin_placa ? await ctx.crearProyecto(nombre, null, null) : await ctx.crearProyecto(nombre, lenguaje, placa, plantilla);
    const que = p.board ? `${p.board}, ${p.language}` : 'sin placa: solo circuito';
    return texto(`Proyecto "${p.name}" creado (${que}). Abrilo en la UI: http://127.0.0.1:5180/#${p.name}`);
  }));

  server.registerTool('plantillas', {
    title: 'Plantillas de proyecto',
    description: 'Proyectos de ejemplo de projects/_template/ para usar con crear_proyecto: id, nombre, descripción, placa y lenguaje.',
    inputSchema: {},
  }, seguro(async () => json('Plantillas:', await ctx.plantillas())));

  // --- Placas ---------------------------------------------------------------------

  server.registerTool('placas', {
    title: 'Placas disponibles',
    description:
      'Registro de placas (sale del catálogo: módulos programables con bloque "board"): chip, motor de emulación, lenguajes, ' +
      'pines (nombre → gpio lógico), reservados, advertencias y nivel de soporte (declarado y certificado).',
    inputSchema: {},
  }, seguro(async () => json('Placas:', await ctx.placas())));

  server.registerTool('esquema_placa', {
    title: 'Esquema de placa (JSON Schema)',
    description:
      'JSON Schema del bloque "board" de un module.json (y del module.json completo). Sirve para armar una placa nueva ' +
      '(por ejemplo desde un esquemático o una hoja de datos) sin tocar código del server.',
    inputSchema: {},
  }, seguro(async () => json('JSON Schema:', ctx.esquemaPlaca())));

  server.registerTool('validar_placa', {
    title: 'Validar una placa',
    description:
      'Valida un module.json de placa sin instalarlo: esquema, que cada pin de board.pins exista en pins[], reservados, ' +
      'motor y toolchains registrados y sus opciones. Devuelve errores, avisos y el nivel de soporte que tendría.',
    inputSchema: { module_json: z.string().max(2 * 1024 * 1024).describe('Contenido del module.json (texto JSON)') },
  }, seguro(async ({ module_json }) => {
    let datos: unknown;
    try {
      datos = JSON.parse(module_json);
    } catch (err) {
      return falla(`No es JSON válido: ${(err as Error).message}`);
    }
    const r = ctx.validarPlaca(datos);
    const res = json(r.ok ? 'Placa válida:' : 'La placa tiene errores:', r);
    return r.ok ? res : { ...res, isError: true };
  }));

  server.registerTool('certificar_placa', {
    title: 'Certificar una placa',
    description:
      'Compila la plantilla de la placa, la emula y prueba el circuito de prueba (board.demo: botón → LED). Devuelve un ' +
      'reporte paso a paso y el nivel de soporte comprobado: "emula", "compila" o "solo-dibujo". Puede tardar minutos ' +
      '(la primera compilación de ESPHome baja el toolchain).',
    inputSchema: {
      placa: z.string().describe('Id de la placa (el "type" de su módulo)'),
      lenguaje: z.enum(LANGUAGES).optional().describe('Por defecto, el más rápido de la placa'),
    },
  }, seguro(async ({ placa, lenguaje }) => {
    const r = await ctx.certificarPlaca(placa, lenguaje);
    const res = json(`Certificación de ${placa}: ${r.nivel}`, r);
    return r.nivel === 'emula' ? res : { ...res, isError: true };
  }));

  server.registerTool('ver_proyecto', {
    title: 'Ver proyecto',
    description: 'Circuito (módulos con sus pines y conexiones), archivos de código y chequeo circuito ↔ código de un proyecto.',
    inputSchema: { proyecto },
  }, seguro(async ({ proyecto: nombre }) => {
    const p = conPlaca(await ctx.store.read(nombre));
    const catalogo = await defs();
    const archivos = await ctx.store.listFiles(nombre, p.language);
    const chequeo = await ctx.pinesYAvisos(nombre);
    return json(`Proyecto ${p.name} (${p.board}, ${p.language}):`, {
      placa: p.board,
      modulos: p.modules.map((m) => {
        const def = catalogo.get(m.type);
        return {
          id: m.id,
          tipo: m.type,
          nombre: def?.name ?? '(no está en el catálogo)',
          programable: Boolean(def?.programmable),
          posicion: { x: m.x, y: m.y, ...(m.rotation ? { rotacion: m.rotation } : {}) },
          props: m.props,
          pines: def && !def.programmable ? def.pins.map((pin) => {
            const ref = `${m.id}.${pin.name}`;
            const cables = p.wires.filter((w) => w.from === ref || w.to === ref).map((w) => (w.from === ref ? w.to : w.from));
            return { pin: pin.name, tipo: pin.kind, conectadoA: cables };
          }) : undefined,
        };
      }),
      cables: p.wires,
      archivos: archivos.map((f) => f.path).filter((f) => !/secrets\.yaml$/.test(f)),
      pinesQueUsaElCodigo: chequeo.pins,
      avisos: chequeo.warnings.map((w) => w.message),
      alimentacionPlaca: chequeo.electrico?.placa
        ? { estado: chequeo.electrico.placa.estado, quemada: chequeo.electrico.placa.quemada, detalle: chequeo.electrico.placa.mensaje }
        : 'sin placa',
      ...(p.board ? {} : { energizado: Boolean(chequeo.electrico?.energizado) }),
      // Lo que entrega cada fuente regulable (CV/CC, mA, W): lo mismo que la ventana Debug.
      fuentes: chequeo.electrico?.fuentes,
    });
  }));

  server.registerTool('reemplazar_placa', {
    title: 'Reemplazar placa quemada',
    description: 'Pone una placa nueva en un proyecto cuya placa se quemó (por sobretensión o polaridad invertida en la alimentación). Arreglá el cableado antes: si la sobretensión sigue, la nueva también se quema.',
    inputSchema: { proyecto },
  }, seguro(async ({ proyecto: nombre }) => {
    const habia = await ctx.reemplazarPlaca(nombre);
    return texto(habia ? `Placa de "${nombre}" reemplazada por una nueva.` : `La placa de "${nombre}" no estaba quemada.`);
  }));

  // --- Código ----------------------------------------------------------------------------

  server.registerTool('leer_archivo', {
    title: 'Leer archivo de código',
    description: 'Lee un archivo del proyecto (p. ej. main.yaml, main/main.c, sketch.cpp, main.py).',
    inputSchema: { proyecto, ruta: z.string() },
  }, seguro(async ({ proyecto: nombre, ruta }) => {
    const p = await ctx.store.read(nombre);
    return texto(await ctx.store.readFile(nombre, ruta, p.language));
  }));

  server.registerTool('escribir_archivo', {
    title: 'Escribir archivo de código',
    description: 'Escribe (crea o reemplaza) un archivo de código del ESP32. Si está abierto en la UI, se recarga.',
    inputSchema: { proyecto, ruta: z.string(), contenido: z.string().max(512 * 1024) },
  }, seguro(async ({ proyecto: nombre, ruta, contenido }) => {
    await ctx.escribirArchivo(nombre, ruta, contenido);
    const chequeo = await ctx.pinesYAvisos(nombre);
    const avisos = chequeo.warnings.map((w) => `- ${w.message}`).join('\n');
    return texto(`Guardado ${ruta} (${contenido.length} caracteres).${avisos ? `\nChequeo circuito ↔ código:\n${avisos}` : ''}`);
  }));

  // --- Catálogo ------------------------------------------------------------------------------

  server.registerTool('catalogo', {
    title: 'Catálogo de módulos',
    description: 'Módulos disponibles para agregar al circuito: pines, rol en la simulación, controles y propiedades.',
    inputSchema: { buscar: z.string().optional().describe('Filtra por nombre, tipo o categoría') },
  }, seguro(async ({ buscar }) => {
    const filtro = buscar?.toLowerCase();
    const lista = (await ctx.catalogo()).filter((m) => !filtro || `${m.name} ${m.type} ${m.category}`.toLowerCase().includes(filtro));
    return json(`${lista.length} módulo(s):`, lista.map((m) => ({
      tipo: m.type,
      nombre: m.name,
      categoria: m.category,
      descripcion: m.description,
      programable: m.programmable,
      rol: m.bridge?.role ?? null,
      pines: m.programmable ? '(placa: ver la herramienta placas)' : m.pins.map((p) => `${p.name} (${p.kind})`),
      props: Object.fromEntries(Object.entries(m.props).map(([k, p]) => [k, { tipo: p.type, defecto: p.default, opciones: p.enum }])),
      deFabrica: m.builtin,
    })));
  }));

  server.registerTool('importar_modulo', {
    title: 'Importar módulo al catálogo',
    description:
      'Agrega módulos al catálogo desde UNA fuente: `url` (zip, module.json, .chip.json de Wokwi o repo de GitHub ' +
      'https://github.com/dueño/repo[/tree/rama/carpeta]), `archivos` ({"mi-modulo/module.json": "...", "mi-modulo/module.svg": "..."}) ' +
      'o `chip_wokwi` (contenido de un .chip.json). Formato de módulo: ver modules/README.md.',
    inputSchema: {
      url: z.string().url().optional(),
      archivos: z.record(z.string(), z.string()).optional(),
      chip_wokwi: z.string().optional(),
      rol: z.enum(['input', 'output', 'rf-rx', 'rf-tx']).optional().describe('Solo Wokwi: rol del chip en la simulación'),
      pin: z.string().optional().describe('Solo Wokwi: pin del puente'),
      categoria: z.string().optional().describe('Solo Wokwi: categoría del catálogo'),
      reemplazar: z.boolean().default(false),
      solo_validar: z.boolean().default(false),
    },
  }, seguro(async (a) => {
    const fuentes = [a.url, a.archivos, a.chip_wokwi].filter((x) => x !== undefined);
    if (fuentes.length !== 1) return falla('Indicá exactamente una fuente: url, archivos o chip_wokwi.');
    const solicitud: SolicitudImportacion = a.url
      ? { fuente: 'url', url: a.url }
      : a.archivos
        ? { fuente: 'archivos', archivos: a.archivos }
        : { fuente: 'wokwi', chipJson: a.chip_wokwi! };
    const r = await ctx.importar(solicitud, {
      sobrescribir: a.reemplazar,
      soloValidar: a.solo_validar,
      wokwi: { role: a.rol, pin: a.pin, category: a.categoria },
    });
    const res = json(a.solo_validar ? 'Validación:' : 'Importación:', r);
    return r.importados.length === 0 && r.errores.length > 0 ? { ...res, isError: true } : res;
  }));

  server.registerTool('quitar_modulo_catalogo', {
    title: 'Quitar módulo del catálogo',
    description: 'Quita un módulo importado del catálogo (los de fábrica no se pueden quitar).',
    inputSchema: { tipo: z.string() },
  }, seguro(async ({ tipo }) => {
    await ctx.quitarDelCatalogo(tipo);
    return texto(`Módulo "${tipo}" quitado del catálogo.`);
  }));

  // --- Circuito ----------------------------------------------------------------------------------

  server.registerTool('agregar_modulo', {
    title: 'Agregar módulo al circuito',
    description:
      'Agrega un módulo del catálogo al circuito. Devuelve su id (p. ej. "rx1") y sus pines para conectarlos. ' +
      'Una placa (módulo programable) solo se agrega a un proyecto sin placa, indicando `lenguaje`: queda con id "board" y con su código inicial.',
    inputSchema: {
      proyecto,
      tipo: z.string().describe('Tipo del catálogo, p. ej. "rxb6", "led", "button", o una placa ("esp32-s3-devkitc-1")'),
      lenguaje: z.enum(LANGUAGES).optional().describe('Solo para placas: en qué se programa'),
      id: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      rotacion: z.number().min(0).lt(360).optional().describe('Grados'),
      props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    },
  }, seguro(async ({ proyecto: nombre, tipo, lenguaje, id, x, y, rotacion, props }) => {
    const def = (await defs()).get(tipo);
    if (!def) return falla(`No hay ningún módulo "${tipo}" en el catálogo (ver la herramienta catalogo).`);
    if (def.programmable) {
      if (!lenguaje) return falla(`"${def.name}" es una placa: indicá \`lenguaje\` (ver la herramienta placas).`);
      await ctx.agregarPlaca(nombre, tipo, lenguaje, { x, y });
      return texto(`Agregada la placa ${def.name} (id "board", ${lenguaje}), con su código inicial. Sus pines se referencian como "board.<pin>".`);
    }
    let nuevo = '';
    await ctx.cambiarDiagrama(nombre, (p) => {
      const r = agregarModulo(p, def, { id, x, y, rotation: rotacion, props });
      nuevo = r.id;
      return r.project;
    });
    const pines = def.pins.map((p) => `${nuevo}.${p.name} (${p.kind})`).join(', ');
    return texto(`Agregado "${nuevo}" (${def.name}).${pines ? ` Pines: ${pines}. Conectalos con "conectar".` : ' Es inalámbrico: no lleva cables.'}`);
  }));

  server.registerTool('quitar_modulo', {
    title: 'Quitar módulo del circuito',
    description: 'Quita un módulo del circuito junto con sus cables.',
    inputSchema: { proyecto, id: z.string() },
  }, seguro(async ({ proyecto: nombre, id }) => {
    if (id === 'board') {
      await ctx.quitarPlaca(nombre);
      return texto('Quitada la placa y sus cables: el proyecto queda sin placa (solo circuito). Su código queda guardado por si la volvés a agregar.');
    }
    await ctx.cambiarDiagrama(nombre, (p) => quitarModulo(p, id));
    return texto(`Quitado "${id}" y sus cables.`);
  }));

  server.registerTool('mover_modulo', {
    title: 'Mover módulo',
    description: 'Mueve (y opcionalmente rota) un módulo en el canvas. La placa está en 0,0 (su tamaño depende de la placa: ver catalogo/placas).',
    inputSchema: {
      proyecto, id: z.string(), x: z.number(), y: z.number(),
      rotacion: z.number().min(0).lt(360).optional().describe('Grados (0, 90, 180, 270...). Sin indicar, conserva la actual.'),
    },
  }, seguro(async ({ proyecto: nombre, id, x, y, rotacion }) => {
    await ctx.cambiarDiagrama(nombre, (p) => moverModulo(p, id, x, y, rotacion));
    return texto(`"${id}" movido a (${x}, ${y})${rotacion === undefined ? '' : `, rotado ${rotacion}°`}.`);
  }));

  server.registerTool('configurar_modulo', {
    title: 'Configurar módulo',
    description: 'Cambia propiedades de un módulo (p. ej. el color de un LED o los códigos de un control remoto).',
    inputSchema: { proyecto, id: z.string(), props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) },
  }, seguro(async ({ proyecto: nombre, id, props }) => {
    const catalogo = await defs();
    await ctx.cambiarDiagrama(nombre, (p) => {
      const inst = p.modules.find((m) => m.id === id);
      const def = inst && catalogo.get(inst.type);
      if (!def) throw new Error(`no hay un módulo "${id}" (o no está en el catálogo)`);
      return configurarModulo(p, id, def, props);
    });
    return texto(`"${id}" configurado: ${JSON.stringify(props)}`);
  }));

  server.registerTool('conectar', {
    title: 'Conectar con un cable',
    description:
      'Conecta dos pines con un cable. Formato "id.PIN": "btn1.OUT", "rx1.VCC". Para la placa sirve el nombre del pin ' +
      '("GPIO6" o "board.GPIO6" en un ESP32, "D13"/"A0" en el Uno), el número ("6") o "board.GND", "board.5V"...',
    inputSchema: { proyecto, desde: z.string(), hasta: z.string() },
  }, seguro(async ({ proyecto: nombre, desde, hasta }) => {
    const catalogo = await defs();
    let cable = { from: '', to: '' };
    const p = await ctx.cambiarDiagrama(nombre, (pr) => {
      const r = conectar(pr, desde, hasta, (t) => catalogo.get(t));
      cable = r.wire;
      return r.project;
    });
    const chequeo = await ctx.pinesYAvisos(p.name);
    const avisos = chequeo.warnings.map((w) => `- ${w.message}`).join('\n');
    return texto(`Conectado ${cable.from} → ${cable.to}.${avisos ? `\nChequeo circuito ↔ código:\n${avisos}` : ''}`);
  }));

  server.registerTool('desconectar', {
    title: 'Desconectar',
    description: 'Quita el cable entre dos pines, o todos los cables de un pin si no se indica `hasta`.',
    inputSchema: { proyecto, desde: z.string(), hasta: z.string().optional() },
  }, seguro(async ({ proyecto: nombre, desde, hasta }) => {
    const catalogo = await defs();
    let quitados: { from: string; to: string }[] = [];
    await ctx.cambiarDiagrama(nombre, (p) => {
      const r = desconectar(p, desde, hasta, (t) => catalogo.get(t));
      quitados = r.quitados;
      return r.project;
    });
    return texto(`Quitado(s): ${quitados.map((w) => `${w.from} → ${w.to}`).join(', ')}`);
  }));

  // --- Simulación ------------------------------------------------------------------------------------

  const fallaCompilacion = (errors: { message: string; line?: number | null; file?: string | null }[]): string =>
    errors.map((e) => `- ${e.file ?? ''}${e.line ? `:${e.line}` : ''} ${e.message}`).join('\n');

  server.registerTool('compilar', {
    title: 'Compilar',
    description: 'Compila el firmware del proyecto (ESPHome/ESP-IDF/Arduino/MicroPython, con Docker). Puede tardar minutos la primera vez.',
    inputSchema: { proyecto },
  }, seguro(async ({ proyecto: nombre }) => {
    const r = await ctx.compilar(nombre);
    if (r.ok) return texto(`Compilación OK en ${(r.durationMs / 1000).toFixed(1)} s.`);
    const cola = ctx.logs('build', 25).join('\n');
    return falla(`La compilación falló (${(r.durationMs / 1000).toFixed(1)} s):\n${fallaCompilacion(r.errors)}\n\nÚltimas líneas:\n${cola}`);
  }));

  server.registerTool('ejecutar', {
    title: 'Ejecutar simulación',
    description:
      'Compila (si hace falta) y arranca el emulador. Espera a que el puente esté listo, así los módulos responden. ' +
      'En un proyecto sin placa no hay firmware: energiza el circuito (las fuentes regulables entregan tensión) hasta `parar`.',
    inputSchema: {
      proyecto,
      recompilar: z.boolean().default(true),
      esperar_segundos: z.number().int().min(0).max(600).default(240),
    },
  }, seguro(async ({ proyecto: nombre, recompilar, esperar_segundos }) => {
    const r = await ctx.ejecutar(nombre, recompilar);
    if (r.ok && r.energizado) {
      return texto('Circuito energizado (proyecto sin placa): las fuentes regulables entregan tensión. Los LEDs y consumos están en ver_proyecto; `parar` lo apaga.');
    }
    if (!r.ok && r.sinAlimentacion) {
      return falla(`No arrancó: ${r.errors.map((e) => e.message).join(' ')}\n(ver alimentacionPlaca en ver_proyecto; con reemplazar_placa si se quemó)`);
    }
    if (!r.ok) {
      return falla(`No arrancó: la compilación falló.\n${fallaCompilacion(r.errors)}\n\nÚltimas líneas:\n${ctx.logs('build', 25).join('\n')}`);
    }
    if (esperar_segundos === 0) return texto('Emulador arrancando (no se esperó al puente).');
    const estado = await ctx.esperarEstado(['bridge', 'crashed', 'hung', 'stopped'], esperar_segundos * 1000);
    const cola = ctx.logs('emu', 15).join('\n');
    if (estado === 'bridge') return texto(`Simulación corriendo y lista (puente conectado).\n\nÚltimas líneas:\n${cola}`);
    return falla(`La simulación no quedó lista (estado: ${estado ?? 'tiempo agotado'}).\n\nÚltimas líneas:\n${cola}`);
  }));

  server.registerTool('parar', {
    title: 'Parar simulación',
    description: 'Detiene el emulador.',
    inputSchema: {},
  }, seguro(async () => {
    await ctx.parar();
    return texto('Emulador detenido.');
  }));

  server.registerTool('resetear', {
    title: 'Resetear la placa',
    description: 'Resetea el microcontrolador emulado (como apretar RST/RESET), sin recompilar.',
    inputSchema: {},
  }, seguro(async () => texto(`Reset: ${await ctx.resetear()}`)));

  const noCorre = 'La simulación no está lista: ejecutá el proyecto primero (herramienta ejecutar).';

  server.registerTool('accionar_modulo', {
    title: 'Accionar un módulo',
    description:
      'Usa un módulo del circuito como lo haría una persona, con la simulación corriendo (o, sin placa, con el circuito energizado). ' +
      'Botones/interruptores: presionar, soltar, pulsar (presiona y suelta), encender, apagar. ' +
      'Control remoto 433: boton_A..boton_D. Sensor de puerta 433: abrir, cerrar. Otros inalámbricos: transmitir.',
    inputSchema: {
      id: z.string().describe('Id del módulo en el circuito, p. ej. "btn1"'),
      accion: z.enum(['presionar', 'soltar', 'pulsar', 'encender', 'apagar', 'boton_A', 'boton_B', 'boton_C', 'boton_D', 'abrir', 'cerrar', 'transmitir']),
      duracion_ms: z.number().int().min(10).max(10_000).default(200).describe('Solo para pulsar'),
      proyecto: z.string().optional().describe('Por defecto, el que está corriendo'),
    },
  }, seguro(async ({ id, accion, duracion_ms, proyecto: nombre }) => {
    const corriendo = ctx.proyectoCorriendo();
    const energizado = ctx.proyectoEnergizado();
    const cual = nombre ?? corriendo ?? energizado;
    if (!cual) return falla(noCorre);
    // Sin placa no hay emulador: alcanza con que el circuito esté energizado (solo interruptores).
    const sinPlacaVivo = cual === energizado;
    if (!sinPlacaVivo) {
      if (ctx.estadoEmulador().state !== 'bridge') return falla(noCorre);
      if (corriendo && cual !== corriendo) return falla(`El que está corriendo es "${corriendo}", no "${cual}".`);
    }
    const p = conPlaca(await ctx.store.read(cual));
    const catalogo = await defs();
    const buscar = (t: string): ModuloCatalogo | undefined => catalogo.get(t);
    const inst = p.modules.find((m) => m.id === id);
    const def = inst && buscar(inst.type);
    if (!inst || !def) return falla(`No hay un módulo "${id}" en el circuito de ${cual}.`);
    const rol = def.bridge?.role;

    if (rol === 'input') {
      const gpio = gpioDe(p, id, def.bridge!.pin, buscar);
      // Un interruptor (pulsador, llave) también sirve sin GPIO: cierra un circuito sin código.
      const esInterruptor = Boolean(def.switch);
      if (gpio === null && !esInterruptor) return falla(`El pin ${def.bridge!.pin} de "${id}" no está conectado a un pin de la placa.`);
      // Un interruptor no se "alimenta": sus dos patas son terminales del circuito (mismo criterio
      // que el arreglo de la UI del PR #5).
      const faltan = gpio === null || esInterruptor ? [] : pinesSinAlimentar(p, id, def);
      if (faltan.length > 0) {
        return falla(`"${def.name}" (${id}) sin alimentación: conectá también ${faltan.join(' y ')}, como en la vida real.`);
      }
      const activo = (def.bridge!.activeLevel ?? 1) as 0 | 1;
      const inactivo = (1 - activo) as 0 | 1;
      /**
       * Un interruptor se cierra o se abre en el circuito, y lo que lee el pin lo resuelve el motor
       * (fijarControl → refrescarEntradasDelCircuito): con el pull que activó el programa y los
       * umbrales del chip, como en la placa real. Otro módulo de entrada le dice su nivel directo.
       */
      const aplicar = async (cerrado: boolean): Promise<boolean> => {
        if (esInterruptor) {
          await ctx.fijarControl(cual, id, cerrado);
          return true;
        }
        return gpio === null || ctx.ponerPin(gpio, cerrado ? activo : inactivo);
      };
      if (accion === 'presionar' || accion === 'encender') {
        if (!(await aplicar(true))) return falla(noCorre);
      } else if (accion === 'soltar' || accion === 'apagar') {
        if (!(await aplicar(false))) return falla(noCorre);
      } else if (accion === 'pulsar') {
        if (!(await aplicar(true))) return falla(noCorre);
        await dormir(duracion_ms);
        await aplicar(false);
      } else {
        return falla(`"${def.name}" es una entrada: usá presionar, soltar, pulsar, encender o apagar.`);
      }
      const destino = gpio === null || !p.board ? 'circuito (sin GPIO: cierra o abre el paso de corriente)' : nombreDePin(catalogo.get(p.board)?.board, gpio);
      return texto(`${id} (${def.name}): ${accion} → ${destino}`);
    }

    if (rol === 'air') {
      if (cableadosConRol(p, 'rf-rx', buscar).length === 0) {
        return falla('Nadie recibe la señal: agregá un Receptor RF RXB6 y conectá su DATA a un GPIO del ESP32.');
      }
      let bits: unknown;
      if (accion.startsWith('boton_')) bits = inst.props[`code${accion.slice(-1)}`];
      else if (accion === 'abrir' || accion === 'transmitir') bits = inst.props.code;
      else if (accion === 'cerrar') return texto(`${id}: cerrado (el sensor solo transmite al abrir).`);
      if (typeof bits !== 'string' || !/^[01]+$/.test(bits)) {
        return falla(`"${def.name}" no tiene un código válido para "${accion}" (props: ${JSON.stringify(inst.props)}).`);
      }
      const protocolo = Number(inst.props.protocol ?? 1);
      if (!ctx.enviarRf(bits, protocolo)) return falla(noCorre);
      return texto(`${id} transmitió ${bits} (protocolo ${protocolo}).`);
    }

    if (rol === 'output') return falla(`"${def.name}" es una salida: se lee con leer_pines.`);
    return falla(`"${def.name}" no tiene controles en la simulación.`);
  }));

  server.registerTool('poner_pin', {
    title: 'Poner un nivel en un pin',
    description: 'Bajo nivel: fija el nivel de un pin de entrada de la placa por su número lógico (GPIO en ESP32; en el Uno D13 = 13, A0 = 14).',
    inputSchema: { gpio: z.number().int().min(0).max(255), nivel: z.union([z.literal(0), z.literal(1)]) },
  }, seguro(async ({ gpio, nivel }) => (ctx.ponerPin(gpio, nivel) ? texto(`GPIO${gpio} = ${nivel}`) : falla(noCorre))));

  server.registerTool('enviar_rf', {
    title: 'Enviar código RF 433',
    description: 'Bajo nivel: hace llegar un código RF al receptor del ESP32 (como un control remoto).',
    inputSchema: { bits: z.string().regex(/^[01]{1,64}$/), protocolo: z.number().int().min(1).max(12).default(1) },
  }, seguro(async ({ bits, protocolo }) => (ctx.enviarRf(bits, protocolo) ? texto(`Enviado ${bits} (protocolo ${protocolo}).`) : falla(noCorre))));

  server.registerTool('leer_pines', {
    title: 'Leer pines y salidas',
    description: 'Niveles de salida de los GPIO que reportó el firmware, y cómo está cada módulo de salida del circuito (LED prendido, relé cerrado...).',
    inputSchema: {},
  }, seguro(async () => {
    const niveles = ctx.niveles();
    const nombre = ctx.proyectoCorriendo();
    const salidas: Record<string, unknown>[] = [];
    if (nombre) {
      const p = conPlaca(await ctx.store.read(nombre));
      const catalogo = await defs();
      for (const inst of p.modules) {
        const def = catalogo.get(inst.type);
        if (def?.bridge?.role !== 'output') continue;
        const gpio = gpioDe(p, inst.id, def.bridge.pin, (t) => catalogo.get(t));
        const faltan = pinesSinAlimentar(p, inst.id, def);
        // Sin GND/VCC, "encendido" da false aunque el pin esté en 1: como en la vida real.
        salidas.push({
          id: inst.id, modulo: def.name, gpio,
          encendido: gpio !== null && niveles[gpio] === 1 && faltan.length === 0,
          ...(faltan.length ? { sinAlimentar: faltan } : {}),
        });
      }
    }
    return json('Pines:', { estado: ctx.estadoEmulador().state, niveles, modulosDeSalida: salidas });
  }));

  server.registerTool('leer_log', {
    title: 'Leer log',
    description: 'Últimas líneas del log del emulador (lo que imprime el ESP32) o de la compilación.',
    inputSchema: {
      fuente: z.enum(['emulador', 'compilacion']).default('emulador'),
      ultimas: z.number().int().min(1).max(2000).default(80),
      filtro: z.string().optional().describe('Solo líneas que contengan este texto'),
    },
  }, seguro(async ({ fuente, ultimas, filtro }) => {
    let lineas = ctx.logs(fuente === 'emulador' ? 'emu' : 'build', filtro ? 2000 : ultimas);
    if (filtro) lineas = lineas.filter((l) => l.toLowerCase().includes(filtro.toLowerCase())).slice(-ultimas);
    return texto(lineas.join('\n') || '(sin líneas)');
  }));

  server.registerTool('esperar_log', {
    title: 'Esperar una línea del log',
    description: 'Espera a que el ESP32 imprima una línea que cumpla una expresión regular (solo líneas nuevas). Útil después de accionar un módulo.',
    inputSchema: { patron: z.string().max(500), segundos: z.number().min(1).max(600).default(30) },
  }, seguro(async ({ patron, segundos }) => {
    let re: RegExp;
    try {
      re = new RegExp(patron, 'i');
    } catch (err) {
      return falla(`Expresión regular inválida: ${(err as Error).message}`);
    }
    const linea = await ctx.esperarLog(re, segundos * 1000);
    return linea ? texto(linea) : falla(`No apareció ninguna línea que cumpla /${patron}/ en ${segundos} s.`);
  }));

  return server;
}
