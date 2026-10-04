import type { BoardDescriptor } from '@emu/shared';
import type { Netlist } from './netlist.js';

/**
 * Modelo eléctrico de una placa, armado a partir de su descriptor (`board` del module.json).
 * Es código del server (de confianza): escribe SPICE directo donde hace falta.
 *
 *  - USB (si "USB conectado"): 5 V, hasta 500 mA (polifusible), solo entrega.
 *  - VIN (Uno): regulador a 5 V, caída mínima 1 V, hasta 1 A, solo entrega.
 *  - Regulador 3,3 V (LDO): sale del riel de 5 V, caída mínima 0,3 V, hasta 600 mA, solo
 *    entrega. LA CORRIENTE QUE ENTREGA LA SACA DE SU ENTRADA (fuente controlada F): así se
 *    conserva la energía y el regulador disipa (Vin − Vout)·I, como uno real. Más ~5 mA propios.
 *  - El chip: consume su corriente típica del riel lógico (3V3 en un ESP32, 5 V en el Uno), y
 *    por debajo del umbral de brownout se apaga (lo decide quien arma: dos pasadas).
 *  - Cada GPIO cableado: diodos de protección contra el riel y contra GND (siempre, aunque el
 *    chip esté apagado: así se ve la "alimentación fantasma" por un pin). Con el chip andando:
 *    salida push-pull con su resistencia interna (`pinOutputOhm`), y pull-up de 45 kΩ en las
 *    entradas que el firmware configura con pull-up.
 */

/** Nodos SPICE de los rieles de la placa. Pueden coincidir (o ser "0") si están cableados entre sí: un corto. */
export interface RielesPlaca {
  n5v: string;
  n3v3: string;
  nvin: string;
  ngnd?: string;
}

const DIODO_PROTECCION = { is: 1e-15, n: 1 };
const PULLUP_OHM = 45000;
const LDO_QUIESCENTE_OHM = 1000; // ~5 mA a 5 V

export interface OpcionesPlaca {
  id?: string;
  desc: BoardDescriptor | undefined;
  rieles: RielesPlaca;
  usb: boolean;
  /** ¿Hay algo cableado al VIN? Si no, su regulador no tiene nada que regular y no se arma. */
  vinCableado?: boolean;
  chipEncendido: boolean;
  /** Nivel de salida de cada GPIO que el firmware maneja como salida. */
  salidas: Map<number, 0 | 1>;
  /** GPIO configurados como entrada con pull-up / pull-down internos. */
  pullups: Set<number>;
  pulldowns?: Set<number>;
  /** GPIO cableados → su nodo SPICE. */
  gpios: Map<number, string>;
}

export interface PlacaArmada {
  /** Nodo del riel donde está el chip (3V3 o 5V). */
  riel: string;
  /** Umbral de brownout del riel lógico (V). */
  brownout: number;
  /** Elementos de la placa para leer después: board.usb, board.ldo, board.vin, board.chip, board.gpioN... */
  conPower: boolean;
}

