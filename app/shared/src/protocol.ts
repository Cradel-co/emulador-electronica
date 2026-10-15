import { z } from 'zod';
import { CameraStatusSchema } from './camera.js';
import { PROJECT_BOARD_ID_RE } from './project.js';

const BoardEventFields = { boardId: z.string().regex(PROJECT_BOARD_ID_RE).optional(), project: z.string().optional() };

export const BRIDGE_PROTOCOL_VERSION = 1;

const bits = /^[01x]+$/;

/** App → firmware (sección 7.1). */
export const AppMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('HELLO'), version: z.literal(BRIDGE_PROTOCOL_VERSION) }),
  z.object({ type: z.literal('WATCH'), pin: z.number().int().min(0).max(48) }),
  z.object({ type: z.literal('IN'), pin: z.number().int().min(0).max(48), level: z.union([z.literal(0), z.literal(1)]) }),
  z.object({ type: z.literal('RF'), bits: z.string().regex(bits), protocol: z.number().int().min(0) }),
  z.object({ type: z.literal('PING'), n: z.number().int() }),
]);
export type AppMessage = z.infer<typeof AppMessageSchema>;

/** Firmware → app (sección 7.1). */
export const FirmwareMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('READY'),
    version: z.literal(BRIDGE_PROTOCOL_VERSION),
    esphomeVersion: z.string().optional(),
  }),
  z.object({ type: z.literal('OUT'), pin: z.number().int().min(0).max(48), level: z.union([z.literal(0), z.literal(1)]) }),
  z.object({ type: z.literal('TX'), bits: z.string().regex(bits), protocol: z.number().int().min(0) }),
  z.object({ type: z.literal('PONG'), n: z.number().int() }),
  z.object({ type: z.literal('ERR'), code: z.string().min(1), message: z.string() }),
]);
export type FirmwareMessage = z.infer<typeof FirmwareMessageSchema>;

export function encodeAppMessage(msg: AppMessage): string {
  switch (msg.type) {
    case 'HELLO':
      return `@HELLO ${msg.version}\n`;
    case 'WATCH':
      return `@WATCH ${msg.pin}\n`;
    case 'IN':
      return `@IN ${msg.pin} ${msg.level}\n`;
    case 'RF':
      return `@RF ${msg.bits} ${msg.protocol}\n`;
    case 'PING':
      return `@PING ${msg.n}\n`;
  }
}

const MAX_LINE_BYTES = 256;

/**
 * Parser de líneas del protocolo del puente, tolerante a paquetes TCP partidos.
 * Descarta lo que excede MAX_LINE_BYTES para no crecer sin límite.
 */
export class BridgeLineParser {
  private buffer = '';

  push(chunk: string | Uint8Array): FirmwareMessage[] {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    this.buffer += text;
    const out: FirmwareMessage[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const msg = parseFirmwareLine(raw);
      if (msg) out.push(msg);
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
    }
    return out;
  }

  reset(): void {
    this.buffer = '';
  }
}

export function parseFirmwareLine(line: string): FirmwareMessage | null {
  const trimmed = line.replace(/\r$/, '').trim();
  if (!trimmed.startsWith('@')) return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const tag = parts[0];
  const args = parts.slice(1);

  // Mapeo posicional de cada mensaje (el protocolo es texto, no JSON).
  let raw: Record<string, unknown>;
  switch (tag) {
    case 'READY':
      raw = { type: 'READY', version: args[0], esphomeVersion: args[1] };
      break;
    case 'OUT':
      raw = { type: 'OUT', pin: args[0], level: args[1] };
      break;
    case 'TX':
      raw = { type: 'TX', bits: args[0], protocol: args[1] };
      break;
    case 'PONG':
      raw = { type: 'PONG', n: args[0] };
      break;
    case 'ERR':
      raw = { type: 'ERR', code: args[0], message: args.slice(1).join(' ') };
      break;
    default:
      return null;
  }

  const parsed = FirmwareMessageSchema.safeParse(coerce(raw));
  return parsed.success ? parsed.data : null;
}

