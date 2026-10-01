/**
 * Solver de "circuito libre" (MNA — Modified Nodal Analysis) en DC.
 *
 * A diferencia de `circuitPhysics.ts` (que recorre un único camino fuente → GND), este
 * solver plantea y resuelve la red completa: un nodo por cada unión de pines y una
 * ecuación de Kirchhoff de corrientes (KCL) por nodo. Eso permite topologías
 * arbitrarias — divisores, ramas en paralelo, LEDs en serie, botón → LED sin firmware
 * de por medio — que es el objetivo del SDD de circuito libre.
 *
 * Formulación (ver SDD-CIRCUITO-LIBRE.md §4):
 *  - Incógnitas: el voltaje de cada nodo que no sea el de referencia (`kind: 'ground'`,
 *    que vale 0 V por definición y se elimina de la matriz) más una corriente por cada
 *    fuente de voltaje ideal (`kind: 'voltage_source'`), al estilo MNA aumentado. Esa
 *    corriente extra es lo que permite imponer "V_nodo = V_fuente" sin dividir por cero
 *    y además saber cuánto entrega la fuente.
 *  - Resistencias: conductancia g = 1/R entre sus dos nodos.
 *  - Diodos (LED incluido): modelo lineal por tramos — en conducción equivalen a una
 *    caída fija `vf` en serie con `rs`, y en corte a una fuga despreciable (`G_MIN`).
 *    Como el tramo depende del propio resultado, se itera: se resuelve, se recalcula
 *    qué diodos conducen y se vuelve a resolver hasta que los estados no cambian
 *    (Newton-Raphson sobre un modelo seccionalmente lineal; converge en 2-3 pasadas
 *    para los circuitos de esta app).
 *
 * Fase 1: solo régimen permanente (DC). Sin capacitores/inductores ni modelo térmico.
 */

export type NodeKind = 'ground' | 'voltage_source' | 'passive';

export interface CircuitNode {
  id: string;
  kind: NodeKind;
  /** Voltaje informativo del nodo (lo que se dibuja); el solver lo recalcula. */
  voltage?: number;
  /** `voltage` es obligatorio cuando `kind` es `voltage_source`. */
  params?: { voltage?: number };
}

export interface ResistorBranch {
  id: string;
  kind: 'resistor';
  ohms: number;
  nodes: [string, string];
}

export interface DiodeBranch {
  id: string;
  kind: 'diode';
  /** Ánodo primero, cátodo después: conduce de `nodes[0]` a `nodes[1]`. */
  nodes: [string, string];
  /** Caída directa en conducción (2 V en un LED rojo). Por defecto 0.7 V (diodo de silicio). */
  vf?: number;
  /** Resistencia interna en conducción (15 Ω en un LED de 5 mm). */
  rs?: number;
}

export interface SwitchBranch {
  id: string;
  kind: 'switch';
  nodes: [string, string];
  /** Cerrado (pulsador apretado, llave encendida) une sus dos pines: para la electricidad es un cable. */
  closed: boolean;
  /** Resistencia de contacto en ohms cuando está cerrado. Por defecto, la de un cable. */
  ohms?: number;
}

/**
 * Fuente de tensión entre dos nodos (no necesariamente referida a tierra), como un canal de
 * una fuente de laboratorio: `voltage` de `nodes[0]` (+) a `nodes[1]` (−), detrás de `ohms`, y
 * con `limitA` se comporta CV/CC: si la carga pide más, entrega el límite y la tensión baja.
 */
export interface VoltageSourceBranch {
  id: string;
  kind: 'vsource';
  nodes: [string, string];
  voltage: number;
  /** Resistencia interna (Ω). Ninguna fuente es ideal: por defecto 1 mΩ. */
  ohms?: number;
  /** Límite de corriente (A): por encima pasa a modo CC. */
  limitA?: number;
}

export type CircuitBranch = ResistorBranch | DiodeBranch | SwitchBranch | VoltageSourceBranch;

export interface Circuit {
  nodes: CircuitNode[];
  branches: CircuitBranch[];
}

export interface Solution {
  /** Voltaje de cada nodo, con el de referencia en 0 V. */
  voltages: Record<string, number>;
  /** Corriente de cada rama, positiva de `nodes[0]` a `nodes[1]`. */
  branchCurrents: Record<string, number>;
  /** Potencia neta que cada nodo entrega al circuito: ~0 en los pasivos (KCL), >0 en las fuentes. */
  nodePowers: Record<string, number>;
  /** Corriente que entrega cada fuente de voltaje. */
  sourceCurrents: Record<string, number>;
  /** Pasadas que necesitaron los diodos para estabilizar su estado. */
  iterations: number;
  /** `false` si se agotaron las pasadas sin estabilizar (devuelve la última solución). */
  converged: boolean;
}

