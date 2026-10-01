import type { ModuleDef, Project } from '@emu/shared';
import { construirRed } from './circuitNetwork.js';
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
