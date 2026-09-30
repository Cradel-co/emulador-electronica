import { z } from 'zod';
import { LANGUAGES, type Language } from './languages.js';
import { ModuleInstanceSchema, WireSchema } from './diagram.js';

/**
 * Descriptor de placa: el bloque `"board": {...}` del module.json de un módulo
 * programable. Una placa es DATOS, no código: con un chip que ya tiene motor de
 * emulación (engine) y toolchain, sumar una placa nueva (a mano, importada por el
 * importador de módulos o generada por un agente desde un esquemático) es escribir
 * este bloque. El server arma el registro de placas leyendo el catálogo
 * (server/src/boardRegistry.ts). JSON Schema: GET /api/boards/schema.
 *
 * Nombres de pin: las claves de `pins` son los nombres de pin del dibujo (los de
 * `pins[]` del module.json: "GPIO6", "D13"...). `gpio` es el número de pin lógico que
 * viaja en `pin.out` / `pin.in` / `@WATCH` / `@IN` (en el Uno, el número de Arduino:
 * D13 = 13, A0 = 14).
 */

export const PIN_CAPS = ['digital-in', 'digital-out', 'adc', 'dac', 'pwm', 'touch', 'i2c', 'spi', 'uart', 'usb'] as const;
export type PinCap = (typeof PIN_CAPS)[number];

const IdPlugin = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'solo [a-z0-9-]');
const NumeroPin = z.number().int().min(0).max(255);
const ClaveGpio = z.string().regex(/^\d{1,3}$/, 'la clave es el número de pin lógico (gpio), como texto');

export const BoardPinSchema = z.object({
  /** Número de pin lógico (el de pin.out/pin.in). */
  gpio: NumeroPin,
  /** Puerto del MCU (AVR: "B", "C", "D"). Lo usan los motores nativos (avr8js). */
  port: z.string().regex(/^[A-Z]$/).optional(),
  /** Bit dentro del puerto (0-7 en AVR). */
  bit: z.number().int().min(0).max(31).optional(),
  caps: z.array(z.enum(PIN_CAPS)).default(['digital-in', 'digital-out']),
});
export type BoardPin = z.infer<typeof BoardPinSchema>;

/** Motor de emulación (plugin del server, ver server/src/engines/README.md) y sus opciones. */
export const EngineRefSchema = z.object({
  engine: IdPlugin,
  options: z.record(z.string(), z.unknown()).default({}),
});

/** Toolchain de un lenguaje (plugin del server, ver server/src/toolchains/README.md) y sus opciones. */
export const LanguageTargetSchema = z.object({
  toolchain: IdPlugin,
  options: z.record(z.string(), z.unknown()).default({}),
});
export type LanguageTarget = z.infer<typeof LanguageTargetSchema>;

/**
 * Cómo llegan las entradas/salidas del dibujo al firmware:
 * - `bridge-uart`: por el puente de simulación (protocolo @WATCH/@OUT/@IN, sección 7.1)
 *   en una UART del chip. Es el caso de esp-emu, donde no se puede tocar el pad desde afuera.
 * - `native`: el motor lee y escribe los pines del MCU directo (avr8js).
 */
export const BoardIoSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('bridge-uart'), uart: z.number().int().min(0).max(7), tx: NumeroPin, rx: NumeroPin }),
  z.object({ mode: z.literal('native') }),
]);
export type BoardIo = z.infer<typeof BoardIoSchema>;

export const BoardConsoleSchema = z.object({
  uart: z.number().int().min(0).max(7).default(0),
  tx: NumeroPin.optional(),
  rx: NumeroPin.optional(),
  baud: z.number().int().positive().optional(),
});

export const BoardTemplateSchema = z.object({
  /** Archivos del proyecto nuevo (ruta → contenido). "${name}" se reemplaza por el nombre del proyecto. */
  files: z.record(z.string(), z.string()).default({}),
  /** Dibujo inicial (la placa se agrega sola con id "board"). */
  diagram: z.object({ modules: z.array(ModuleInstanceSchema), wires: z.array(WireSchema) }).optional(),
});
export type BoardTemplate = z.infer<typeof BoardTemplateSchema>;