/** Fuga de un diodo en corte y camino mínimo a tierra: evita matrices singulares por nodos flotantes. */
const G_MIN = 1e-12;
/** Piso de resistencia: un 0 Ω ideal (un cable, un diodo sin `rs`) descalabra la matriz. */
const OHM_MIN = 1e-6;
/** Resistencia de contacto de un interruptor cerrado: lo que mide un cable corto. */
const OHM_CONTACTO = 0.01;
/** Resistencia interna de una fuente si no se declara. */
const OHM_FUENTE = 1e-3;
/** Tope de pasadas del lazo de estados de los diodos. */
const MAX_ITERACIONES = 100;

/** Matriz densa sobre un buffer plano, para no pelear con `noUncheckedIndexedAccess`. */
class Matriz {
  private readonly datos: Float64Array;

  constructor(readonly n: number) {
    this.datos = new Float64Array(n * n);
  }

  get(fila: number, col: number): number {
    return this.datos[fila * this.n + col] ?? 0;
  }

  set(fila: number, col: number, valor: number): void {
    this.datos[fila * this.n + col] = valor;
  }

  sumar(fila: number, col: number, valor: number): void {
    this.set(fila, col, this.get(fila, col) + valor);
  }
}

export function solveMNA(circuit: Circuit): Solution {
  const referencia = circuit.nodes.find((n) => n.kind === 'ground');
  if (!referencia) throw new Error('Circuito sin nodo ground');

  const incognitas = circuit.nodes.filter((n) => n.kind !== 'ground');
  const filaDeNodo = new Map<string, number>();
  incognitas.forEach((n, i) => filaDeNodo.set(n.id, i));

  const fuentes = circuit.nodes.filter((n) => n.kind === 'voltage_source');
  const filaDeFuente = new Map<string, number>();
  fuentes.forEach((f, i) => filaDeFuente.set(f.id, incognitas.length + i));

  const ramasFuente = circuit.branches.filter((b): b is VoltageSourceBranch => b.kind === 'vsource');
  ramasFuente.forEach((f, i) => filaDeFuente.set(f.id, incognitas.length + fuentes.length + i));
  const tamaño = incognitas.length + fuentes.length + ramasFuente.length;
  const diodos = circuit.branches.filter((b): b is DiodeBranch => b.kind === 'diode');
  // Se arranca con todos los diodos en corte: es el estado seguro (nunca inventa corriente).
  const conduce = new Map<string, boolean>(diodos.map((d) => [d.id, false]));
  // Fuentes en modo CC: el signo de la corriente que entregan (+1 sale por su borne +).
  const enCC = new Map<string, 1 | -1>();

  let voltajes: Record<string, number> = {};
  for (let iteracion = 1; iteracion <= MAX_ITERACIONES; iteracion++) {
    voltajes = resolverPasada(circuit, referencia.id, filaDeNodo, filaDeFuente, tamaño, conduce, enCC);

    let estable = true;
    for (const diodo of diodos) {
      const vd = voltajeDe(voltajes, diodo.nodes[0]) - voltajeDe(voltajes, diodo.nodes[1]);
      const nuevo = vd > vfDe(diodo);
      if (nuevo !== conduce.get(diodo.id)) {
        conduce.set(diodo.id, nuevo);
        estable = false;
      }
    }
    // CV ↔ CC: si en CV entregaría más que su límite, pasa a CC; si en CC su tensión ya llegó a la
    // ajustada (la carga pide menos que el límite), vuelve a CV.
    for (const f of ramasFuente) {
      if (f.limitA === undefined) continue;
      const signo = enCC.get(f.id);
      const v = voltajeDe(voltajes, f.nodes[0]) - voltajeDe(voltajes, f.nodes[1]);
      if (signo === undefined) {
        const entrega = -(voltajes[`${CORRIENTE_PREFIJO}${f.id}`] ?? 0);
        if (Math.abs(entrega) > f.limitA) {
          enCC.set(f.id, entrega > 0 ? 1 : -1);
          estable = false;
        }
      } else if (signo * v >= signo * f.voltage) {
        enCC.delete(f.id);
        estable = false;
      }
    }

    if (estable) return armarSolucion(circuit, voltajes, conduce, iteracion, true);
  }

  return armarSolucion(circuit, voltajes, conduce, MAX_ITERACIONES, false);
}

