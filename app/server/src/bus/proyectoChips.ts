import type { BoardDescriptor, ModuleDef, Project, UsoChip } from '@emu/shared';
import { gpioDe, partirRef, pinesSinAlimentar } from '../diagramOps.js';
import type { BuscarDef } from '../sim/analisis.js';
import { cargarChips, type ChipCatalogo } from './catalogoChips.js';

/**
 * Qué chips del dibujo quedan en un bus del micro: los de un módulo (`chips` en su module.json)
 * cuyo SDA y SCL están cableados a los pines de un bus I2C que el motor emula
 * (`board.buses.i2c`). Una placa puede traer varios chips en el mismo bus (la ZS-042: DS3231 +
 * AT24C32). Lo que no cierra (un cable que falta, una placa sin I2C emulado, un chip que no
 * existe) se avisa con el motivo.
 */

/** Lo que el worker necesita para armar cada chip (todo serializable). */
export interface ChipEnBus {
  /** Id del dispositivo en el bus: el de la instancia, o "instancia:chip" si la placa tiene varios. */
  id: string;
  /** Id de la instancia del módulo en el dibujo. */
  instancia: string;
  chip: string;
  nombre: string;
  codigo: string;
  props: Record<string, unknown>;
  entorno: Record<string, number>;
  alimentado: boolean;
  maxHz?: number;
  /** Pines del chip cableados a un pin del micro (para lo que el chip maneja: INT, SQW...). */
  pinesGpio: Record<string, number>;
  /** Pines del chip con pull-up en la placa: soltados, se leen en 1. */
  pullUps: string[];
  /** Puede recibir las escrituras en tanda (chip.json → i2c.diferirEscrituras). */
  diferirEscrituras?: boolean;
  /** Memoria no volátil de la ejecución anterior (la pone el server al arrancar). */
  guardado?: unknown;
  /** Si quedó en el bus SPI: su CS y DC (gpio) y lo que acepta. */
  spi?: { csGpio: number; dcGpio?: number; modos: number[]; lsbPrimero: boolean; soloEscritura: boolean; maxHz?: number };
  /** Pines del micro que el chip lee (gpio → pin del chip): RST... */
  entradas?: Record<number, string>;
}

export interface ResultadoChips {
  chips: ChipEnBus[];
  avisos: string[];
}