/** Convierte los campos numéricos de texto a número, dejando el resto igual. */
function coerce(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'type') {
      out[k] = v;
    } else if (k === 'version' || k === 'n' || k === 'pin' || k === 'protocol' || k === 'level') {
      const n = Number(v);
      out[k] = typeof v === 'string' && v !== '' && Number.isInteger(n) ? n : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// WebSocket (sección 10.2)
// ---------------------------------------------------------------------------

export const EmulatorState = z.enum([
  'stopped',
  'starting',
  'booted',
  'wifi',
  'bridge',
  'crashed',
  'hung',
]);
export type EmulatorState = z.infer<typeof EmulatorState>;

const PinLevel = z.union([z.literal(0), z.literal(1)]);

/** Estado completo del emulador que viaja en cada `emu.state`. */
export const EmuStatusSchema = z.object({
  state: EmulatorState,
  running: z.boolean(),
  pid: z.number().int().nullable(),
  project: z.string().nullable(),
  ip: z.string().nullable(),
  startedAt: z.number().nullable(),
  exitInfo: z.string().nullable(),
  ports: z
    .object({
      bridge: z.number().int(),
      control: z.number().int(),
      api: z.number().int(),
      web: z.number().int(),
    })
    .nullable(),
  /** true si el firmware publica una web (web_server en el YAML). */
  usesWeb: z.boolean().optional(),
  usesApi: z.boolean().optional(),
  /** Modo debug: el depurador tiene el programa frenado (breakpoint, pausa, paso). */
  paused: z.boolean().optional(),
});
export type EmuStatus = z.infer<typeof EmuStatusSchema>;

export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('camera.capture.request'), project: z.string(), instance: z.string(), requestId: z.string() }),
  z.object({ type: z.literal('camera.state'), project: z.string(), instance: z.string(), state: CameraStatusSchema }),
  z.object({ type: z.literal('build.log'), ...BoardEventFields, line: z.string() }),
  z.object({
    type: z.literal('build.done'), ...BoardEventFields,
    ok: z.boolean(),
    durationMs: z.number(),
    errors: z
      .array(
        z.object({
          line: z.number().int().optional(),
          file: z.string().optional(),
          message: z.string(),
        }),
      )
      .default([]),
  }),
  z.object({ type: z.literal('emu.state'), ...BoardEventFields, state: EmulatorState, status: EmuStatusSchema }),
  z.object({ type: z.literal('emu.log'), ...BoardEventFields, line: z.string() }),
  z.object({ type: z.literal('emu.exit'), ...BoardEventFields, code: z.number().int().nullable() }),
  z.object({ type: z.literal('pin.out'), ...BoardEventFields, pin: z.number().int(), level: PinLevel }),
  z.object({ type: z.literal('rf.tx'), ...BoardEventFields, bits: z.string(), protocol: z.number().int() }),
  /** Informe del modelo del servidor; entrega al puente no equivale a un ACK por radio. */
  z.object({ type: z.literal('rf.result'), ...BoardEventFields, bits: z.string(), protocol: z.number().int(), entregado: z.boolean(), evaluacion: z.record(z.string(), z.unknown()) }),
  /** El firmware cambió el PWM de un pin: lo que dependa de él (el sonido) hay que recalcularlo. */
  z.object({ type: z.literal('pwm.changed'), ...BoardEventFields }),
  z.object({ type: z.literal('bridge.state'), ...BoardEventFields, connected: z.boolean() }),
  z.object({ type: z.literal('bridge.ready'), ...BoardEventFields, version: z.number().int(), esphomeVersion: z.string().optional() }),
  z.object({ type: z.literal('bridge.pong'), ...BoardEventFields, n: z.number().int() }),
  z.object({ type: z.literal('bridge.error'), ...BoardEventFields, code: z.string(), message: z.string() }),
  z.object({ type: z.literal('build.start'), ...BoardEventFields, project: z.string() }),
  /** Se importó o quitó un módulo: la UI recarga el catálogo. */
  z.object({ type: z.literal('catalog.changed') }),
  /**
   * Cambió el circuito o un archivo de un proyecto (desde otra pestaña o por MCP), o solo su
   * estado eléctrico (`electrico`: un pulsador apretado; hay que recalcular, no recargar).
   * `origin` es el id del cliente que hizo el cambio, para que no se recargue a sí mismo.
   */
  z.object({
    type: z.literal('project.changed'), ...BoardEventFields,
    project: z.string(),
    what: z.enum(['diagram', 'file', 'electrico']),
    file: z.string().optional(),
    origin: z.string().optional(),
  }),
  z.object({
    type: z.literal('build.artifacts'), ...BoardEventFields,
    firmware: z.string(),
    elf: z.string().nullable(),
  }),
  z.object({
    type: z.literal('notice'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
  }),
  z.object({
    type: z.literal('diagnostics'), ...BoardEventFields,
    problems: z.array(z.object({ severity: z.enum(['info', 'warning', 'error']), message: z.string(), line: z.number().int().optional() })),
  }),
  /** Un chip del dibujo publicó algo para mostrar (pantalla, valores): `id` de la instancia. */
  z.object({ type: z.literal('chip.salida'), ...BoardEventFields, project: z.string(), id: z.string(), salida: z.record(z.string(), z.unknown()) }),
  /** Se movió el entorno de un chip (temperatura...): valores ya aplicados. */
  z.object({ type: z.literal('chip.entorno'), ...BoardEventFields, project: z.string(), id: z.string(), entorno: z.record(z.string(), z.number()) }),
  // --- Modo debug (server/src/debug, docs/depuracion.md). Formas de DAP: se dejan pasar los campos. ---
  /** El depurador frenó el programa: reason, description, pc, function, source {name,path}, line, hitBreakpointIds. */
  z.object({ type: z.literal('debug.stopped'), ...BoardEventFields, reason: z.string().optional(), threadId: z.number().int().optional() }).passthrough(),
  z.object({ type: z.literal('debug.continued'), ...BoardEventFields, threadId: z.number().int().optional() }).passthrough(),
  /** Lo nuevo de la grabadora (cada ~250 ms, como mucho 300 eventos). */
  z.object({ type: z.literal('debug.trace'), ...BoardEventFields, eventos: z.array(z.record(z.string(), z.unknown())), ultimoSeq: z.number().int() }),
  /** Se detectó un error en la consola (Traceback, Guru Meditation, abort, assert...). */
  z.object({ type: z.literal('debug.exception'), ...BoardEventFields, error: z.record(z.string(), z.unknown()) }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export const ClientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pin.in'), ...BoardEventFields, pin: z.number().int(), level: PinLevel }),
  z.object({ type: z.literal('pin.watch'), ...BoardEventFields, pin: z.number().int() }),
  z.object({ type: z.literal('rf.send'), ...BoardEventFields, bits: z.string().regex(bits), protocol: z.number().int().min(0), canalRf: z.unknown().optional() }),
  z.object({ type: z.literal('console.input'), ...BoardEventFields, data: z.string().max(4096) }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;
