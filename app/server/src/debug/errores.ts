/**
 * Detecta errores en la consola del chip, línea por línea, y los junta en un solo
 * registro legible (para la instantánea de debug y para que un agente de IA no tenga
 * que leer 200 líneas de log):
 *
 *  - MicroPython: `Traceback (most recent call last):` + `File "main.py", line N, in f` + la excepción.
 *  - ESP32: `Guru Meditation Error: Core 0 panic'ed (LoadProhibited)` con el volcado de
 *    registros y el `Backtrace: 0x...:0x... ...` (las direcciones se traducen a
 *    función/archivo:línea con el .elf si se pasa un resolvedor).
 *  - `abort() was called at PC 0x...`, `assert failed: ...`, `***ERROR*** A stack overflow...`,
 *    `Task watchdog got triggered`.
 *  - Errores de log: `E (1234) tag: ...` (ESP-IDF) y `[E][tag:12]: ...` (ESPHome).
 */

export type TipoError = 'traceback' | 'panic' | 'abort' | 'assert' | 'stack-overflow' | 'watchdog' | 'error-log';

export interface MarcoError {
  archivo: string;
  linea: number;
  funcion?: string;
}

export interface DireccionResuelta {
  pc: string;
  funcion?: string;
  archivo?: string;
  linea?: number;
}

export interface ErrorDetectado {
  id: number;
  /** ms desde que arrancó la corrida. */
  t: number;
  tipo: TipoError;
  /** Resumen de una línea: "ZeroDivisionError: divide by zero (main.py:12)". */
  mensaje: string;
  /** Las líneas originales del bloque (recortadas). */
  lineas: string[];
  /** Traceback de Python: del más externo al más interno. */
  marcos?: MarcoError[];
  /** PC donde explotó (panic/abort), resuelto si hay .elf. */
  pc?: DireccionResuelta;
  backtrace?: DireccionResuelta[];
  /** Veces que se repitió seguido (errores de log iguales se agrupan). */
  repeticiones?: number;
}

export type Resolvedor = (pc: number) => Omit<DireccionResuelta, 'pc'> | null;

const MAX_LINEAS_BLOQUE = 60;

const INICIO_PANICO: [RegExp, TipoError][] = [
  [/Guru Meditation Error/, 'panic'],
  [/abort\(\) was called at PC/, 'abort'],
  [/assert failed:/, 'assert'],
  [/\*\*\*ERROR\*\*\* A stack overflow in task/, 'stack-overflow'],
  [/Task watchdog got triggered/, 'watchdog'],
];

/** Líneas que cierran un bloque de pánico (el chip se reinicia). */
const FIN_PANICO = /^(Rebooting\.\.\.|ELF file SHA256|ESP-ROM:|rst:0x|ets [A-Z][a-z]{2} )/;