/** Arma y resuelve el sistema con los estados de diodo dados. Devuelve voltajes y corrientes de fuente. */
function resolverPasada(
  circuit: Circuit,
  idReferencia: string,
  filaDeNodo: Map<string, number>,
  filaDeFuente: Map<string, number>,
  tamaño: number,
  conduce: Map<string, boolean>,
  enCC: Map<string, 1 | -1> = new Map(),
): Record<string, number> {
  const A = new Matriz(tamaño);
  const z = new Float64Array(tamaño);

  /** Fila del nodo, o -1 si es el de referencia (su columna no existe: V = 0). */
  const fila = (id: string): number => {
    const f = filaDeNodo.get(id);
    if (f !== undefined) return f;
    if (id === idReferencia) return -1;
    throw new Error(`El circuito no tiene el nodo "${id}" que referencia una rama`);
  };

  // Camino mínimo a tierra en cada nodo: un nodo suelto queda definido en 0 V en vez de singular.
  for (const f of filaDeNodo.values()) A.sumar(f, f, G_MIN);

  for (const rama of circuit.branches) {
    const a = fila(rama.nodes[0]);
    const b = fila(rama.nodes[1]);

    if (rama.kind === 'resistor') {
      sumarConductancia(A, a, b, 1 / Math.max(rama.ohms, OHM_MIN));
      continue;
    }

    if (rama.kind === 'vsource') {
      const extra = filaDeFuente.get(rama.id);
      if (extra === undefined) continue;
      const signo = enCC.get(rama.id);
      if (signo !== undefined && rama.limitA !== undefined) {
        // Modo CC: una fuente de corriente con el límite (sale por + y vuelve por −). Su incógnita
        // queda fijada a esa corriente para poder informarla.
        const i = signo * rama.limitA;
        if (a >= 0) z[a] = (z[a] ?? 0) + i;
        if (b >= 0) z[b] = (z[b] ?? 0) - i;
        A.sumar(extra, extra, 1);
        z[extra] = -i;
        continue;
      }
      // Modo CV (MNA): j = corriente que entra por el borne +; V+ − V− − R·j = V.
      if (a >= 0) { A.sumar(a, extra, 1); A.sumar(extra, a, 1); }
      if (b >= 0) { A.sumar(b, extra, -1); A.sumar(extra, b, -1); }
      A.sumar(extra, extra, -(rama.ohms ?? OHM_FUENTE));
      z[extra] = rama.voltage;
      continue;
    }

    if (rama.kind === 'switch') {
      // Abierto no es infinito: es una fuga despreciable, y así el nodo del medio no queda flotando.
      sumarConductancia(A, a, b, rama.closed ? 1 / Math.max(rama.ohms ?? OHM_CONTACTO, OHM_MIN) : G_MIN);
      continue;
    }

    const rs = Math.max(rama.rs ?? 0, OHM_MIN);
    if (!conduce.get(rama.id)) {
      sumarConductancia(A, a, b, G_MIN);
      continue;
    }
    // En conducción: I = (Va − Vb − vf)/rs. La parte (Va − Vb)/rs es una conductancia y
    // la constante vf/rs pasa al lado derecho (equivalente Norton del diodo).
    const g = 1 / rs;
    sumarConductancia(A, a, b, g);
    const iNorton = vfDe(rama) * g;
    if (a >= 0) z[a] = (z[a] ?? 0) + iNorton;
    if (b >= 0) z[b] = (z[b] ?? 0) - iNorton;
  }

  // Fuentes ideales: V_nodo = V_fuente, con su corriente como incógnita extra.
  for (const fuente of circuit.nodes) {
    if (fuente.kind !== 'voltage_source') continue;
    const filaNodo = filaDeNodo.get(fuente.id);
    const filaExtra = filaDeFuente.get(fuente.id);
    if (filaNodo === undefined || filaExtra === undefined) continue;
    // La corriente de la fuente entra al nodo: en la KCL del nodo resta.
    A.sumar(filaNodo, filaExtra, -1);
    A.sumar(filaExtra, filaNodo, 1);
    z[filaExtra] = fuente.params?.voltage ?? fuente.voltage ?? 0;
  }

  const x = resolverSistema(A, z);

  const voltajes: Record<string, number> = { [idReferencia]: 0 };
  for (const [id, f] of filaDeNodo) voltajes[id] = x[f] ?? 0;
  for (const [id, f] of filaDeFuente) voltajes[`${CORRIENTE_PREFIJO}${id}`] = x[f] ?? 0;
  return voltajes;
}

/** Las corrientes de fuente viajan en el mismo mapa que los voltajes, con prefijo para no chocar. */
const CORRIENTE_PREFIJO = '\u0000i:';

