import {
  NoSoportado,
  Referencias,
  type AdaptadorDepuracion,
  type Breakpoint,
  type Capacidades,
  type EstadoEjecucion,
  type ResultadoEvaluacion,
  type Scope,
  type StackFrame,
  type Thread,
  type Variable,
} from './tipos.js';
import type { ErrorDetectado } from './errores.js';

/**
 * Depurador de MicroPython: habla con el puente en Python (simbridge.py, que corre en un
 * hilo propio dentro del ESP32 emulado) por la misma UART1 del puente de pines:
 *
 *   app → @DUMP <id>                → globales de main.py, memoria libre, reloj
 *   app → @EVAL <id> <expr base64>  → evalúa una expresión en las globales de main.py
 *   fw  → @VARS <id> <i>/<n> <trozo>  (JSON en base64, en trozos de 180 caracteres)
 *
 * No hay breakpoints ni paso a paso: el firmware oficial de MicroPython no trae
 * sys.settrace. "Time-limited": si el firmware no contesta en unos segundos (main.py
 * trabado sin soltar el GIL, por ejemplo), el pedido vence y se avisa.
 */

/** Lo mínimo del puente que hace falta (BridgeClient lo cumple). */
export interface CanalPuente {
  enviarLinea(linea: string): boolean;
  escucharLineas(fn: (linea: string) => void): () => void;
}

/** [tipo, repr, largo, expandible] como lo arma _describir() en simbridge.py. */
type Resto = [string, string, number | null, boolean];
/** [nombre, ...Resto]. */
type Descripcion = [string, ...Resto];

export interface VolcadoMicropython {
  vars: Descripcion[];
  truncado?: boolean;
  funcs: [string, string][];
  mem_free: number;
  mem_alloc: number;
  ticks_ms: number;
  entradas: [number, number][];
  vigilados: [number, number][];
  hilo_puente: number;
  plataforma: string;
  version: string;
}

interface Evaluado {
  error?: string;
  tipo?: string;
  repr?: string;
  len?: number | null;
  hijos?: Descripcion[];
}

/** Largo máximo de una expresión (el buffer de la UART del ESP32 es de 256 bytes). */
const MAX_EXPRESION = 120;

/** Junta los trozos `@VARS <id> <i>/<n> <datos>` y devuelve el JSON cuando están todos. */
export class ArmadorRespuestas {
  private readonly partes = new Map<string, { n: number; trozos: Map<number, string> }>();

  /** Devuelve [id, objeto] cuando la respuesta con ese id quedó completa; si no, null. */
  push(linea: string): [string, unknown] | null {
    const m = /^@VARS (\S+) (\d+)\/(\d+) (\S*)\s*$/.exec(linea.trim());
    if (!m) return null;
    const [, id, i, n, datos] = m as unknown as [string, string, string, string, string];
    let p = this.partes.get(id);
    if (!p) {
      p = { n: Number(n), trozos: new Map() };
      this.partes.set(id, p);
    }
    p.trozos.set(Number(i), datos);
    if (p.trozos.size < p.n) return null;
    this.partes.delete(id);
    const b64 = Array.from({ length: p.n }, (_, k) => p!.trozos.get(k + 1) ?? '').join('');
    try {
      return [id, JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))];
    } catch (err) {
      return [id, { error: `respuesta ilegible del firmware: ${(err as Error).message}` }];
    }
  }

  olvidar(id: string): void {
    this.partes.delete(id);
  }
}

export class AdaptadorMicropython implements AdaptadorDepuracion {
  readonly capacidades: Capacidades = {
    motor: 'micropython',
    variables: true,
    evaluate: true,
    pause: false,
    lineBreakpoints: false,
    functionBreakpoints: false,
    step: false,
    stackTrace: 'aproximado',
    registros: false,
    memoria: false,
    notas: [
      'Variables: las globales de main.py (módulo __main__), leídas por el puente dentro del ESP32 sin frenar el programa.',
      'evaluate: expresiones de Python sobre esas globales (solo lectura: no se permite import, exec, open, sleep, reset...). Vence a los 3 s.',
      'Sin breakpoints ni paso a paso: el firmware oficial de MicroPython no trae sys.settrace.',
      'Pila de llamadas: la del último Traceback que imprimió el programa (si hubo uno).',
      'Variables locales de funciones: no (solo globales del módulo principal).',
    ],
  };