export class DetectorErrores {
  private siguienteId = 1;
  private bloque: { tipo: TipoError; lineas: string[]; t: number } | null = null;
  private traceback: { lineas: string[]; marcos: MarcoError[]; t: number } | null = null;
  private ultimoLog: ErrorDetectado | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly alDetectar: (e: ErrorDetectado) => void,
    private resolver: Resolvedor | null = null,
    /** Cierra un bloque de pánico si no llegan más líneas en este tiempo. */
    private readonly esperaMs = 800,
  ) {}

  ponerResolvedor(r: Resolvedor | null): void {
    this.resolver = r;
  }

  linea(cruda: string, t: number): void {
    const l = cruda.replace(/\r$/, '');

    // --- Traceback de MicroPython ---
    if (this.traceback) {
      const m = /^\s+File "([^"]+)", line (\d+)(?:, in (\S+))?/.exec(l);
      if (m) {
        this.traceback.lineas.push(l);
        this.traceback.marcos.push({ archivo: m[1]!, linea: Number(m[2]), ...(m[3] ? { funcion: m[3] } : {}) });
        return;
      }
      if (/^\s+\S/.test(l) && this.traceback.lineas.length < MAX_LINEAS_BLOQUE) {
        this.traceback.lineas.push(l); // línea de código citada (CPython la muestra; MicroPython a veces)
        return;
      }
      // Primera línea sin sangría: la excepción.
      const tb = this.traceback;
      this.traceback = null;
      tb.lineas.push(l);
      const interno = tb.marcos[tb.marcos.length - 1];
      this.emitir({
        tipo: 'traceback',
        t: tb.t,
        mensaje: `${l.trim()}${interno ? ` (${interno.archivo}:${interno.linea}${interno.funcion ? `, en ${interno.funcion}` : ''})` : ''}`,
        lineas: tb.lineas,
        marcos: tb.marcos,
      });
      return;
    }
    if (/^Traceback \(most recent call last\):/.test(l.trim())) {
      this.cerrarBloque();
      this.traceback = { lineas: [l], marcos: [], t };
      return;
    }

    // --- Pánicos del ESP32 ---
    const inicio = INICIO_PANICO.find(([re]) => re.test(l));
    if (inicio) {
      // Un abort()/assert suele venir seguido del Guru Meditation: se juntan en el mismo bloque.
      if (!this.bloque) this.bloque = { tipo: inicio[1], lineas: [], t };
      this.bloque.lineas.push(l);
      this.programarCierre();
      return;
    }
    if (this.bloque) {
      if (FIN_PANICO.test(l.trim()) || this.bloque.lineas.length >= MAX_LINEAS_BLOQUE) {
        if (FIN_PANICO.test(l.trim())) this.bloque.lineas.push(l);
        this.cerrarBloque();
        return;
      }
      if (l.trim()) this.bloque.lineas.push(l);
      this.programarCierre();
      return;
    }

    // --- Errores de log ---
    const idf = /^E \((\d+)\) ([^:]+): (.*)$/.exec(l.trim());
    const esphome = /^\[E\]\[([^\]]+)\]:\s*(.*)$/.exec(l.trim());
    if (idf || esphome) {
      const mensaje = idf ? `${idf[2]}: ${idf[3]}` : `${esphome![1]}: ${esphome![2]}`;
      if (this.ultimoLog && this.ultimoLog.mensaje === mensaje) {
        this.ultimoLog.repeticiones = (this.ultimoLog.repeticiones ?? 1) + 1;
        return;
      }
      this.ultimoLog = this.emitir({ tipo: 'error-log', t, mensaje, lineas: [l] });
    }
  }

  private programarCierre(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cerrarBloque(), this.esperaMs);
    this.timer.unref?.();
  }

  /** Termina lo que esté a medio juntar (se llama también al parar el emulador). */
  cerrarBloque(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.traceback) {
      const tb = this.traceback;
      this.traceback = null;
      this.emitir({ tipo: 'traceback', t: tb.t, mensaje: 'Traceback (incompleto)', lineas: tb.lineas, marcos: tb.marcos });
    }
    const b = this.bloque;
    if (!b) return;
    this.bloque = null;
    const texto = b.lineas.join('\n');
    const razon = /panic'ed \(([^)]+)\)/.exec(texto)?.[1];
    const pcTxt = /abort\(\) was called at PC (0x[0-9a-fA-F]+)/.exec(texto)?.[1] ?? /\b(?:PC|MEPC)\s*:\s*(0x[0-9a-fA-F]+)/.exec(texto)?.[1];
    const bt = /Backtrace:((?:\s+0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)+)/.exec(texto)?.[1];
    const backtrace = bt ? [...bt.matchAll(/(0x[0-9a-fA-F]+):0x[0-9a-fA-F]+/g)].map((m) => this.resolverDir(parseInt(m[1]!, 16))) : undefined;
    const pc = pcTxt ? this.resolverDir(parseInt(pcTxt, 16)) : backtrace?.[0];
    const donde = pc?.funcion ? ` en ${pc.funcion}${pc.archivo ? ` (${pc.archivo.split('/').pop()}:${pc.linea})` : ''}` : pc ? ` en ${pc.pc}` : '';
    const primera = b.lineas[0]?.trim() ?? '';
    const mensaje =
      b.tipo === 'panic'
        ? `Guru Meditation: ${razon ?? 'pánico'}${donde}`
        : b.tipo === 'assert'
          ? `${primera}`
          : b.tipo === 'stack-overflow'
            ? primera.replace(/^\*+ERROR\*+\s*/, '')
            : b.tipo === 'watchdog'
              ? `Watchdog de tareas: una tarea no soltó la CPU${donde}`
              : `abort()${donde}`;
    this.emitir({
      tipo: b.tipo,
      t: b.t,
      mensaje,
      lineas: b.lineas,
      ...(pc ? { pc } : {}),
      ...(backtrace ? { backtrace } : {}),
    });
  }

  private resolverDir(pc: number): DireccionResuelta {
    const r = this.resolver?.(pc) ?? null;
    return { pc: `0x${pc.toString(16).padStart(8, '0')}`, ...(r ?? {}) };
  }

  private emitir(e: Omit<ErrorDetectado, 'id'>): ErrorDetectado {
    const completo: ErrorDetectado = { id: this.siguienteId++, ...e, lineas: e.lineas.map((x) => (x.length > 300 ? `${x.slice(0, 300)}…` : x)) };
    if (e.tipo !== 'error-log') this.ultimoLog = null;
    this.alDetectar(completo);
    return completo;
  }
}