export function armarPlaca(n: Netlist, o: OpcionesPlaca): PlacaArmada {
  const desc = o.desc;
  const id = o.id ?? 'board';
  const prefijo = id.replace(/[^a-zA-Z0-9_]/g, '_');
  const { n5v, n3v3, nvin } = o.rieles;
  const tierra = o.rieles.ngnd ?? '0';
  // Referencia numérica de una isla flotante: evita una matriz singular sin unir tierras.
  if (tierra !== '0') n.agregar(id, { tipo: 'R', nombre: 'referencia', a: tierra, b: '0', ohms: 1e12 });
  const logica = desc?.logicVoltage ?? 3.3;
  const riel = logica >= 4.5 ? n5v : n3v3;
  const brownout = 0.8 * logica;
  const conPower = Boolean(desc?.power);

  n.crudo(`* --- placa (${desc?.chipName ?? desc?.chip ?? 'sin descriptor'}) ---`);
  // Sin bloque `power` (placa importada vieja) se asume enchufada: USB siempre.
  if (o.usb || !conPower) {
    n.agregar(id, { tipo: 'V', nombre: 'usb', a: n5v, b: tierra, voltios: 5, limiteA: 0.5, soloEntrega: true });
  }
  // VIN → 5 V (solo si la placa tiene esa entrada).
  if (o.vinCableado !== false && desc?.power?.inputs.some((i) => i.feeds === 'vin')) {
    reguladorLineal(n, id, tierra, 'vin', nvin, n5v, 5, 1, 1);
  }
  reguladorLineal(n, id, tierra, 'ldo', n5v, n3v3, 3.3, 0.3, 0.6);
  if (n5v !== tierra) n.agregar(id, { tipo: 'R', nombre: 'ldo_q', a: n5v, b: tierra, ohms: LDO_QUIESCENTE_OHM });

  // El chip: consumo típico mientras su riel está por encima del brownout; por debajo, cae
  // proporcional (está reseteándose). Se mide con un amperímetro propio.
  const ion = (desc?.power?.currentMa ?? 80) / 1000;
  n.crudo(
    `vam_${prefijo}_chip ${riel} xchip_${prefijo} DC 0`,
    `bchip_${prefijo} xchip_${prefijo} ${tierra} I=${ion}*max(0,min(1,V(xchip_${prefijo},${tierra})/${brownout}))`,
  );
  n.registrar({ id: `${id}.chip`, dueno: id, local: 'chip', tipo: 'X', a: riel, b: tierra, medidor: `vam_${prefijo}_chip` });

  const rOut = desc?.pinOutputOhm ?? 33;
  for (const [g, nodo] of o.gpios) {
    n.agregar(id, { tipo: 'D', nombre: `prot_alto_${g}`, a: nodo, b: riel, modelo: DIODO_PROTECCION });
    n.agregar(id, { tipo: 'D', nombre: `prot_bajo_${g}`, a: tierra, b: nodo, modelo: DIODO_PROTECCION });
    if (!o.chipEncendido) continue;
    const nivel = o.salidas.get(g);
    if (nivel === 1) n.agregar(id, { tipo: 'R', nombre: `gpio${g}`, a: riel, b: nodo, ohms: rOut });
    else if (nivel === 0) n.agregar(id, { tipo: 'R', nombre: `gpio${g}`, a: nodo, b: tierra, ohms: rOut });
    else if (o.pullups.has(g)) n.agregar(id, { tipo: 'R', nombre: `pullup${g}`, a: riel, b: nodo, ohms: PULLUP_OHM });
    else if (o.pulldowns?.has(g)) n.agregar(id, { tipo: 'R', nombre: `pulldown${g}`, a: nodo, b: tierra, ohms: PULLUP_OHM });
  }
  return { riel, brownout, conPower };
}

/**
 * Regulador lineal de `entrada` a `salida`: Vout = min(vNom, Vin − caída), hasta `limiteA`,
 * solo entrega. La corriente que entrega la toma de la entrada (conservación de la energía).
 */
function reguladorLineal(n: Netlist, id: string, tierra: string, nombre: string, entrada: string, salida: string, vNom: number, caida: number, limiteA: number): void {
  const p = `reg_${id.replace(/[^a-zA-Z0-9_]/g, '_')}_${nombre}`;
  const m = n.modelo('D(IS=1e-6 N=0.01)');
  n.crudo(
    `b${p}_ref ${p}_r ${tierra} V=max(0,min(${vNom},V(${entrada},${tierra})-${caida}))`,
    `i${p}_lim ${tierra} ${p}_q DC ${limiteA}`,
    `d${p}_rec ${p}_q ${p}_r ${m}`,
    `d${p}_blq ${p}_q ${p}_x ${m}`,
    `vam_${p} ${p}_x ${salida} DC 0`,
  );
  // Lo que entrega lo saca de la entrada (si la entrada no es la tierra misma: un corto). Solo en el
  // sentido en que entrega: un regulador real nunca le devuelve corriente a su entrada. (Copiar
  // también la fuga inversa de su salida hacia una entrada sin nada cableado daba tensiones
  // absurdas en ese nodo, y ngspice no convergía.)
  if (entrada !== tierra) n.crudo(`b${p}_in ${entrada} ${tierra} I=max(0,i(vam_${p}))`);
  // Para leerlo es una caja negra de dos lados: la salida entrega I (corriente que "entra" por
  // ella: −I) y la entrada consume la misma I. Así Kirchhoff y la energía cierran en sus nodos.
  n.registrar({ id: `${id}.${nombre}`, dueno: id, local: nombre, tipo: 'X', a: salida, b: tierra, medidor: `vam_${p}`, signo: -1 });
  if (entrada !== tierra) {
    n.registrar({ id: `${id}.${nombre}_entrada`, dueno: id, local: `${nombre}_entrada`, tipo: 'X', a: entrada, b: tierra, medidor: `vam_${p}` });
  }
}
