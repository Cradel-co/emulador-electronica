import { z } from 'zod';
import { MODULE_TYPE_RE, ModuleInstanceSchema, WireSchema, type ModuleInstance, type Wire } from './module.js';
import type { BoardDescriptor } from './board.js';

import { LANGUAGES, LanguageSchema, type Language } from './languages.js';
export { LANGUAGES, LanguageSchema, type Language };

/**
 * Placa de los proyectos que no dicen otra cosa (todos los anteriores al registro de placas).
 * Las placas son módulos programables del catálogo con un bloque `board` (board.ts):
 * el id de la placa es el `type` de ese módulo.
 */
export const DEFAULT_BOARD = 'esp32-s3-devkitc-1';
export const BoardSchema = z.string().regex(MODULE_TYPE_RE, 'id de placa: solo [a-z0-9-]');

/** Nombres de proyecto: solo [a-z0-9-], 1..40 chars (sección 13). */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name) && !name.includes('..');
}

export const SimConfigSchema = z.object({
  wifiSsid: z.string().min(1),
  wifiPassword: z.string(),
});

export type SimConfig = z.infer<typeof SimConfigSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z.string().min(1),
  board: BoardSchema.default(DEFAULT_BOARD),
  language: LanguageSchema,
  modules: z.array(ModuleInstanceSchema).default([]),
  wires: z.array(WireSchema).default([]),
  sim: SimConfigSchema,
});

export type Project = z.infer<typeof ProjectSchema>;

/** Id fijo de la placa dentro del dibujo: los cables la referencian como "board.GPIO6". */
export const BOARD_MODULE_ID = 'board';

/**
 * Proyecto nuevo con el circuito de prueba de la placa ya cableado: un botón en
 * `demo.input` y un LED en `demo.output` (GPIO6 → GPIO7 en los ESP32, D2 → D13 en el
 * Uno), así funciona sin tocar nada. Si la placa trae su propio dibujo para el
 * lenguaje (`templates.<lenguaje>.diagram`), se usa ese. Sin descriptor (proyectos y
 * pruebas viejas), el de siempre del ESP32-S3.
 */
export function defaultProject(name: string, language: Language, board: string = DEFAULT_BOARD, desc?: BoardDescriptor): Project {
  const placa: ModuleInstance = { id: BOARD_MODULE_ID, type: board, x: 0, y: 0, props: {} };
  const propio = desc?.templates[language]?.diagram;
  let modules: ModuleInstance[];
  let wires: Wire[];
  if (propio) {
    modules = [placa, ...propio.modules.filter((m) => m.id !== BOARD_MODULE_ID)];
    wires = propio.wires;
  } else {
    const demo = desc?.demo ?? { input: 'GPIO6', output: 'GPIO7', ground: 'GND', resistorOhms: undefined };
    const gnd = `board.${demo.ground}`;
    const r = demo.resistorOhms;
    modules = [
      placa,
      // Uno al lado del otro (no uno debajo del otro): así los cables no cruzan las etiquetas.
      { id: 'btn1', type: 'button', x: -200, y: 60, props: { label: 'Botón' } },
      { id: 'led1', type: 'led', x: -310, y: 50, props: { color: 'red' } },
      // A 5 V un LED sin resistencia se quema de verdad: la placa pide la suya.
      ...(r ? [{ id: 'r1', type: 'resistor', x: -310, y: 170, props: { ohms: r } }] : []),
    ];
    wires = [
      { from: 'btn1.OUT', to: `board.${demo.input}` },
      { from: 'btn1.GND', to: gnd },
      ...(r
        ? [
            { from: 'r1.1', to: `board.${demo.output}` },
            { from: 'led1.IN', to: 'r1.2' },
          ]
        : [{ from: 'led1.IN', to: `board.${demo.output}` }]),
      { from: 'led1.GND', to: gnd },
    ];
  }
  return {
    schemaVersion: 1,
    name,
    board,
    language,
    modules,
    wires,
    sim: {
      wifiSsid: 'sim-wifi',
      wifiPassword: 'sim-password',
    },
  };
}

/** Extensiones de archivo permitidas por lenguaje (sección 10.2). */
const C_EXTENSIONS = ['.c', '.cpp', '.cc', '.h', '.hpp', '.txt', '.cmake', '.defaults', '.yml'];
const C_FILE_NAMES = [
  'CMakeLists',
  'sdkconfig.defaults',
  'idf_component.yml',
  'Kconfig',
  'Kconfig.projbuild',
];

export const ALLOWED_FILE_EXTENSIONS: Record<Language, string[]> = {
  esphome: ['.yaml', '.yml'],
  'idf-c': C_EXTENSIONS,
  'idf-cpp': C_EXTENSIONS,
  arduino: C_EXTENSIONS,
  micropython: ['.py'],
};

/** Nombres de archivo sin extensión que también valen, por lenguaje. */
export const ALLOWED_FILE_NAMES: Record<Language, string[]> = {
  esphome: [],
  'idf-c': C_FILE_NAMES,
  'idf-cpp': C_FILE_NAMES,
  arduino: C_FILE_NAMES,
  micropython: [],
};

export function isAllowedFileName(language: Language, fileName: string): boolean {
  if (fileName.includes('\\') || fileName.includes('\0')) return false;
  if (fileName.length === 0 || fileName.length > 200) return false;
  // Subdirectorios permitidos (main/main.c), pero sin traversal ni segmentos ocultos.
  const segments = fileName.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
    if (seg.startsWith('.')) return false;
  }
  const base = segments[segments.length - 1]!;
  if (base === 'project.json' || base === 'secrets.yaml') return true;
  if (ALLOWED_FILE_NAMES[language].includes(base)) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = base.slice(dot).toLowerCase();
  return ALLOWED_FILE_EXTENSIONS[language].includes(ext);
}

/** Nombre del archivo principal de código de cada lenguaje. */
export const MAIN_FILE: Record<Language, string> = {
  esphome: 'main.yaml',
  'idf-c': 'main/main.c',
  'idf-cpp': 'main/main.cpp',
  arduino: 'sketch.cpp',
  micropython: 'main.py',
};