/** Circuito de prueba de la placa: un botón en `input` y un LED en `output` (plantillas y certificación). */
export const BoardDemoSchema = z.object({
  input: z.string().min(1),
  output: z.string().min(1),
  /** Resistencia en serie con el LED (Ω). Sin esto, el LED va directo al pin. */
  resistorOhms: z.number().positive().optional(),
  /** Pin de tierra de la placa para el botón y el LED. */
  ground: z.string().min(1).default('GND'),
});

const porLenguaje = <T extends z.ZodTypeAny>(t: T) =>
  z.object(Object.fromEntries(LANGUAGES.map((l) => [l, t.optional()])) as Record<Language, z.ZodOptional<T>>).strict();

export const BoardDescriptorSchema = z.object({
  /** Id del chip ("esp32s3", "atmega328p"). */
  chip: z.string().min(1).max(40),
  /** Nombre del chip para mostrar ("ESP32-S3"). */
  chipName: z.string().max(60).optional(),
  /** Familia ("esp32", "avr", "rp2040"...): solo informativa. */
  family: z.string().max(40).optional(),
  backend: EngineRefSchema,
  /** Tensión de un pin de salida en alto (V): 3.3 en ESP32, 5 en el Uno. */
  logicVoltage: z.number().positive().max(50),
  /** Corriente máxima absoluta por pin (mA), de la hoja de datos. */
  maxPinCurrentMa: z.number().positive(),
  /** Corriente recomendada por pin (mA). Por defecto, la mitad de la máxima. */
  recommendedPinCurrentMa: z.number().positive().optional(),
  /**
   * Resistencia interna de un pin de salida en alto (Ω), de la curva VOH/IOH de la hoja
   * de datos: es lo que limita la corriente de un LED conectado sin resistencia. Por
   * defecto 33 Ω (ESP32 con drive strength por defecto). Ver circuitPhysics.ts.
   */
  pinOutputOhm: z.number().nonnegative().optional(),
  /** Resistencia de las salidas de alimentación 3V3/5V (regulador, USB) (Ω). Por defecto 0.5 Ω. */
  supplyOutputOhm: z.number().nonnegative().optional(),
  pins: z.record(z.string().min(1), BoardPinSchema),
  /** Pines (gpio) que usa la propia simulación: no se pueden cablear. */
  reservedPins: z.record(ClaveGpio, z.string()).default({}),
  /** Pines (gpio) que conviene evitar (arranque, USB, LED integrado...). */
  warningPins: z.record(ClaveGpio, z.string()).default({}),
  io: BoardIoSchema,
  console: BoardConsoleSchema.default({}),
  /** Extras que la placa simula ("rf433": RF 433 MHz por RMT + --rmt-loopback). */
  features: z.array(z.string().max(40)).default([]),
  languages: porLenguaje(LanguageTargetSchema),
  demo: BoardDemoSchema.optional(),
  templates: porLenguaje(BoardTemplateSchema).default({}),
  /** Límites y detalles que conviene mostrar al elegir la placa. */
  notes: z.array(z.string()).default([]),
});
export type BoardDescriptor = z.infer<typeof BoardDescriptorSchema>;

// --- Consultas sobre un descriptor (puras; `undefined` = proyecto viejo sin descriptor) ---

/** Número de pin lógico de un pin de la placa ("GPIO6" → 6, "D13" → 13), o null si no es de E/S. */
export function gpioDePin(desc: BoardDescriptor | undefined, nombre: string): number | null {
  if (desc) return desc.pins[nombre]?.gpio ?? null;
  const m = /^GPIO(\d{1,2})$/.exec(nombre);
  return m ? Number(m[1]) : null;
}

/** Nombre del pin de la placa para un número lógico (13 → "D13"). El primero que lo tenga. */
export function nombreDePin(desc: BoardDescriptor | undefined, gpio: number): string {
  if (desc) {
    for (const [nombre, p] of Object.entries(desc.pins)) if (p.gpio === gpio) return nombre;
  }
  return `GPIO${gpio}`;
}