/** Entorno de una instancia para un chip: los `default` del chip, pisados por lo que movió el usuario (dentro del rango). */
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
    if (!def?.chips.length) continue;
    const quien = `${def.name} (${inst.id})`;
    // Alimentación y props valen para toda la placa (todos sus chips cuelgan de los mismos rieles).
    const sinCable = pinesSinAlimentar(project, inst.id, def);
    const alimentado = encendido?.(inst.id) ?? sinCable.length === 0;
    let avisadoAlimentacion = false;
    for (const uso of def.chips) {
      const chip = catalogo.find((c) => c.id === uso.id);
      if (!chip) {
        avisos.push(`${quien}: el chip "${uso.id}" no está en chips/: no va a responder.`);
        continue;
      }
      const delModulo = (pinChip: string): string | undefined => Object.entries(uso.pines).find(([, c]) => c === pinChip)?.[0];
      const gpioChip = (pinChip: string | undefined): number | null => {
        const pm = pinChip === undefined ? undefined : delModulo(pinChip);
        return pm === undefined ? null : gpioDe(project, inst.id, pm, buscar);
      };
      // Un chip con dos buses (el BME280 habla I2C o SPI) queda en el que esté cableado.
      const i2c = enlaceI2c(chip, desc, gpioChip, delModulo, quien);
      const spi = i2c.estado === 'ok' ? { estado: 'no' as const } : enlaceSpi(chip, desc, gpioChip, quien);
      if (i2c.estado !== 'ok' && spi.estado !== 'ok') {
        for (const r of [i2c, spi]) if (r.estado === 'mal') avisos.push(r.aviso);
        continue;
      }
      if (!alimentado && !avisadoAlimentacion) {
        avisadoAlimentacion = true;
        avisos.push(sinCable.length === 0
          ? `${quien}: no le llega la tensión que necesita (ver los avisos eléctricos): no va a responder.`
          : `${quien}: sin alimentación (${sinCable.join(', ')} sin conectar): no va a responder.`);
      }
      chips.push({
        id: def.chips.length === 1 ? inst.id : `${inst.id}:${uso.id}`,
        instancia: inst.id,
        chip: chip.id,
        nombre: def.chips.length === 1 ? quien : `${chip.nombre} de ${quien}`,
        codigo: chip.codigo,
        // En SPI, SDO es MISO (no elige la dirección I2C): no tiene sentido avisar de su nivel.
        props: propsDe(project, inst.id, def, uso, buscar, spi.estado === 'ok' ? [] : avisos, quien),
        entorno: entornoDe(chip, inst.entorno),
        alimentado,
        maxHz: i2c.estado === 'ok' ? chip.i2c?.maxHz : undefined,
        pinesGpio: pinesAlMicro(project, inst.id, uso, buscar, [chip.i2c?.sda, chip.i2c?.scl, chip.spi?.sck, chip.spi?.mosi, chip.spi?.miso]),
        pullUps: uso.pullUps,
        diferirEscrituras: i2c.estado === 'ok' ? chip.i2c?.diferirEscrituras : undefined,
        spi: spi.estado === 'ok' ? spi.config : undefined,
        entradas: Object.fromEntries(chip.entradas.flatMap((pc) => { const g = gpioChip(pc); return g === null ? [] : [[g, pc]]; })),
      });
      if (spi.estado === 'ok' && spi.aviso) avisos.push(spi.aviso);
    }
  }
  return { chips, avisos };
}

/** Props de la instancia (con los defaults del módulo) más las que salen del cableado (SDO a GND → 0x76). */
function propsDe(project: Project, id: string, def: ModuleDef, uso: UsoChip, buscar: BuscarDef, avisos: string[], quien: string): Record<string, unknown> {
  const inst = project.modules.find((m) => m.id === id);
  const props: Record<string, unknown> = { ...Object.fromEntries(Object.entries(def.props).map(([k, p]) => [k, p.default])), ...inst?.props };
  for (const [prop, regla] of Object.entries(uso.porCableado)) {
    const nivel = nivelFijo(project, id, regla.pin, buscar);
    if (nivel === 'tierra') props[prop] = regla.aTierra;
    else if (nivel === 'alimentacion') props[prop] = regla.aAlimentacion;
    else if (nivel === 'gpio') avisos.push(`${quien}: ${regla.pin} va a un pin del micro: su nivel lo decide el programa; se toma "${String(props[prop])}" (el de la placa sin cablear).`);
  }
  return props;
}

/** Pin del chip → GPIO del micro, para los pines del módulo cableados a la placa (sin contar el bus). */
function pinesAlMicro(project: Project, id: string, uso: UsoChip, buscar: BuscarDef, delBus: (string | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [pinModulo, pinChip] of Object.entries(uso.pines)) {
    if (delBus.includes(pinChip)) continue; // SDA/SCL los maneja el bus, no el chip por su cuenta
    const g = gpioDe(project, id, pinModulo, buscar);
    if (g !== null) out[pinChip] = g;
  }
  return out;
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
    const inst = project.modules.find((m) => m.id === otro.id);
    const def = inst && buscar(inst.type);
    const kind = def?.pins.find((p) => p.name === otro.pin)?.kind;
    if (kind === 'ground') return 'tierra';
    if (kind === 'power') return 'alimentacion';
    if (def?.programmable) gpio = true;
  }
  return gpio ? 'gpio' : null;
}

type Enlace = { estado: 'ok' } | { estado: 'no' } | { estado: 'mal'; aviso: string };

