import { Simulation } from 'eecircuit-engine';

/**
 * ngspice (compilado a WebAssembly, paquete eecircuit-engine) como motor eléctrico.
 *
 * - Una sola instancia, y las corridas en fila: el motor no es reentrante.
 * - Tiempo límite por corrida: cuando ngspice no converge, `runSim()` puede no volver nunca.
 *   En ese caso se descarta la instancia y se arranca otra (~0,7 s).
 */

export interface ResultadoSpice {
  /** Valores por nombre de vector en minúsculas: "v(n3)", "i(vam_led1_d)". Análisis .op: un valor. */
  valores: Map<string, number>;
  /** Mensajes de error de ngspice (vacío si salió bien). */
  errores: string[];
}

const TIEMPO_LIMITE_MS = 5000;

let motor: Simulation | null = null;
let arrancando: Promise<Simulation> | null = null;
let cola: Promise<unknown> = Promise.resolve();

async function instancia(): Promise<Simulation> {
  if (motor) return motor;
  if (!arrancando) {
    arrancando = (async () => {
      const s = new Simulation();
      await s.start();
      motor = s;
      arrancando = null;
      return s;
    })();
  }
  return arrancando;
}

/** Arranca ngspice de antemano (al levantar el server), así el primer cálculo no espera. */
export function precalentar(): Promise<void> {
  return instancia().then(() => undefined);
}

export class ErrorSpice extends Error {
  constructor(message: string, readonly errores: string[], readonly netlist: string) {
    super(message);
  }
}

async function correrUna(netlist: string): Promise<ResultadoSpice> {
  const sim = await instancia();
  sim.setNetList(netlist);
  let resultado: Awaited<ReturnType<Simulation['runSim']>>;
  try {
    resultado = await Promise.race([
      sim.runSim(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tiempo límite')), TIEMPO_LIMITE_MS)),
    ]);
  } catch (err) {
    const errores = [...sim.getError()];
    motor = null; // colgado: la próxima corrida arranca otra instancia
    throw new ErrorSpice(`ngspice no resolvió el circuito (${(err as Error).message})`, errores, netlist);
  }
  const errores = [...sim.getError()];
  const valores = new Map<string, number>();
  if (resultado?.dataType === 'real') {
    for (const d of resultado.data) {
      const v = d.values[d.values.length - 1];
      if (typeof v === 'number') valores.set(d.name.toLowerCase(), v);
    }
  }
  if (valores.size === 0) throw new ErrorSpice('ngspice no devolvió resultados', errores, netlist);
  return { valores, errores };
}

/** Corre un netlist (análisis .op) y devuelve todos los vectores. En fila con las demás corridas. */
export function correrSpice(netlist: string): Promise<ResultadoSpice> {
  const r = cola.then(() => correrUna(netlist));
  cola = r.catch(() => undefined);
  return r;
}
