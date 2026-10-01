import type { BoardDescriptor, ModuleDef, Project } from '@emu/shared';
import { gpioDe, partirRef, pinesSinAlimentar } from '../diagramOps.js';
import type { BuscarDef } from '../sim/analisis.js';
import { cargarChips, type ChipCatalogo } from './catalogoChips.js';

/**
 * Qué chips del dibujo quedan en un bus del micro: un módulo con `chip` cuyo SDA y SCL están
 * cableados a los pines de un bus I2C que el motor emula (`board.buses.i2c`). Lo que no cierra
 * (un cable que falta, una placa sin I2C emulado, un chip que no existe) se avisa con el motivo.
 */

/** Lo que el worker necesita para armar cada chip (todo serializable). */
export interface ChipEnBus {
  /** Id de la instancia en el dibujo. */
  id: string;
  chip: string;
  nombre: string;
  codigo: string;
  props: Record<string, unknown>;
  entorno: Record<string, number>;
  alimentado: boolean;
  maxHz?: number;
}

export interface ResultadoChips {
  chips: ChipEnBus[];
  avisos: string[];
}

/** Entorno de una instancia: los `default` del chip, pisados por lo que movió el usuario (dentro del rango). */
export function entornoDe(chip: ChipCatalogo, guardado: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, m] of Object.entries(chip.entorno)) {
    const v = guardado[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? Math.min(m.max, Math.max(m.min, v)) : m.default;
  }
  return out;
}

/**
 * `encendido`: lo que dice el motor eléctrico de cada módulo (`ui.on` de su modelo: la tensión de
 * su VDD está en rango). Es lo fiel: un sensor con VIN cableado a 0 V no anda. Sin análisis se usa
 * un respaldo por cables: GND conectado y alguna alimentación conectada.
 */
export function chipsDelProyecto(
  project: Project, buscar: BuscarDef, desc: BoardDescriptor | undefined, catalogo: ChipCatalogo[] = cargarChips(),
  encendido?: (id: string) => boolean | undefined,
): ResultadoChips {
  const chips: ChipEnBus[] = [];
  const avisos: string[] = [];
  for (const inst of project.modules) {
    const def: ModuleDef | undefined = buscar(inst.type);
    if (!def?.chip) continue;
    const chip = catalogo.find((c) => c.id === def.chip!.id);
    const quien = `${def.name} (${inst.id})`;
    if (!chip) {
      avisos.push(`${quien}: el chip "${def.chip.id}" no está en chips/: no va a responder.`);
      continue;
    }
    if (!chip.i2c) continue; // por ahora solo hay buses I2C
    // Pin del módulo que va a cada pin de bus del chip.
    const delModulo = (pinChip: string): string | undefined => Object.entries(def.chip!.pines).find(([, c]) => c === pinChip)?.[0];
    const pSda = delModulo(chip.i2c.sda);
    const pScl = delModulo(chip.i2c.scl);
    if (!pSda || !pScl) {
      avisos.push(`${quien}: el módulo no dice qué pin es ${!pSda ? chip.i2c.sda : chip.i2c.scl} del chip.`);
      continue;
    }
    const gSda = gpioDe(project, inst.id, pSda, buscar);
    const gScl = gpioDe(project, inst.id, pScl, buscar);
    if (gSda === null && gScl === null) continue; // sin cablear: no es un error, todavía no está conectado
    const bus = desc?.buses?.i2c.find((b) => b.sda === gSda && b.scl === gScl);
    if (!bus) {
      const cruzado = desc?.buses?.i2c.some((b) => b.sda === gScl && b.scl === gSda);
      avisos.push(
        !desc?.buses?.i2c.length
          ? `${quien}: esta placa no emula el bus I2C hacia los módulos; el chip no va a responder.`
          : cruzado
            ? `${quien}: SDA y SCL están cruzados: el chip no va a responder (como en la placa real).`
            : `${quien}: ${pSda} y ${pScl} tienen que ir a los pines SDA y SCL del bus I2C de la placa.`,
      );
      continue;
    }
    // Props que salen del cableado (SDO a GND → otra dirección), como en la placa real.
    const props: Record<string, unknown> = { ...Object.fromEntries(Object.entries(def.props).map(([k, p]) => [k, p.default])), ...inst.props };
    for (const [prop, regla] of Object.entries(def.chip.porCableado)) {
      const nivel = nivelFijo(project, inst.id, regla.pin, buscar);
      if (nivel === 'tierra') props[prop] = regla.aTierra;
      else if (nivel === 'alimentacion') props[prop] = regla.aAlimentacion;
      else if (nivel === 'gpio') avisos.push(`${quien}: ${regla.pin} va a un pin del micro: su nivel lo decide el programa; se toma "${String(props[prop])}" (el de la placa sin cablear).`);
    }
    const sinCable = pinesSinAlimentar(project, inst.id, def);
    const tierras = def.pins.filter((p) => p.kind === 'ground').map((p) => p.name);
    const alimentaciones = def.pins.filter((p) => p.kind === 'power').map((p) => p.name);
    const porCables = tierras.every((t) => !sinCable.includes(t)) && alimentaciones.some((a) => !sinCable.includes(a));
    const alimentado = encendido?.(inst.id) ?? porCables;
    if (!alimentado) {
      avisos.push(porCables
        ? `${quien}: no le llega la tensión que necesita (ver los avisos eléctricos): no va a responder.`
        : `${quien}: sin alimentación (${sinCable.join(', ')} sin conectar): no va a responder.`);
    }
    chips.push({
      id: inst.id,
      chip: chip.id,
      nombre: quien,
      codigo: chip.codigo,
      props,
      entorno: entornoDe(chip, inst.entorno),
      alimentado,
      maxHz: chip.i2c.maxHz,
    });
  }
  return { chips, avisos };
}

/**
 * A qué está atado un pin de un módulo por los cables: a una tierra, a una alimentación, a un
 * pin del micro, o a nada. Mira el otro extremo de cada cable directo (el tipo de ese pin).
 */
function nivelFijo(project: Project, id: string, pin: string, buscar: BuscarDef): 'tierra' | 'alimentacion' | 'gpio' | null {
  const ref = `${id}.${pin}`;
  let gpio = false;
  for (const w of project.wires) {
    if (w.from !== ref && w.to !== ref) continue;
    const otro = partirRef(w.from === ref ? w.to : w.from);
    const inst = project.modules.find((m) => m.id === otro.id) ?? (otro.id === 'board' ? project.modules.find((m) => buscar(m.type)?.programmable) : undefined);
    const def = inst && buscar(inst.type);
    const kind = def?.pins.find((p) => p.name === otro.pin)?.kind;
    if (kind === 'ground') return 'tierra';
    if (kind === 'power') return 'alimentacion';
    if (def?.programmable) gpio = true;
  }
  return gpio ? 'gpio' : null;
}
