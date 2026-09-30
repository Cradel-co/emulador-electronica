import { corrienteRecomendada, nombreDePin, type ModuleDef, type Project } from '@emu/shared';
import { descriptorDe, gpioDe, gpioDeRef } from './diagramOps.js';

/**
 * Ley de Ohm real sobre el dibujo: arma la red eléctrica (cables = 0 Ω, resistencias
 * con su valor, el LED como una caída de tensión fija más su resistencia interna) y
 * calcula la corriente de cada camino desde una fuente (3V3, 5V o un GPIO de salida)
 * hasta GND: I = (V − Vf) / (R_fuente + R_serie), para avisar cortocircuitos,
 * sobrecorriente y LEDs que se queman — no compila un modelo SPICE completo (sin
 * mallas/paralelo genérico, sin polaridad de diodo): alcanza para los circuitos de
 * esta app (una fuente, una cadena de resistencia(s)/LED en serie, hasta GND).
 *
 * La fuente no es ideal, como en la placa de verdad: un pin de salida tiene resistencia
 * interna (`board.pinOutputOhm` del module.json de la placa) y por eso un LED rojo
 * directo a un GPIO de un ESP32 queda sobreexigido (~27 mA) pero no revienta, mientras
 * que en un Uno a 5 V pasa ~75 mA y se quema. Valores (aproximaciones de las hojas de datos):
 *  - ATmega328P, 25 Ω: curva "I/O pin output voltage vs. source current (VCC = 5 V)",
 *    VOH ≈ 4.5 V a 20 mA a 25 °C → (5 − 4.5) / 0.020 ≈ 25 Ω.
 *  - ESP32-S3/C3/C6, 33 Ω: tabla "DC characteristics" da VOH ≥ 0.8·VDD (2.64 V) a
 *    IOH = 40 mA con la fuerza de salida máxima (≈16.5 Ω); ESP-IDF/ESPHome usan por
 *    defecto la mitad (GPIO_DRIVE_CAP_2, ~20 mA) → ≈ 33 Ω. Aproximación conservadora.
 *  - 3V3/5V de la placa, 0.5 Ω: regulador/USB; casi ideal a estas corrientes.
 * El LED trae sus límites en su propio module.json (`electrical`: resistencia serie
 * ~15 Ω de un LED de 5 mm, 20 mA continuos, se daña por encima de ~60 mA sostenidos).
 */

type BuscarDef = (type: string) => ModuleDef | undefined;

/** Tensión de un pin de la placa que siempre está "viva" (no depende del código). */
const V_GND = 0;
export const V_3V3 = 3.3;
export const V_5V = 5;
/** Nivel lógico alto del ESP32-S3. El de cada placa sale del registro (`logica.vAlto`: 5 V en el Uno). */
export const V_GPIO_ALTO = 3.3;

/** Límites reales del ESP32-S3 (hoja de datos de Espressif: IO MUX / GPIO); los de cada placa, en el registro. */
export const GPIO_MAX_MA = 40;
export const GPIO_RECOMENDADO_MA = 20;
/** Típicos de un LED de 5 mm estándar (si su module.json no trae `electrical`). */
export const LED_MAX_MA = 20;
export const LED_QUEMA_MA = 60;
export const LED_SERIE_OHM = 15;
/** Resistencias de fuente si la placa no las declara (las del ESP32, ver arriba). */
export const PIN_SALIDA_OHM = 33;
export const FUENTE_OHM = 0.5;

export type EstadoLed = 'ok' | 'sobreexigido' | 'se-quema';

/** Corriente por cada LED del dibujo con su fuente en alto, y qué le pasa. */
export interface LedElectrico {
  id: string;
  mA: number;
  estado: EstadoLed;
}

