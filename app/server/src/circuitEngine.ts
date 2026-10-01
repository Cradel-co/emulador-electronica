import type { ModuleDef, Project } from '@emu/shared';
import { construirRed } from './circuitNetwork.js';
import { descriptorDe, gpioDeRef } from './diagramOps.js';
import { solveMNA } from './solver.js';
import type { EstadoLed, LedElectrico } from './sim/tipos.js';

/**
 * Puente entre el motor eléctrico nuevo (circuitNetwork + solver) y lo que la app ya
 * consume de `circuitPhysics.ts`, para poder cambiarlo sin tocar la UI.
 *
 * Se activa con `EMU_FREE_CIRCUIT=1`. Apagado (por defecto) no cambia nada: responde
 * el motor de siempre. Ver SDD-CIRCUITO-LIBRE.md §9.
 */

/** ¿Resuelve la red completa (MNA) en vez de recorrer caminos desde una fuente conocida? */
export const circuitoLibre = (): boolean => process.env['EMU_FREE_CIRCUIT'] === '1';

/** Umbrales de un LED de 5 mm si su module.json no los trae. */
const LED_RECOMENDADO_MA = 20;
const LED_QUEMA_MA = 60;

/**
 * Corriente real de cada LED del circuito, resuelta por el solver.
 *
 * A diferencia del motor viejo, acá no hay "corriente fija" contra "corriente del
 * firmware": hay una sola corriente, la que da Kirchhoff con los pines en el estado en
 * que están. Se devuelve en los dos campos porque `mAFijo` es el que mira el canvas
 * para prender el LED (web/app.ts), y con este motor un LED prendido por un GPIO y uno
 * prendido por una fuente son el mismo fenómeno.
 */
export function ledsDelSolver(
  project: Project,
  buscar: (type: string) => ModuleDef | undefined,
  nivelesGpio: ReadonlyMap<number, 0 | 1>,
  cerrados: ReadonlySet<string>,
): LedElectrico[] {
  const { circuit } = construirRed(project, buscar, { nivelesGpio, cerrados });
  const solucion = solveMNA(circuit);

  const leds: LedElectrico[] = [];
  for (const inst of project.modules) {
    const def = buscar(inst.type);
    if (!def?.diode) continue;
    // El signo depende de cómo se dibujó el cable; lo que importa es cuánta corriente pasa.
    const mA = Math.abs(solucion.branchCurrents[inst.id] ?? 0) * 1000;
    leds.push({ id: inst.id, mA, mAFijo: mA, estado: estadoDe(mA, def) });
  }
  return leds;
}

function estadoDe(mA: number, def: ModuleDef): EstadoLed {
  if (mA >= (def.electrical?.burnCurrentMa ?? LED_QUEMA_MA)) return 'se-quema';
  if (mA > (def.electrical?.maxCurrentMa ?? LED_RECOMENDADO_MA)) return 'sobreexigido';
  return 'ok';
}

/**
 * Nivel lógico que lee cada GPIO que el firmware usa como **entrada**, a partir del
 * voltaje que el solver calcula en el nodo donde está cableado.
 *
 * Es la diferencia entre "simular el módulo" y "simular el circuito": hoy el nivel de
 * una entrada sale de `bridge.activeLevel` del módulo conectado, así que un pin solo
 * puede leer lo que su módulo declara. Acá lee lo que hay en el cable, que es lo que
 * hace un microcontrolador: así un mismo interruptor puede cortar la corriente de una
 * carga **y** ser sensado por otro pin desde el nodo del medio.
 *
 * No hace falta un pull interno cuando el nodo tiene camino a masa (una carga, por
 * ejemplo): la propia carga lo define. Un nodo verdaderamente flotante queda en 0 V por
 * las fugas del solver, que es la lectura más conservadora.
 */
export function nivelesDeEntrada(
  project: Project,
  buscar: (type: string) => ModuleDef | undefined,
  nivelesGpio: ReadonlyMap<number, 0 | 1>,
  cerrados: ReadonlySet<string>,
): Map<number, 0 | 1> {
  const { circuit, nodoDe } = construirRed(project, buscar, { nivelesGpio, cerrados });
  const solucion = solveMNA(circuit);
  const desc = descriptorDe(project, buscar);
  // Umbral lógico: la mitad de la tensión de la placa. Las hojas de datos dan VIH/VIL
  // más finos (0,75·VDD y 0,25·VDD en el ESP32), pero para decidir 0 o 1 alcanza y evita
  // una franja indefinida en la que el emulador tendría que inventar algo.
  const umbral = (desc?.logicVoltage ?? 3.3) / 2;

  const placa = project.modules.find((m) => m.id === 'board' || buscar(m.type)?.programmable);
  const defPlaca = placa && buscar(placa.type);
  const niveles = new Map<number, 0 | 1>();
  for (const p of defPlaca?.pins ?? []) {
    const ref = `${placa!.id}.${p.name}`;
    const gpio = gpioDeRef(ref, desc);
    // Un pin que el firmware maneja como salida no "lee" nada: lo impone él.
    if (gpio === null || nivelesGpio.has(gpio)) continue;
    const idNodo = nodoDe.get(ref);
    if (idNodo === undefined) continue;
    const v = solucion.voltages[idNodo];
    if (v === undefined) continue;
    niveles.set(gpio, v > umbral ? 1 : 0);
  }
  return niveles;
}
