import type { EmulatorState } from '@emu/shared';

const ANSI_RE = /\x1B\[[0-9;?]*[A-Za-z]/g;

/** Quita los colores ANSI: los matches se hacen sobre texto plano. */
export function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, '');
}

const CRASH_PATTERNS = [
  /Guru Meditation/,
  /^abort\(\) was called/,
  /Backtrace:/,
  /assert failed:/,
  /panic\(0x/,
  /rfatal error/,
  /Illegal instruction/,
];

const CRASH_SKIP_PREFIXES = [
  'Backtrace will be printed with the following format when an exception is generated',
  'ELF file SHA256:',
  'Rebooting',
  'The following warning(s) appeared during the previous boot:',
];

export function isCrashLine(rawLine: string): boolean {
  const line = stripAnsi(rawLine).trim();
  if (line.length === 0) return false;
  if (CRASH_SKIP_PREFIXES.some((p) => line.includes(p))) return false;
  return CRASH_PATTERNS.some((p) => p.test(line));
}

/**
 * Estado del emulador a partir de las líneas de UART0 (sección 9.2).
 * Devuelve el nuevo estado o null si la línea no cambia nada.
 */
export function detectState(rawLine: string, current: EmulatorState): EmulatorState | null {
  const line = stripAnsi(rawLine);
  if (isCrashLine(line)) return 'crashed';
  if (/setup\(\) finished successfully!/.test(line)) return 'booted';
  if (/Calling app_main\(\)/.test(line)) return 'booted';
  // IDF: "I (5321) app_main: ..." (el tag app_main marca que ya arrancó la app).
  if (/^[VDIWEC]\s*\(\d+\)\s*app_main:/.test(line)) return 'booted';
  if (/^(MicroPython v|To: exit|>)/.test(line.trim()) || line.includes('>>> ')) return 'booted';
  if (/wifi/i.test(line) && line.includes('Connected')) return 'wifi';
  if (/\bIP(address)?\s*:?\s*\d+\.\d+\.\d+\.\d+/i.test(line)) return 'wifi';
  return null;
}

/** Extrae la IP del dispositivo de una línea de log, si aparece. */
export function extractIp(line: string): string | null {
  const m = stripAnsi(line).match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
  return m ? m[1]! : null;
}

export interface LogLineInfo {
  line: string;
  level: string | null;
  tag: string | null;
}

/**
 * Parsea una línea de log de ESPHome/IDF:
 *   [D] [sim_bridge:123]: mensaje        (ESPHome, con o sin color)
 *   I (1234) sim_bridge: mensaje          (IDF)
 */
export function parseLogLine(rawLine: string): LogLineInfo {
  const line = stripAnsi(rawLine);
  let m = line.match(/^\[([VDIWEC])\]\s*\[([A-Za-z0-9_./-]+):(\d+)\]:\s*(.*)$/);
  if (m) return { line: m[4] ?? '', level: m[1]!, tag: m[2]! };
  m = line.match(/^([VDIWEC])\s*\(\d+\)\s*([A-Za-z0-9_./-]+):\s*(.*)$/);
  if (m) return { line: m[3] ?? '', level: m[1]!, tag: m[2]! };
  return { line, level: null, tag: null };
}

/** Corta líneas que exceden el máximo (protege la memoria y el DOM). */
export const MAX_LINE_LENGTH = 2000;
export function clampLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line;
  return line.slice(0, MAX_LINE_LENGTH) + `… (+${line.length - MAX_LINE_LENGTH} chars)`;
}

export const HANG_TIMEOUT_MS = 60_000;

/**
 * Lleva la cuenta del último renglón recibido para detectar "hung"
 * (sin ninguna línea nueva durante 60 s en starting).
 */
export class HangWatchdog {
  private lastLineAt = Date.now();
  private readonly timeoutMs: number;

  constructor(timeoutMs = HANG_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  feed(_line: string): void {
    this.lastLineAt = Date.now();
  }

  get idleMs(): number {
    return Date.now() - this.lastLineAt;
  }

  /** Devuelve true una sola vez por episodio de cuelgue. */
  shouldHang(state: EmulatorState): boolean {
    return state === 'starting' && this.idleMs > this.timeoutMs;
  }

  reset(): void {
    this.lastLineAt = Date.now();
  }
}

/** Trocea un chunk de stdout del emulador en renglones completos. */
export class LineSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      out.push(line);
    }
    // Sin salto de línea: no se emite nada todavía (el emulador puede estar a
    // mitad de renglón), salvo que se pase del límite.
    if (this.buffer.length > 64 * 1024) {
      out.push(this.buffer);
      this.buffer = '';
    }
    return out;
  }

  flush(): string[] {
    if (this.buffer.length === 0) return [];
    const rest = this.buffer;
    this.buffer = '';
    return [rest.replace(/\r$/, '')];
  }
}