export interface Rama {
  origenRef: string;
  origenV: number;
  destinoRef: string;
  ohms: number;
  vf: number;
  /** Resistencia interna de la fuente (pin de salida o regulador), ya sumada al cálculo. */
  ohmsFuente: number;
  /** Infinity = cortocircuito (sin ninguna resistencia real de por medio, ni siquiera de la fuente). */
  amperios: number;
  pines: string[];
  componentes: { instId: string; tipo: 'resistor' | 'led' }[];
}

export interface AvisoElectrico {
  severidad: 'peligro' | 'advertencia';
  mensaje: string;
  pin: number;
}

interface Edge {
  a: string;
  b: string;
  ohms: number;
  vf: number;
  instId: string;
  tipo: 'resistor' | 'led';
}

interface LimitesLed {
  maxMa: number;
  quemaMa: number;
}

/** Ohms de una resistencia (o -1 si el módulo no es uno, o el valor no es válido). */
function ohmsDe(def: ModuleDef, props: Record<string, unknown>): number {
  if (!def.ohmsProp) return -1;
  const v = Number(props[def.ohmsProp] ?? def.props[def.ohmsProp]?.default);
  return Number.isFinite(v) && v > 0 ? v : -1;
}

/** Caída de tensión directa del LED: de `vars.vf` (según una prop, p. ej. el color) o `diodeVfDefault`. */
function vfDe(def: ModuleDef, props: Record<string, unknown>): number {
  const v = def.vars?.vf;
  if (v) {
    const clave = String(props[v.prop] ?? '');
    const txt = v.map[clave] ?? v.default;
    const n = Number(txt);
    if (Number.isFinite(n)) return n;
  }
  return def.diodeVfDefault ?? 2;
}

class UnionFind {
  private padre = new Map<string, string>();

  buscar(ref: string): string {
    if (!this.padre.has(ref)) this.padre.set(ref, ref);
    let r = ref;
    while (this.padre.get(r) !== r) r = this.padre.get(r)!;
    // Compresión de camino.
    let cur = ref;
    while (this.padre.get(cur) !== r) {
      const sig = this.padre.get(cur)!;
      this.padre.set(cur, r);
      cur = sig;
    }
    return r;
  }

  unir(a: string, b: string): void {
    const ra = this.buscar(a);
    const rb = this.buscar(b);
    if (ra !== rb) this.padre.set(ra, rb);
  }
}