/** ¿El chip quedó en el bus I2C de la placa? SDA y SCL tienen que ir a los pines del bus. */
function enlaceI2c(
  chip: ChipCatalogo, desc: BoardDescriptor | undefined, gpioChip: (p: string | undefined) => number | null,
  delModulo: (p: string) => string | undefined, quien: string,
): Enlace {
  if (!chip.i2c) return { estado: 'no' };
  const pSda = delModulo(chip.i2c.sda);
  const pScl = delModulo(chip.i2c.scl);
  if (!pSda || !pScl) return { estado: 'mal', aviso: `${quien}: el módulo no dice qué pin es ${!pSda ? chip.i2c.sda : chip.i2c.scl} del ${chip.nombre}.` };
  const gSda = gpioChip(chip.i2c.sda);
  const gScl = gpioChip(chip.i2c.scl);
  if (gSda === null && gScl === null) return { estado: 'no' }; // sin cablear todavía
  if (desc?.buses?.i2c.some((b) => b.sda === gSda && b.scl === gScl)) return { estado: 'ok' };
  const cruzado = desc?.buses?.i2c.some((b) => b.sda === gScl && b.scl === gSda);
  return {
    estado: 'mal',
    aviso: !desc?.buses?.i2c.length
      ? `${quien}: esta placa no emula el bus I2C hacia los módulos; el ${chip.nombre} no va a responder.`
      : cruzado
        ? `${quien}: SDA y SCL están cruzados: el ${chip.nombre} no va a responder (como en la placa real).`
        : `${quien}: ${pSda} y ${pScl} tienen que ir a los pines SDA y SCL del bus I2C de la placa.`,
  };
}

/** ¿El chip quedó en el bus SPI? SCK/MOSI/MISO a los del bus y CS a cualquier pin del micro. */
function enlaceSpi(
  chip: ChipCatalogo, desc: BoardDescriptor | undefined, gpioChip: (p: string | undefined) => number | null, quien: string,
): { estado: 'ok'; config: NonNullable<ChipEnBus['spi']>; aviso?: string } | { estado: 'no' } | { estado: 'mal'; aviso: string } {
  const s = chip.spi;
  if (!s) return { estado: 'no' };
  const sck = gpioChip(s.sck), mosi = gpioChip(s.mosi), miso = gpioChip(s.miso), cs = gpioChip(s.cs), dc = gpioChip(s.dc);
  if (sck === null && mosi === null) return { estado: 'no' };
  const bus = desc?.buses?.spi.find((b) => b.sck === sck && b.mosi === mosi);
  if (!bus) {
    return {
      estado: 'mal',
      aviso: !desc?.buses?.spi.length
        ? `${quien}: esta placa no emula el bus SPI hacia los módulos; el ${chip.nombre} no va a responder.`
        : `${quien}: ${s.sck} y ${s.mosi} del ${chip.nombre} tienen que ir a SCK y MOSI del bus SPI de la placa (en el Uno, D13 y D11).`,
    };
  }
  if (cs === null) return { estado: 'mal', aviso: `${quien}: ${s.cs} (selección) no está cableado a un pin de la placa: el ${chip.nombre} nunca queda seleccionado.` };
  if (s.dc && dc === null) return { estado: 'mal', aviso: `${quien}: ${s.dc} (dato/comando) no está cableado a un pin de la placa.` };
  const aviso = s.miso && !s.soloEscritura && miso !== bus.miso
    ? `${quien}: ${s.miso} del ${chip.nombre} no va a MISO del bus (en el Uno, D12): lo que lea el programa va a ser 0xFF.`
    : undefined;
  return {
    estado: 'ok',
    config: { csGpio: cs, dcGpio: dc ?? undefined, modos: s.modos, lsbPrimero: s.lsbPrimero, soloEscritura: s.soloEscritura || miso !== bus.miso, maxHz: s.maxHz },
    aviso,
  };
}
