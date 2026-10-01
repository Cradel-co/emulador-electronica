/**
 * SDK de modelos de módulo: el "punto de entrada al código" de un módulo (`model` en su
 * module.json). Un modelo es una caja negra de dos funciones:
 *
 *  - `circuito(ctx)`: describe el módulo con ELEMENTOS FÍSICOS (resistencias, diodos,
 *    fuentes, interruptores, capacitores...). El motor eléctrico (ngspice) los resuelve:
 *    las leyes de Kirchhoff, Ohm, la curva de los diodos, la energía, las pone él. Un
 *    módulo nunca fija un voltaje o una corriente "a mano", así que no puede romperlas.
 *  - `observar(lectura)` (opcional): ya resuelto el circuito, lee voltajes y corrientes
 *    reales de sus pines y elementos, y decide su estado visible (prendido, brillo),
 *    sus avisos y su estado interno para la próxima vez.
 *
 * El código corre aislado (sandbox, sin acceso al server, con tiempo límite por llamada):
 * todo lo que entra y sale son datos. Ver docs/motor-electrico.md.
 */

/** Un punto del circuito: un pin del módulo ("pin:IN") o un nodo interno ("int:base"). */
export type Nodo = string;

export interface ModeloDiodo {
  /** Corriente de saturación (A). */
  is: number;
  /** Factor de idealidad. */
  n: number;
  /** Resistencia serie (Ω). */
  rs?: number;
  /** Tensión de ruptura inversa (V) y corriente en la ruptura (A). */
  bv?: number;
  ibv?: number;
}

export interface CtxCircuito {
  /** Props de la instancia, con los defaults del module.json ya aplicados. */
  readonly props: Readonly<Record<string, string | number | boolean>>;
  /** Su control: true si el pulsador está apretado / la llave encendida / está energizado. */
  readonly control: boolean;
  /** Estado interno que dejó `observar` la vez anterior. */
  readonly estado: Readonly<Record<string, unknown>>;
  /** Variables del module.json ya resueltas para esta instancia (`vars`, p. ej. el Vf por color). */
  readonly vars: Readonly<Record<string, string>>;

  /** Nodo de un pin declarado en el module.json. */
  pin(nombre: string): Nodo;
  /** Nodo interno del módulo (no se ve desde afuera). */
  nodo(nombre: string): Nodo;

  resistencia(a: Nodo, b: Nodo, ohms: number, nombre?: string): void;
  /** En el análisis de continua es un circuito abierto; en el transitorio, se carga. */
  capacitor(a: Nodo, b: Nodo, faradios: number, opciones?: { v0?: number }, nombre?: string): void;
  /** En el análisis de continua es un cable; en el transitorio, se opone al cambio de corriente. */
  inductor(a: Nodo, b: Nodo, henrios: number, opciones?: { i0?: number }, nombre?: string): void;
  /** Diodo de ánodo a cátodo, con la ecuación de Shockley (sirve para LEDs, zeners...). */
  diodo(anodo: Nodo, catodo: Nodo, modelo: ModeloDiodo, nombre?: string): void;
  /**
   * Fuente de tensión de `pos` a `neg`. Con `limiteA` se comporta como una fuente de
   * laboratorio (CV/CC): si la carga pide más, entrega el límite y baja la tensión. Con
   * `soloEntrega`, no absorbe corriente (como un regulador o un puerto USB).
   */
  fuenteTension(pos: Nodo, neg: Nodo, voltios: number, opciones?: { rSerie?: number; limiteA?: number; soloEntrega?: boolean }, nombre?: string): void;
  /**
   * Fuente de corriente: hace circular `amperios` por adentro de ella, de `desde` a `hacia`
   * (sale por `hacia` hacia el circuito y vuelve por `desde`).
   */
  fuenteCorriente(desde: Nodo, hacia: Nodo, amperios: number, nombre?: string): void;
  /**
   * Regulador lineal (LDO, 7805, AMS1117...): mantiene `voltios` entre `salida` y `tierra`
   * mientras la entrada alcance (si no, entrega la entrada menos `caida`), hasta `limiteA`.
   * Lo que entrega lo SACA de la entrada y disipa (Vin − Vout)·I: conserva la energía. Solo
   * entrega (no devuelve corriente a su entrada). `iq`: su consumo propio (A).
   * Usá esto y no `fuenteTension` para el regulador de una placa: una fuente de tensión
   * dentro de un módulo crea energía de la nada.
   */
  regulador(
    entrada: Nodo, salida: Nodo, tierra: Nodo,
    opciones: { voltios: number; caida: number; limiteA: number; iq?: number },
    nombre?: string,
  ): void;
  /**
   * Pila o batería (CR2032, LIR2032, 18650...): una fuente de `voltios` con su resistencia interna.
   * Es energía legítima (no da el aviso de fuenteTension). `lectura.i` es positiva cuando la
   * corriente entra por el + y la atraviesa (la está CARGANDO) y negativa cuando entrega: el modelo
   * puede avisar si carga una pila que no es recargable.
   */
  bateria(pos: Nodo, neg: Nodo, voltios: number, opciones?: { rInterna?: number }, nombre?: string): void;
  /** Interruptor mecánico (pulsador, llave, contacto de relé). */
  interruptor(a: Nodo, b: Nodo, cerrado: boolean, opciones?: { ron?: number; roff?: number }, nombre?: string): void;
  /**
   * Interruptor controlado por tensión (transistor de salida, bobina que cierra un contacto):
   * se cierra cuando V(ctrlPos) − V(ctrlNeg) supera `umbral`, con histéresis.
   */
  interruptorControlado(
    a: Nodo, b: Nodo, ctrlPos: Nodo, ctrlNeg: Nodo,
    opciones: { umbral: number; histeresis?: number; ron?: number; roff?: number },
    nombre?: string,
  ): void;
}