export function analizarCircuito(
  project: Project,
  buscar: BuscarDef,
  nivelesGpio: Map<number, 0 | 1> = new Map(),
): { ramas: Rama[]; avisos: AvisoElectrico[]; leds: LedElectrico[] } {
  // Niveles de la placa (descriptor del module.json): 3.3 V en los ESP32, 5 V en el Uno.
  const placaDef = buscar(project.board);
  const desc = placaDef?.board;
  const vAlto = desc?.logicVoltage ?? V_GPIO_ALTO;
  const MAX_MA = desc?.maxPinCurrentMa ?? GPIO_MAX_MA;
  const RECOMENDADO_MA = desc ? corrienteRecomendada(desc) : GPIO_RECOMENDADO_MA;
  const chip = desc?.chipName ?? desc?.chip ?? 'ESP32-S3';
  const ohmsPin = desc?.pinOutputOhm ?? PIN_SALIDA_OHM;
  const ohmsFuente = desc?.supplyOutputOhm ?? FUENTE_OHM;
  const etiquetaPlaca = placaDef?.name ?? 'ESP32';
  /** Nombre legible de una referencia de pin, sin depender del catálogo (para los avisos). */
  const nombreCorto = (ref: string): string => (ref.startsWith('board.') ? `${etiquetaPlaca} · ${ref.slice(6)}` : ref);
  const gpioDeRefPin = (ref: string): number | null => gpioDeRef(ref, descriptorDe(project, buscar));
  const pinTxt = (n: number): string => nombreDePin(desc, n);
  const uf = new UnionFind();
  for (const w of project.wires) uf.unir(w.from, w.to);

  // Qué GPIO maneja cada instancia con rol "output" (resistencias de por medio incluidas).
  const gpioDeSalida = new Set<number>();
  for (const inst of project.modules) {
    const def = buscar(inst.type);
    if (def?.bridge?.role !== 'output') continue;
    const g = gpioDe(project, inst.id, def.bridge.pin, buscar);
    if (g !== null) gpioDeSalida.add(g);
  }

  /** Tensión fija de una referencia de la placa, o null si no es una fuente conocida. */
  function tensionDeRef(ref: string): number | null {
    if (/^board\.GND/.test(ref)) return V_GND;
    if (/^board\.3V3/.test(ref)) return V_3V3;
    if (/^board\.(5V|IOREF)(_\d+)?$/.test(ref)) return V_5V;
    const g = gpioDeRefPin(ref);
    if (g !== null && gpioDeSalida.has(g)) {
      // Sin dato de la simulación corriendo: se asume el peor caso (en alto), para avisar antes de ejecutar.
      const nivel = nivelesGpio.get(g) ?? 1;
      return nivel * vAlto;
    }
    return null;
  }

  // Agrupa las referencias por net (raíz del union-find) para clasificar cada una.
  const porNet = new Map<string, string[]>();
  const netDe = (ref: string): string => uf.buscar(ref);
  const registrar = (ref: string) => {
    const n = netDe(ref);
    if (!porNet.has(n)) porNet.set(n, []);
    if (!porNet.get(n)!.includes(ref)) porNet.get(n)!.push(ref);
  };
  for (const w of project.wires) {
    registrar(w.from);
    registrar(w.to);
  }

  interface InfoNet { v: number | null; conflicto: boolean }
  const info = new Map<string, InfoNet>();
  const avisos: AvisoElectrico[] = [];
  for (const [net, refs] of porNet) {
    const fuentes = refs.map((r) => ({ ref: r, v: tensionDeRef(r) })).filter((f): f is { ref: string; v: number } => f.v !== null);
    const distintos = new Set(fuentes.map((f) => f.v));
    if (distintos.size > 1) {
      const [a, b] = fuentes as [{ ref: string; v: number }, { ref: string; v: number }];
      avisos.push({
        severidad: 'peligro',
        pin: gpioDeRefPin(a.ref) ?? gpioDeRefPin(b.ref) ?? -1,
        mensaje: `${nombreCorto(a.ref)} (${a.v} V) y ${nombreCorto(b.ref)} (${b.v} V) están cableados directo entre sí, sin nada de por medio: es un cortocircuito.`,
      });
      info.set(net, { v: null, conflicto: true });
    } else {
      info.set(net, { v: fuentes[0]?.v ?? null, conflicto: false });
    }
  }

  // Componentes de 2 pines que suman resistencia o caída de tensión al camino.
  const grafo = new Map<string, Edge[]>();
  const agregarArista = (e: Edge) => {
    for (const [x, y] of [[e.a, e.b], [e.b, e.a]] as const) {
      if (!grafo.has(x)) grafo.set(x, []);
      grafo.get(x)!.push({ ...e, a: x, b: y });
    }
  };
  const limitesLed = new Map<string, LimitesLed>();
  for (const inst of project.modules) {
    const def = buscar(inst.type);
    if (!def || def.pins.length !== 2) continue;
    const ohms = ohmsDe(def, inst.props);
    const esResistencia = def.passthrough && ohms > 0;
    const esLed = def.diode;
    if (!esResistencia && !esLed) continue;
    const [p1, p2] = def.pins;
    const netA = netDe(`${inst.id}.${p1!.name}`);
    const netB = netDe(`${inst.id}.${p2!.name}`);
    if (esLed) {
      limitesLed.set(inst.id, {
        maxMa: def.electrical?.maxCurrentMa ?? LED_MAX_MA,
        quemaMa: def.electrical?.burnCurrentMa ?? LED_QUEMA_MA,
      });
    }
    agregarArista({
      a: netA, b: netB,
      ohms: esResistencia ? ohms : esLed ? (def.electrical?.seriesOhm ?? LED_SERIE_OHM) : 0,
      vf: esLed ? vfDe(def, inst.props) : 0,
      instId: inst.id, tipo: esResistencia ? 'resistor' : 'led',
    });
  }

  // DFS desde cada fuente hasta GND, sumando resistencia y caída de tensión (camino simple, sin ciclos).
  const ramas: Rama[] = [];
  const MAX_SALTOS = 8;
  for (const [netOrigen, infoOrigen] of info) {
    if (infoOrigen.conflicto || !infoOrigen.v || infoOrigen.v <= 0) continue;
    const refsOrigen = porNet.get(netOrigen)!;
    const origenRef = refsOrigen.find((r) => tensionDeRef(r) !== null) ?? refsOrigen[0]!;

    const pila: { net: string; ohms: number; vf: number; pines: string[]; comps: Rama['componentes']; vistos: Set<string> }[] = [
      { net: netOrigen, ohms: 0, vf: 0, pines: [origenRef], comps: [], vistos: new Set([netOrigen]) },
    ];
    while (pila.length) {
      const actual = pila.pop()!;
      const infoActual = info.get(actual.net);
      if (actual.pines.length > 1 && infoActual?.v === V_GND) {
        const refsDestino = porNet.get(actual.net)!;
        const destinoRef = refsDestino.find((r) => /^board\.GND/.test(r)) ?? refsDestino[0]!;
        const deltaV = infoOrigen.v - actual.vf;
        const rFuente = gpioDeRefPin(origenRef) !== null ? ohmsPin : ohmsFuente;
        const rTotal = actual.ohms + rFuente;
        const amperios = deltaV <= 0 ? 0 : rTotal === 0 ? Infinity : deltaV / rTotal;
        if (amperios > 0) {
          ramas.push({
            origenRef, origenV: infoOrigen.v, destinoRef,
            ohms: actual.ohms, ohmsFuente: rFuente, vf: actual.vf, amperios,
            pines: [...actual.pines, destinoRef], componentes: actual.comps,
          });
        }
        continue; // no seguir de largo desde GND
      }
      if (actual.pines.length - 1 >= MAX_SALTOS) continue;
      for (const arista of grafo.get(actual.net) ?? []) {
        if (actual.vistos.has(arista.b)) continue;
        const refsSiguiente = porNet.get(arista.b) ?? [];
        const refPin = refsSiguiente[0] ?? arista.instId;
        pila.push({
          net: arista.b,
          ohms: actual.ohms + arista.ohms,
          vf: actual.vf + arista.vf,
          pines: [...actual.pines, refPin],
          comps: [...actual.comps, { instId: arista.instId, tipo: arista.tipo }],
          vistos: new Set([...actual.vistos, arista.b]),
        });
      }
    }
  }

  // Corriente por cada LED (suma de las ramas que lo atraviesan) y su estado.
  const mAporLed = new Map<string, number>();
  for (const rama of ramas) {
    for (const c of rama.componentes) {
      if (c.tipo === 'led') mAporLed.set(c.instId, (mAporLed.get(c.instId) ?? 0) + rama.amperios * 1000);
    }
  }
  const leds: LedElectrico[] = [...limitesLed].map(([id, lim]) => {
    const mA = mAporLed.get(id) ?? 0;
    const estado: EstadoLed = mA > lim.quemaMa ? 'se-quema' : mA > lim.maxMa ? 'sobreexigido' : 'ok';
    return { id, mA: Number.isFinite(mA) ? Math.round(mA * 10) / 10 : mA, estado };
  });
  const estadoLed = new Map(leds.map((l) => [l.id, l]));

  // Avisos por rama: cortocircuito, LED que se quema o sobreexigido, corriente de más en el pin.
  const porGpio = new Map<number, number>(); // gpio -> mA acumulados (varias ramas de la misma fuente)
  for (const rama of ramas) {
    const gpio = gpioDeRefPin(rama.origenRef);
    const led = rama.componentes.find((c) => c.tipo === 'led');
    const resistores = rama.componentes.filter((c) => c.tipo === 'resistor');
    const mA = rama.amperios * 1000;
    const sugerencia = `Agregá una Resistencia en serie (220 Ω anda bien para ${gpio !== null ? vAlto : rama.origenV} V).`;

    if (rama.componentes.length === 0) {
      // Nada de por medio: la fuente directo a GND.
      avisos.push({
        severidad: 'peligro', pin: gpio ?? -1,
        mensaje: `Cortocircuito directo entre ${nombreCorto(rama.origenRef)} y ${nombreCorto(rama.destinoRef)} ` +
          `(${Number.isFinite(mA) ? `~${mA.toFixed(0)} mA, ` : ''}nada de por medio limita la corriente). No lo ejecutes así: podés dañar la placa.`,
      });
      continue;
    }
    if (led) {
      const e = estadoLed.get(led.instId)!;
      const lim = limitesLed.get(led.instId)!;
      if (e.estado === 'se-quema') {
        avisos.push({
          severidad: 'peligro', pin: gpio ?? -1,
          mensaje: `El LED (${led.instId}) entre ${nombreCorto(rama.origenRef)} y ${nombreCorto(rama.destinoRef)} llevaría ~${e.mA.toFixed(0)} mA ` +
            `${resistores.length === 0 ? 'sin ninguna resistencia en serie' : 'con una resistencia demasiado chica'}: se va a quemar ` +
            `(aguanta hasta ~${lim.quemaMa} mA${gpio !== null ? ', y puede dañar el pin' : ''}). ${sugerencia}`,
        });
      } else if (e.estado === 'sobreexigido') {
        avisos.push({
          severidad: 'advertencia', pin: gpio ?? -1,
          mensaje: `~${e.mA.toFixed(0)} mA por el LED (${led.instId}): más de lo recomendado (${lim.maxMa} mA)` +
            `${resistores.length === 0 ? ', porque no tiene resistencia en serie' : ''}. No se quema enseguida, pero brilla de más y dura menos. ${sugerencia}`,
        });
      }
    }
    if (gpio !== null && Number.isFinite(mA)) porGpio.set(gpio, (porGpio.get(gpio) ?? 0) + mA);
    if (gpio !== null && mA > MAX_MA) {
      avisos.push({
        severidad: 'peligro', pin: gpio,
        mensaje: `${pinTxt(gpio)} tendría que entregar ~${mA.toFixed(0)} mA: por encima del máximo del ${chip} (${MAX_MA} mA). ${resistores[0] ? `Subí el valor de la Resistencia (${resistores[0].instId}).` : sugerencia}`,
      });
    } else if (gpio !== null && mA > RECOMENDADO_MA) {
      avisos.push({
        severidad: 'advertencia', pin: gpio,
        mensaje: `${pinTxt(gpio)} entregaría ~${mA.toFixed(0)} mA: por encima de lo recomendado (${RECOMENDADO_MA} mA). Funciona, pero acorta la vida del pin — ${resistores[0] ? `subí la Resistencia (${resistores[0].instId}).` : sugerencia}`,
      });
    }
  }
  // Varias ramas de la misma fuente (dos LEDs en el mismo GPIO, por ejemplo): el total también importa.
  for (const [gpio, mA] of porGpio) {
    if (mA > MAX_MA) {
      avisos.push({ severidad: 'peligro', pin: gpio, mensaje: `Entre todo lo que cuelga de ${pinTxt(gpio)} suman ~${mA.toFixed(0)} mA: por encima del máximo del pin (${MAX_MA} mA).` });
    } else if (mA > RECOMENDADO_MA) {
      avisos.push({ severidad: 'advertencia', pin: gpio, mensaje: `Entre todo lo que cuelga de ${pinTxt(gpio)} suman ~${mA.toFixed(0)} mA: por encima de lo recomendado (${RECOMENDADO_MA} mA).` });
    }
  }

  return { ramas, avisos, leds };
}