/** Pin reservado por la simulación: el motivo, o null. */
export function motivoReservado(desc: BoardDescriptor | undefined, gpio: number): string | null {
  return desc?.reservedPins[String(gpio)] ?? null;
}

export function lenguajesDe(desc: BoardDescriptor): Language[] {
  return LANGUAGES.filter((l) => desc.languages[l] !== undefined);
}

export function corrienteRecomendada(desc: BoardDescriptor): number {
  return desc.recommendedPinCurrentMa ?? desc.maxPinCurrentMa / 2;
}

/**
 * Chequeos del descriptor contra su propio módulo (más allá del esquema): que cada
 * pin exista en `pins[]` del module.json, que los reservados/advertencias y el puente
 * apunten a pines que existen, que el circuito de prueba use pines de E/S libres.
 * Los nombres de motores y toolchains conocidos los pasa el server (son plugins).
 */
export function chequearDescriptor(
  desc: BoardDescriptor,
  pinesDelModulo: string[],
  conocidos?: { engines: string[]; toolchains: string[] },
): string[] {
  const errores: string[] = [];
  const nombres = new Set(pinesDelModulo);
  const gpios = new Set(Object.values(desc.pins).map((p) => p.gpio));
  for (const nombre of Object.keys(desc.pins)) {
    if (!nombres.has(nombre)) errores.push(`board.pins.${nombre}: no hay un pin "${nombre}" en pins[] del módulo`);
  }
  for (const [campo, mapa] of [['reservedPins', desc.reservedPins], ['warningPins', desc.warningPins]] as const) {
    for (const clave of Object.keys(mapa)) {
      if (!gpios.has(Number(clave)) && campo === 'warningPins') {
        errores.push(`board.${campo}.${clave}: ningún pin de board.pins tiene gpio ${clave}`);
      }
    }
  }
  if (desc.io.mode === 'bridge-uart') {
    for (const [lado, g] of [['tx', desc.io.tx], ['rx', desc.io.rx]] as const) {
      if (!(String(g) in desc.reservedPins)) {
        errores.push(`board.io.${lado} (gpio ${g}) lo usa el puente: tiene que estar en board.reservedPins`);
      }
    }
  }
  if (desc.backend.engine === 'avr8js' || desc.io.mode === 'native') {
    for (const [nombre, p] of Object.entries(desc.pins)) {
      if (desc.io.mode === 'native' && (p.port === undefined || p.bit === undefined)) {
        errores.push(`board.pins.${nombre}: con io.mode "native" cada pin necesita port y bit del MCU`);
      }
    }
  }
  if (desc.demo) {
    for (const [lado, pin, cap] of [['input', desc.demo.input, 'digital-in'], ['output', desc.demo.output, 'digital-out']] as const) {
      const p = desc.pins[pin];
      if (!p) errores.push(`board.demo.${lado}: "${pin}" no está en board.pins`);
      else if (!p.caps.includes(cap)) errores.push(`board.demo.${lado}: "${pin}" no tiene la capacidad ${cap}`);
      else if (String(p.gpio) in desc.reservedPins) errores.push(`board.demo.${lado}: "${pin}" está reservado`);
    }
    if (!nombres.has(desc.demo.ground)) errores.push(`board.demo.ground: no hay un pin "${desc.demo.ground}" en pins[] del módulo`);
  }
  if (lenguajesDe(desc).length === 0) errores.push('board.languages: la placa no tiene ningún lenguaje');
  for (const l of Object.keys(desc.templates)) {
    if (!desc.languages[l as Language]) errores.push(`board.templates.${l}: hay plantilla pero el lenguaje no está en board.languages`);
  }
  if (conocidos) {
    if (!conocidos.engines.includes(desc.backend.engine)) {
      errores.push(`board.backend.engine: "${desc.backend.engine}" no es un motor conocido (${conocidos.engines.join(', ')})`);
    }
    for (const l of lenguajesDe(desc)) {
      const t = desc.languages[l]!.toolchain;
      if (!conocidos.toolchains.includes(t)) {
        errores.push(`board.languages.${l}.toolchain: "${t}" no es un toolchain conocido (${conocidos.toolchains.join(', ')})`);
      }
    }
  }
  return errores;
}
