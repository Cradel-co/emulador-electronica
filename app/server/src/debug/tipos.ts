/**
 * Tipos del modo debug, calcados de los conceptos del Debug Adapter Protocol (DAP) —
 * el que usan VS Code y, con otro nombre, Android Studio: hilos, pila de llamadas,
 * ámbitos, variables (con `variablesReference` para expandir), evaluate, breakpoints,
 * pause/continue/next/stepIn/stepOut. No se implementa el protocolo DAP por cable
 * (todavía): la UI y el MCP usan la API REST de /api/debug con estas mismas formas,
 * así mañana se puede envolver en DAP de verdad sin cambiar los adaptadores.
 *
 * Los nombres de campos van en inglés (los de DAP) para que la UI los mapee 1:1.
 */

export type MotorDepuracion = 'micropython' | 'avr8js' | 'esp-gdb' | 'ninguno';

export interface Capacidades {
  motor: MotorDepuracion;
  /** Leer variables del firmware (globales, estado del intérprete...). */
  variables: boolean;
  evaluate: boolean;
  pause: boolean;
  /** Breakpoints por archivo:línea. */
  lineBreakpoints: boolean;
  /** Breakpoints por nombre de función. */
  functionBreakpoints: boolean;
  step: boolean;
  stackTrace: 'exacto' | 'aproximado' | 'no';
  registros: boolean;
  memoria: boolean;
  /** Lo que no se puede o es aproximado, dicho claro (para la UI y el agente). */
  notas: string[];
}

export interface Thread {
  id: number;
  name: string;
}

export interface Source {
  name: string;
  path: string;
}

export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number;
  column: number;
  /** Dirección de la instrucción (hex). */
  instructionPointerReference?: string;
  /** true si el marco sale de una heurística (escaneo de pila) y puede ser falso. */
  aproximado?: boolean;
}

export interface Scope {
  name: string;
  /** 'globals' | 'locals' | 'registers' (presentationHint de DAP) o una categoría propia. */
  presentationHint?: string;
  variablesReference: number;
  expensive: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  /** > 0 si tiene hijos: se piden con variables(variablesReference). */
  variablesReference: number;
  /** Cantidad de hijos (arreglos/structs), si se sabe. */
  indexedVariables?: number;
  /** Expresión para evaluate que devuelve este mismo valor. */
  evaluateName?: string;
  /** Dirección en memoria (hex), si tiene. */
  memoryReference?: string;
}

export interface ResultadoEvaluacion {
  result: string;
  type?: string;
  variablesReference: number;
  memoryReference?: string;
}

export interface Breakpoint {
  id: number;
  verified: boolean;
  /** Pedido original: por línea (source + line) o por función. */
  source?: Source;
  line?: number;
  function?: string;
  /** Direcciones reales donde quedó puesto (hex). */
  instructionReference?: string[];
  message?: string;
}

/** Pedido de breakpoints, como setBreakpoints / setFunctionBreakpoints de DAP. */
export interface PedidoBreakpoints {
  /** Archivo (se compara por sufijo: "sketch.cpp", "main/main.c"). Reemplaza los de ese archivo. */
  source?: string;
  lines?: number[];
  /** Reemplaza todos los breakpoints por función. */
  functions?: string[];
}

export type RazonParada = 'pause' | 'breakpoint' | 'step' | 'exception' | 'entry';

export interface EstadoEjecucion {
  /** running: corre; stopped: frenado por el depurador; unavailable: no hay nada que depurar. */
  status: 'running' | 'stopped' | 'unavailable';
  reason?: RazonParada;
  threadId?: number;
  description?: string;
  /** Dónde frenó (si se sabe). */
  pc?: string;
  source?: Source;
  line?: number;
  function?: string;
  hitBreakpointIds?: number[];
}

export type AccionControl = 'pause' | 'continue' | 'next' | 'stepIn' | 'stepOut';

/**
 * Lo que implementa cada motor (MicroPython por el puente, AVR sobre avr8js, ESP32 por
 * el stub GDB de esp-emu). El Depurador (depurador.ts) elige uno por corrida.
 */
export interface AdaptadorDepuracion {
  readonly capacidades: Capacidades;
  estado(): EstadoEjecucion;
  threads(): Promise<Thread[]>;
  stackTrace(threadId?: number): Promise<StackFrame[]>;
  scopes(frameId?: number): Promise<Scope[]>;
  variables(ref: number, start?: number, count?: number): Promise<Variable[]>;
  evaluate(expresion: string, frameId?: number): Promise<ResultadoEvaluacion>;
  /** Instala todos los breakpoints (los de línea agrupados por archivo, y los de función). */
  setBreakpoints(lineas: Map<string, number[]>, funciones: string[]): Promise<Breakpoint[]>;
  control(accion: AccionControl): Promise<EstadoEjecucion>;
  /** Variables del programa, resumidas, para la instantánea (frena lo mínimo posible). */
  resumen(): Promise<unknown>;
  /** Memoria cruda (hex), si el motor puede. */
  leerMemoria?(dir: number, largo: number): Promise<Uint8Array>;
  cerrar(): void;
}

/** Eventos que un adaptador avisa solo (el Depurador los reenvía por WebSocket). */
export interface EventosAdaptador {
  detenido: (e: EstadoEjecucion) => void;
  continuado: () => void;
  aviso: (mensaje: string) => void;
}

/** Error "esto no se puede con este motor": vuelve como 400 con el motivo, no como 500. */
export class NoSoportado extends Error {
  readonly statusCode = 400;
}

/** Registro de `variablesReference`: número → función perezosa que trae los hijos. */
export class Referencias {
  private siguiente = 1;
  private readonly mapa = new Map<number, (start?: number, count?: number) => Promise<Variable[]>>();

  constructor(private readonly maximo = 20_000) {}

  crear(fn: (start?: number, count?: number) => Promise<Variable[]>): number {
    const id = this.siguiente++;
    this.mapa.set(id, fn);
    // Tope de memoria: se olvidan las más viejas (la UI vuelve a pedir los ámbitos).
    if (this.mapa.size > this.maximo) {
      const primera = this.mapa.keys().next().value;
      if (primera !== undefined) this.mapa.delete(primera);
    }
    return id;
  }

  async hijos(ref: number, start?: number, count?: number): Promise<Variable[]> {
    const fn = this.mapa.get(ref);
    if (!fn) throw new NoSoportado(`variablesReference ${ref} ya no existe (volvé a pedir los ámbitos)`);
    return fn(start, count);
  }

  limpiar(): void {
    this.mapa.clear();
  }
}

export const hex = (n: number, digitos = 8): string => `0x${(n >>> 0).toString(16).padStart(digitos, '0')}`;