  private readonly refs = new Referencias();
  private readonly armador = new ArmadorRespuestas();
  private readonly esperando = new Map<string, (x: unknown) => void>();
  private siguiente = 1;
  private readonly dejarDeEscuchar: () => void;

  constructor(
    private readonly canal: CanalPuente,
    private readonly ultimoError: () => ErrorDetectado | null,
    private readonly puenteListo: () => boolean,
  ) {
    this.dejarDeEscuchar = canal.escucharLineas((linea) => {
      if (!linea.startsWith('@VARS ')) return;
      const r = this.armador.push(linea);
      if (!r) return;
      const fn = this.esperando.get(r[0]);
      this.esperando.delete(r[0]);
      fn?.(r[1]);
    });
  }

  private pedir(tag: 'DUMP' | 'EVAL', arg: string | null, timeoutMs: number): Promise<unknown> {
    if (!this.puenteListo()) {
      return Promise.reject(new NoSoportado('el puente de MicroPython todavía no está listo (¿corrió boot.py? ¿main.py lo trabó?)'));
    }
    const id = String(this.siguiente++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.esperando.delete(id);
        this.armador.olvidar(id);
        reject(new NoSoportado(`el firmware no contestó @${tag} en ${timeoutMs / 1000} s (¿main.py está en un bucle sin sleep que no suelta el intérprete?)`));
      }, timeoutMs);
      this.esperando.set(id, (x) => {
        clearTimeout(timer);
        resolve(x);
      });
      if (!this.canal.enviarLinea(arg === null ? `@${tag} ${id}` : `@${tag} ${id} ${arg}`)) {
        clearTimeout(timer);
        this.esperando.delete(id);
        reject(new NoSoportado('el puente no está conectado'));
      }
    });
  }

  async volcado(): Promise<VolcadoMicropython> {
    const r = (await this.pedir('DUMP', null, 5000)) as VolcadoMicropython & { error?: string };
    if (r.error) throw new NoSoportado(r.error);
    return r;
  }

  private async evaluar(expr: string): Promise<Evaluado> {
    if (expr.length > MAX_EXPRESION) throw new NoSoportado(`expresión demasiado larga (máximo ${MAX_EXPRESION} caracteres)`);
    return (await this.pedir('EVAL', Buffer.from(expr, 'utf8').toString('base64'), 3000)) as Evaluado;
  }

  estado(): EstadoEjecucion {
    return this.puenteListo()
      ? { status: 'running', description: 'MicroPython corriendo (sin pausa: no hay breakpoints en MicroPython)' }
      : { status: 'unavailable', description: 'esperando al puente de MicroPython' };
  }

  async threads(): Promise<Thread[]> {
    return [
      { id: 1, name: 'main.py (hilo principal)' },
      { id: 2, name: 'simbridge (hilo del puente)' },
    ];
  }

  async stackTrace(): Promise<StackFrame[]> {
    const e = this.ultimoError();
    if (!e || e.tipo !== 'traceback') return [];
    // Traceback de Python: el último "File" es el más interno.
    return (e.marcos ?? [])
      .slice()
      .reverse()
      .map((m, i) => ({
        id: i,
        name: `${m.funcion ?? '<module>'} (último error: ${e.mensaje})`,
        source: { name: m.archivo, path: m.archivo },
        line: m.linea,
        column: 0,
        aproximado: true,
      }));
  }

  /** Variable DAP a partir de lo que describió el firmware; si se expande, se evalúa `expr`. */
  private variable(nombre: string, d: Resto, expr: string): Variable {
    const [tipo, repr, largo, expandible] = d;
    return {
      name: nombre,
      value: repr,
      type: largo !== null && largo !== undefined ? `${tipo} [${largo}]` : tipo,
      variablesReference: expandible ? this.refs.crear(() => this.hijos(expr)) : 0,
      evaluateName: expr,
      ...(largo ? { indexedVariables: largo } : {}),
    };
  }

  private async hijos(expr: string): Promise<Variable[]> {
    const r = await this.evaluar(expr);
    if (r.error) throw new NoSoportado(r.error);
    return (r.hijos ?? []).map(([clave, ...resto]) => {
      const sub = clave.startsWith('.') ? `${expr}${clave}` : clave === '*' ? expr : `${expr}[${clave}]`;
      return this.variable(clave, resto, sub);
    });
  }

  async scopes(): Promise<Scope[]> {
    const v = await this.volcado();
    return [
      {
        name: 'Globales de main.py',
        presentationHint: 'globals',
        variablesReference: this.refs.crear(async () => v.vars.map(([n, ...resto]) => this.variable(n, resto, n))),
        expensive: false,
      },
      {
        name: 'Funciones y clases',
        variablesReference: this.refs.crear(async () => v.funcs.map(([n, t]) => ({ name: n, value: t, type: t, variablesReference: 0 }))),
        expensive: false,
      },
      {
        name: 'Intérprete',
        variablesReference: this.refs.crear(async () => this.interprete(v)),
        expensive: false,
      },
    ];
  }

  private interprete(v: VolcadoMicropython): Variable[] {
    const x = (name: string, value: string): Variable => ({ name, value, variablesReference: 0 });
    return [
      x('memoria libre (gc.mem_free)', `${v.mem_free} bytes`),
      x('memoria usada (gc.mem_alloc)', `${v.mem_alloc} bytes`),
      x('utime.ticks_ms()', String(v.ticks_ms)),
      x('entradas que maneja la app (@IN)', JSON.stringify(Object.fromEntries(v.entradas))),
      x('salidas vigiladas (@WATCH)', JSON.stringify(Object.fromEntries(v.vigilados))),
      x('plataforma', `${v.plataforma} · ${v.version}`),
    ];
  }

  async variables(ref: number, start?: number, count?: number): Promise<Variable[]> {
    return this.refs.hijos(ref, start, count);
  }

  async evaluate(expresion: string): Promise<ResultadoEvaluacion> {
    const r = await this.evaluar(expresion);
    if (r.error) throw new NoSoportado(r.error);
    const hijos = r.hijos ?? [];
    return {
      result: r.repr ?? '',
      ...(r.tipo ? { type: r.tipo } : {}),
      variablesReference: hijos.length > 0 ? this.refs.crear(() => this.hijos(expresion)) : 0,
    };
  }

  async setBreakpoints(lineas: Map<string, number[]>, funciones: string[]): Promise<Breakpoint[]> {
    const msg = 'MicroPython no tiene breakpoints (el firmware oficial no trae sys.settrace)';
    let id = 1;
    return [
      ...[...lineas].flatMap(([archivo, ls]) => ls.map((line) => ({ id: id++, verified: false, source: { name: archivo, path: archivo }, line, message: msg }))),
      ...funciones.map((f) => ({ id: id++, verified: false, function: f, message: msg })),
    ];
  }

  async control(): Promise<EstadoEjecucion> {
    throw new NoSoportado('MicroPython no se puede pausar ni avanzar paso a paso desde el depurador (para cortar el programa: Ctrl-C en la consola)');
  }

  async resumen(): Promise<unknown> {
    const v = await this.volcado();
    return {
      globales: Object.fromEntries(v.vars.map(([n, t, r]) => [n, `${r}  (${t})`])),
      ...(v.truncado ? { nota: 'hay más de 60 globales: se muestran las primeras' } : {}),
      funciones: v.funcs.map(([n]) => n),
      interprete: { memLibre: v.mem_free, memUsada: v.mem_alloc, ticksMs: v.ticks_ms, entradas: Object.fromEntries(v.entradas) },
    };
  }

  cerrar(): void {
    this.dejarDeEscuchar();
    for (const fn of this.esperando.values()) fn({ error: 'se cerró el depurador' });
    this.esperando.clear();
  }
}