/** Lo que el modelo puede leer después de que el motor resolvió el circuito. */
export interface Lectura {
  readonly props: Readonly<Record<string, string | number | boolean>>;
  readonly control: boolean;
  readonly estado: Readonly<Record<string, unknown>>;
  readonly vars: Readonly<Record<string, string>>;
  /** Tensión de un pin respecto de la tierra del circuito (V). */
  v(pin: string): number;
  /** Tensión entre dos pines (V). */
  vEntre(a: string, b: string): number;
  /** Corriente por un elemento propio, en el sentido en que se declaró (A). */
  i(elemento: string): number;
  /** Potencia que disipa un elemento propio (W); negativa si entrega energía. */
  p(elemento: string): number;
}

export interface AvisoModelo {
  severidad: 'peligro' | 'advertencia';
  mensaje: string;
}

export interface Observacion {
  /** Estado visible: `on` prende las partes `data-si="on"` del SVG; `brillo` 0..1. */
  ui?: { on?: boolean; brillo?: number };
  avisos?: AvisoModelo[];
  /** Estado interno que vuelve en el próximo `circuito`/`observar`. */
  estado?: Record<string, unknown>;
}

export interface ModeloModulo {
  circuito(ctx: CtxCircuito): void;
  observar?(lectura: Lectura): Observacion | void;
}

/** Elemento físico ya declarado (lo que el sandbox le devuelve al motor). */
export type Primitiva =
  | { tipo: 'R'; nombre: string; a: Nodo; b: Nodo; ohms: number }
  | { tipo: 'C'; nombre: string; a: Nodo; b: Nodo; faradios: number; v0?: number }
  | { tipo: 'L'; nombre: string; a: Nodo; b: Nodo; henrios: number; i0?: number }
  | { tipo: 'D'; nombre: string; a: Nodo; b: Nodo; modelo: ModeloDiodo }
  | { tipo: 'V'; nombre: string; a: Nodo; b: Nodo; voltios: number; rSerie?: number; limiteA?: number; soloEntrega?: boolean; bateria?: boolean }
  | { tipo: 'I'; nombre: string; a: Nodo; b: Nodo; amperios: number }
  | { tipo: 'S'; nombre: string; a: Nodo; b: Nodo; cerrado: boolean; ron?: number; roff?: number }
  | {
      tipo: 'SV'; nombre: string; a: Nodo; b: Nodo; cp: Nodo; cn: Nodo;
      umbral: number; histeresis?: number; ron?: number; roff?: number;
    }
  /** Regulador lineal: `a` = entrada, `b` = salida, `tierra` = su referencia. */
  | { tipo: 'REG'; nombre: string; a: Nodo; b: Nodo; tierra: Nodo; voltios: number; caida: number; limiteA: number; iq?: number };
