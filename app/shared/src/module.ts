import { z } from 'zod';
import { BoardDescriptorSchema } from './board.js';

export const BRIDGE_ROLES = ['input', 'output', 'rf-rx', 'rf-tx', 'air'] as const;
export type BridgeRole = (typeof BRIDGE_ROLES)[number];

export const PinKind = z.enum([
  'digital-in',
  'digital-out',
  'digital-io',
  'power',
  'ground',
  'analog-in',
  'other',
]);

export const PinDefSchema = z.object({
  name: z.string().min(1),
  x: z.number(),
  y: z.number(),
  kind: PinKind.default('other'),
});

export const BridgeDefSchema = z.object({
  role: z.enum(BRIDGE_ROLES),
  pin: z.string().min(1),
  activeLevel: z.union([z.literal(0), z.literal(1)]).optional(),
  pull: z.enum(['up', 'down', 'none']).optional(),
});

export const ControlDefSchema = z.object({
  kind: z.enum(['momentary', 'toggle', 'button', 'none']).default('none'),
  label: z.string().optional(),
});

export const PropDefSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  label: z.string().optional(),
  enum: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

/** Definición de un módulo del catálogo (sección 6.2 de la guía). */
/** Tipos de módulo: mismo formato que los nombres de proyecto (se usan como carpeta). */
export const MODULE_TYPE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const ModuleDefSchema = z.object({
  type: z.string().regex(MODULE_TYPE_RE, 'solo [a-z0-9-], hasta 40 caracteres'),
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string().optional(),
  /** Tiene código propio (una placa: ESP32, Arduino...). Los demás módulos solo se cablean. */
  programmable: z.boolean().default(false),
  /**
   * Descriptor de placa (board.ts): chip, motor de emulación, lenguajes, pines del MCU.
   * Lo llevan los módulos programables; es lo que permite sumar placas sin tocar código.
   */
  board: BoardDescriptorSchema.optional(),
  /**
   * Componente pasivo de 2 pines "en línea" (p. ej. una resistencia): no tiene rol
   * en el puente, pero para la lógica digital (qué GPIO enciende qué salida) se
   * salta como si el cable siguiera derecho. Para el cálculo eléctrico (Ley de
   * Ohm) sí cuenta su resistencia real. Requiere exactamente 2 pines.
   */
  passthrough: z.boolean().default(false),
  /** Nombre de la prop que tiene su resistencia en ohms (p. ej. "ohms" en la resistencia), para el cálculo eléctrico. */
  ohmsProp: z.string().optional(),
  /**
   * Se comporta como un diodo (cae una tensión fija al conducir, en vez de ser
   * lineal como una resistencia): es el caso del LED. El valor real sale de
   * `vars.vf` si existe (depende de una prop, p. ej. el color); si no, de
   * `diodeVfDefault`, o 2 V por defecto.
   */
  diode: z.boolean().default(false),
  diodeVfDefault: z.number().default(2),
  /**
   * Interruptor mecánico de 2 pines (pulsador, llave): mientras su control está activo
   * (apretado / encendido) une eléctricamente sus dos pines, como un cable. Así sirve
   * tanto de entrada para el código como para cortar o cerrar un circuito sin código.
   */
  switch: z.boolean().optional(),
  /**
   * Fuente de voltaje regulable (p. ej. una fuente de banco): el pin `power` de este
   * módulo entrega la tensión de `props[source.voltageProp]` en vez de depender de la
   * placa, y puede ser negativa. Su pin `ground` no fija nada por sí solo: tiene que
   * cablearse a `board.GND` (u otro punto ya unido a él) para que el motor eléctrico
   * encuentre el camino de vuelta.
   */
  source: z
    .object({
      voltageProp: z.string().min(1),
      /**
       * Prop con el límite de corriente (mA), como en una fuente de laboratorio: si la carga
       * pide más, la fuente pasa a modo CC (entrega el límite y baja el voltaje). Sin esta
       * prop se usa `electrical.maxCurrentMa`.
       */
      currentProp: z.string().min(1).optional(),
    })
    .optional(),
  /**
   * Datos eléctricos del componente, de su hoja de datos (los usa el motor eléctrico, sim/analisis.ts).
   * Para un LED: resistencia serie interna (dinámica) y corrientes límite; la caída
   * directa (Vf) sigue en `vars.vf` porque depende del color. Para una fuente
   * (`source`): `maxCurrentMa` es el límite de corriente del canal.
   */
  electrical: z
    .object({
      /** Resistencia serie interna (Ω). */
      seriesOhm: z.number().nonnegative().optional(),
      /** Corriente continua recomendada (mA): por encima, "sobreexigido" (brilla de más, dura menos). */
      maxCurrentMa: z.number().positive().optional(),
      /** Corriente a partir de la cual se daña (mA): por encima, "se quema". */
      burnCurrentMa: z.number().positive().optional(),
    })
    .optional(),

  svg: z.string().min(1),
  width: z.number().default(80),
  height: z.number().default(50),
  pins: z.array(PinDefSchema).default([]),
  bridge: BridgeDefSchema.optional(),
  controls: z.array(ControlDefSchema).default([]),
  props: z.record(z.string(), PropDefSchema).default({}),
  /**
   * Valores para el SVG que dependen de una propiedad: `{{vars.claro}}` en el SVG
   * toma `map[props.color]` (p. ej. el color del LED).
   */
  vars: z
    .record(
      z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
      z.object({ prop: z.string(), map: z.record(z.string(), z.string()), default: z.string() }),
    )
    .default({}),
  /** De dónde vino un módulo importado. Los de fábrica no lo tienen. */
  origin: z
    .object({
      kind: z.enum(['carpeta', 'zip', 'wokwi', 'url', 'github']),
      from: z.string().max(500),
      importedAt: z.string(),
    })
    .optional(),
  /**
   * Punto de entrada al código del módulo: un archivo JS de la carpeta del módulo que exporta
   * `{ circuito(ctx), observar(lectura) }` (ver modelo.ts y docs/motor-electrico.md). Describe
   * el módulo con elementos físicos que resuelve el motor (ngspice). Sin `model`, el motor arma
   * uno a partir de los flags (`passthrough`, `diode`, `switch`, `source`).
   */
  model: z.string().regex(/^[\w.-]+\.js$/, 'un archivo .js de la carpeta del módulo').optional(),
});

export type ModuleDef = z.infer<typeof ModuleDefSchema>;
export type PinDef = z.infer<typeof PinDefSchema>;
export type PropDef = z.infer<typeof PropDefSchema>;
export type ControlDef = z.infer<typeof ControlDefSchema>;
export type BridgeDef = z.infer<typeof BridgeDefSchema>;

// ModuleInstanceSchema / WireSchema viven en diagram.ts (los usa también board.ts).
export { ModuleInstanceSchema, WireSchema, type ModuleInstance, type Wire } from './diagram.js';

/** Un pin del board referenciado desde un cable: "board.GPIO6". */
export function parseBoardRef(ref: string): { moduleId: null; pin: string } | null {
  if (!ref.startsWith('board.')) return null;
  const pin = ref.slice('board.'.length);
  return pin.length > 0 ? { moduleId: null, pin } : null;
}

/** Un pin de un módulo referenciado desde un cable: "btn1.OUT". */
export function parseModuleRef(
  ref: string,
): { moduleId: string; pin: string } | null {
  const dot = ref.indexOf('.');
  if (dot <= 0) return null;
  const moduleId = ref.slice(0, dot);
  const pin = ref.slice(dot + 1);
  if (moduleId.length === 0 || pin.length === 0) return null;
  return { moduleId, pin };
}