function sumarConductancia(A: Matriz, a: number, b: number, g: number): void {
  if (a >= 0) A.sumar(a, a, g);
  if (b >= 0) A.sumar(b, b, g);
  if (a >= 0 && b >= 0) {
    A.sumar(a, b, -g);
    A.sumar(b, a, -g);
  }
}

function vfDe(diodo: DiodeBranch): number {
  return diodo.vf ?? 0.7;
}

function voltajeDe(voltajes: Record<string, number>, id: string): number {
  return voltajes[id] ?? 0;
}

function armarSolucion(
  circuit: Circuit,
  voltajes: Record<string, number>,
  conduce: Map<string, boolean>,
  iterations: number,
  converged: boolean,
): Solution {
  const voltages: Record<string, number> = {};
  const sourceCurrents: Record<string, number> = {};
  for (const [clave, valor] of Object.entries(voltajes)) {
    if (clave.startsWith(CORRIENTE_PREFIJO)) sourceCurrents[clave.slice(CORRIENTE_PREFIJO.length)] = valor;
    else voltages[clave] = valor;
  }

  const branchCurrents: Record<string, number> = {};
  for (const rama of circuit.branches) {
    if (rama.kind === 'vsource') {
      // Por la rama, de nodes[0] a nodes[1]: la que entra por su borne +. Lo que entrega es lo opuesto.
      const j = sourceCurrents[rama.id] ?? 0;
      branchCurrents[rama.id] = j;
      sourceCurrents[rama.id] = -j;
      continue;
    }
    branchCurrents[rama.id] = corrienteDeRama(rama, voltages, conduce);
  }

  const nodePowers: Record<string, number> = {};
  for (const nodo of circuit.nodes) {
    if (nodo.kind === 'ground') continue;
    let saliente = 0;
    for (const rama of circuit.branches) {
      const i = branchCurrents[rama.id] ?? 0;
      if (rama.nodes[0] === nodo.id) saliente += i;
      if (rama.nodes[1] === nodo.id) saliente -= i;
    }
    nodePowers[nodo.id] = (voltages[nodo.id] ?? 0) * saliente;
  }

  return { voltages, branchCurrents, nodePowers, sourceCurrents, iterations, converged };
}

function corrienteDeRama(
  rama: CircuitBranch,
  voltages: Record<string, number>,
  conduce: Map<string, boolean>,
): number {
  const v = voltajeDe(voltages, rama.nodes[0]) - voltajeDe(voltages, rama.nodes[1]);
  if (rama.kind === 'resistor') return v / Math.max(rama.ohms, OHM_MIN);
  if (rama.kind === 'vsource') return 0; // se informa desde su incógnita (armarSolucion)
  if (rama.kind === 'switch') {
    return rama.closed ? v / Math.max(rama.ohms ?? OHM_CONTACTO, OHM_MIN) : v * G_MIN;
  }
  if (!conduce.get(rama.id)) return v * G_MIN;
  return (v - vfDe(rama)) / Math.max(rama.rs ?? 0, OHM_MIN);
}

/** Gauss-Jordan con pivoteo parcial. Lanza si el sistema es singular (circuito mal planteado). */
function resolverSistema(A: Matriz, z: Float64Array): Float64Array {
  const n = A.n;
  const M = new Matriz(n);
  const b = Float64Array.from(z);
  for (let f = 0; f < n; f++) for (let c = 0; c < n; c++) M.set(f, c, A.get(f, c));

  for (let col = 0; col < n; col++) {
    let pivote = col;
    for (let f = col; f < n; f++) {
      if (Math.abs(M.get(f, col)) > Math.abs(M.get(pivote, col))) pivote = f;
    }
    if (Math.abs(M.get(pivote, col)) < 1e-18) {
      throw new Error('Circuito singular: hay nodos o fuentes que no definen una solución única');
    }
    if (pivote !== col) {
      for (let c = 0; c < n; c++) {
        const tmp = M.get(col, c);
        M.set(col, c, M.get(pivote, c));
        M.set(pivote, c, tmp);
      }
      const tmp = b[col] ?? 0;
      b[col] = b[pivote] ?? 0;
      b[pivote] = tmp;
    }

    const valorPivote = M.get(col, col);
    for (let c = col; c < n; c++) M.set(col, c, M.get(col, c) / valorPivote);
    b[col] = (b[col] ?? 0) / valorPivote;

    for (let f = 0; f < n; f++) {
      if (f === col) continue;
      const factor = M.get(f, col);
      if (factor === 0) continue;
      for (let c = col; c < n; c++) M.set(f, c, M.get(f, c) - factor * M.get(col, c));
      b[f] = (b[f] ?? 0) - factor * (b[col] ?? 0);
    }
  }

  return b;
}
