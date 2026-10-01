import { BOARD_MODULE_ID, corrienteRecomendada, nombreDePin, parseModuleRef, type ModuleDef, type Project } from '@emu/shared';
import { descriptorDe, gpioDe, gpioDeRef } from './diagramOps.js';

/**
 * Ley de Ohm real sobre el dibujo: arma la red eléctrica (cables = 0 Ω, resistencias
 * con su valor, el LED como una caída de tensión fija más su resistencia interna) y
 * calcula la corriente de cada camino desde una fuente (3V3, 5V, un GPIO de salida o
 * el canal de un módulo `source` — puede ser negativo) hasta GND, usando la magnitud
 * de la tensión: I = (|V| − Vf) / (R_fuente + R_serie), para avisar cortocircuitos,
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
  /**
   * Corriente que le llega desde fuentes que no dependen del código (fuente regulable, 3V3/5V
   * de la placa), p. ej. a través de un pulsador. Con esto la UI lo prende aunque ningún GPIO lo maneje.
   */
  mAFijo: number;
}

/**
 * ¿La placa tiene con qué andar? ok = arranca; sin-energia / baja = no arranca (con el motivo);
 * quema = sobretensión o polaridad invertida en una entrada de alimentación.
 */
export interface AlimentacionPlaca {
  estado: 'ok' | 'sin-energia' | 'baja' | 'quema';
  via: 'usb' | 'fuente' | 'sin-datos' | null;
  /** Pin de entrada por el que llega la fuente, y qué es según el descriptor. */
  pin: string | null;
  entrada: 'vin' | '5v' | '3v3' | null;
  fuenteId: string | null;
  v: number | null;
  /** Consumo típico de la placa andando (mA), del descriptor. */
  consumoMa: number | null;
  /** La fuente a la que la placa le pide corriente (andando, o intentando arrancar en modo CC). */
  consumeDe: string | null;
  mensaje: string;
}

/**
 * Lo que entrega cada fuente regulable (el "panel frontal" de la fuente de laboratorio).
 * CV = voltaje constante (la carga pide menos que el límite); CC = limitando corriente;
 * corto = su salida cableada directo contra otra tensión (entrega el límite con ~0 V).
 */
export interface FuenteElectrica {
  id: string;
  vAjuste: number;
  limiteMa: number | null;
  /** Lo que pediría la carga sin límite (null en corto: sin carga que la limite). */
  demandaMa: number | null;
  mA: number | null;
  vSalida: number;
  potenciaW: number;
  modo: 'CV' | 'CC' | 'corto';
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
  /** Refs "id.PIN" involucradas (para resaltar el pin/cable exacto en el canvas). */
  refs?: string[];
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
  /** Ids de los interruptores (`switch`) cerrados ahora: pulsador apretado, llave encendida. */
  cerrados: ReadonlySet<string> = new Set(),
): { ramas: Rama[]; avisos: AvisoElectrico[]; leds: LedElectrico[]; fuentes: FuenteElectrica[]; alimentacion: AlimentacionPlaca } {
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
  // Un interruptor cerrado une sus dos pines: para la electricidad es un cable más (así un
  // pulsador entre 3V3 y GND apretado es un cortocircuito, y uno en serie con un LED lo prende).
  for (const inst of project.modules) {
    const def = buscar(inst.type);
    if (def?.switch && def.pins.length === 2 && cerrados.has(inst.id)) {
      uf.unir(`${inst.id}.${def.pins[0]!.name}`, `${inst.id}.${def.pins[1]!.name}`);
    }
  }

  // Qué GPIO maneja cada instancia con rol "output" (resistencias de por medio incluidas).
  const gpioDeSalida = new Set<number>();
  for (const inst of project.modules) {
    const def = buscar(inst.type);
    if (def?.bridge?.role !== 'output') continue;
    const g = gpioDe(project, inst.id, def.bridge.pin, buscar);
    if (g !== null) gpioDeSalida.add(g);
  }

  /**
   * Tensión del pin `power` de una instancia `source` (p. ej. una fuente regulable):
   * la que tenga configurada en `props[source.voltageProp]`, sea positiva o negativa.
   * El pin `ground` de esa misma instancia no devuelve nada acá: tiene que estar
   * cableado a `board.GND` para que el DFS de abajo encuentre el camino de vuelta.
   */
  function tensionDeFuente(ref: string): number | null {
    const m = parseModuleRef(ref);
    if (!m) return null;
    const inst = project.modules.find((i) => i.id === m.moduleId);
    const def = inst && buscar(inst.type);
    if (!def?.source) return null;
    const pinDef = def.pins.find((p) => p.name === m.pin);
    if (pinDef?.kind !== 'power') return null;
    const v = Number(inst!.props[def.source.voltageProp] ?? def.props[def.source.voltageProp]?.default);
    return Number.isFinite(v) ? v : null;
  }

  /** Límite de corriente (mA) de una fuente regulable: su prop ajustable, o `electrical.maxCurrentMa`. */
  function limiteMaDeFuente(ref: string): number | undefined {
    const m = parseModuleRef(ref);
    const inst = m && project.modules.find((i) => i.id === m.moduleId);
    const def = inst && buscar(inst.type);
    if (!inst || !def?.source) return undefined;
    const prop = def.source.currentProp;
    const v = prop ? Number(inst.props[prop] ?? def.props[prop]?.default) : NaN;
    return Number.isFinite(v) && v > 0 ? v : def.electrical?.maxCurrentMa;
  }

  /** ¿La red de `ref` llega a algún GND de la placa? (sin eso, una fuente externa no cierra el circuito) */
  function llegaAGndDePlaca(ref: string): boolean {
    const net = uf.buscar(ref);
    return project.wires.some((w) => [w.from, w.to].some((r) => /^board\.GND/.test(r) && uf.buscar(r) === net));
  }

  /**
   * ¿La placa está alimentada? Por USB (prop "usb" de la placa) o por una fuente regulable
   * cableada a uno de sus pines de entrada (`board.power.inputs`), dentro de rango y con su
   * GND unido al de la placa. Se calcula antes que las tensiones de las redes porque decide
   * si los rieles 3V3/5V y los GPIO entregan algo.
   */
  function alimentacionDePlaca(): AlimentacionPlaca {
    const power = desc?.power;
    const base = { pin: null, entrada: null, fuenteId: null, v: null, consumoMa: power?.currentMa ?? null, consumeDe: null };
    if (!power) {
      return { ...base, estado: 'ok', via: 'sin-datos', mensaje: `${etiquetaPlaca}: su descriptor no dice cómo se alimenta; se asume alimentada.` };
    }
    const placaInst = project.modules.find((m) => m.id === BOARD_MODULE_ID);
    if ((placaInst?.props?.usb ?? placaDef?.props.usb?.default) === true) {
      return { ...base, estado: 'ok', via: 'usb', entrada: 'vin', v: 5, mensaje: `${etiquetaPlaca} alimentada por USB.` };
    }
    type Candidato = { entrada: (typeof power.inputs)[number]; pin: string; ref: string; v: number; fuenteId: string };
    const candidatos: Candidato[] = [];
    for (const entrada of power.inputs) {
      const re = new RegExp(`^${entrada.pin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_\\d+)?$`);
      for (const p of placaDef?.pins ?? []) {
        if (!re.test(p.name)) continue;
        const net = uf.buscar(`board.${p.name}`);
        for (const w of project.wires) {
          for (const r of [w.from, w.to]) {
            const v = uf.buscar(r) === net ? tensionDeFuente(r) : null;
            if (v !== null && !candidatos.some((c) => c.ref === r && c.pin === p.name)) {
              candidatos.push({ entrada, pin: p.name, ref: r, v, fuenteId: parseModuleRef(r)!.moduleId });
            }
          }
        }
      }
    }
    const desde = (c: Candidato) => ({ pin: c.pin, entrada: c.entrada.feeds, fuenteId: c.fuenteId, v: c.v });
    // Sobretensión o polaridad invertida: la placa se quema (aunque el GND no cierre del todo, no importa el orden).
    const quema = candidatos.find((c) => c.v < 0 || c.v > c.entrada.max);
    if (quema) {
      return {
        ...base, ...desde(quema), estado: 'quema', via: 'fuente',
        mensaje: quema.v < 0
          ? `${quema.fuenteId} entrega ${quema.v} V en ${etiquetaPlaca} · ${quema.pin}: polaridad invertida, la placa se quema.`
          : `${quema.fuenteId} entrega ${quema.v} V en ${etiquetaPlaca} · ${quema.pin}, que aguanta hasta ${quema.entrada.max} V: la placa se quema.`,
      };
    }
    const enRango = candidatos.filter((c) => c.v >= c.entrada.min);
    const conGnd = enRango.find((c) => fuenteCierraPorGnd(c.fuenteId));
    if (conGnd) {
      const limite = limiteMaDeFuente(conGnd.ref);
      if (limite !== undefined && limite < power.currentMa) {
        // La fuente no da la corriente que la placa pide: entra en modo CC, la tensión cae y el chip se resetea.
        return {
          ...base, ...desde(conGnd), estado: 'baja', via: 'fuente', consumeDe: conGnd.fuenteId,
          mensaje: `${conGnd.fuenteId} limita a ${limite} mA y ${etiquetaPlaca} necesita ~${power.currentMa} mA: la fuente entra en modo CC, la tensión cae y la placa no arranca. Subí el límite de corriente.`,
        };
      }
      return {
        ...base, ...desde(conGnd), estado: 'ok', via: 'fuente', consumeDe: conGnd.fuenteId,
        mensaje: `${etiquetaPlaca} alimentada por ${conGnd.fuenteId} (${conGnd.v} V en ${conGnd.pin}).`,
      };
    }
    if (enRango.length) {
      const c = enRango[0]!;
      return {
        ...base, ...desde(c), estado: 'sin-energia', via: null,
        mensaje: `${c.fuenteId} llega a ${etiquetaPlaca} · ${c.pin}, pero su GND no está unido al GND de la placa: el circuito no cierra y la placa no arranca.`,
      };
    }
    const baja = candidatos[0];
    if (baja) {
      return {
        ...base, ...desde(baja), estado: 'baja', via: 'fuente',
        mensaje: `${baja.fuenteId} entrega ${baja.v} V en ${etiquetaPlaca} · ${baja.pin}, y hacen falta al menos ${baja.entrada.min} V: la placa no arranca.`,
      };
    }
    const opciones = power.inputs.map((i) => `${i.min}–${i.max} V a ${i.pin}`).join(' o ');
    return {
      ...base, estado: 'sin-energia', via: null,
      mensaje: `${etiquetaPlaca} no tiene alimentación: prendé "USB conectado" en la placa, o cableá una Fuente regulable (${opciones}) con su GND al GND de la placa.`,
    };
  }

  /** El pin `ground` de una fuente llega al GND de la placa (sea como se llame ese pin en el módulo). */
  function fuenteCierraPorGnd(fuenteId: string): boolean {
    const inst = project.modules.find((m) => m.id === fuenteId);
    const def = inst && buscar(inst.type);
    const gnd = def?.pins.find((p) => p.kind === 'ground');
    return gnd ? llegaAGndDePlaca(`${fuenteId}.${gnd.name}`) : false;
  }

  const alimentacion = alimentacionDePlaca();
  const placaViva = alimentacion.estado === 'ok';
  /** El riel de 5 V lo genera la placa (USB, regulador desde VIN) — si entra por 5V, lo fija la fuente. */
  const generaRiel5V = placaViva && (alimentacion.via !== 'fuente' || alimentacion.entrada === 'vin');
  /** El 3V3 lo genera el regulador salvo que la fuente entre directo por 3V3. */
  const generaRiel3V3 = placaViva && alimentacion.entrada !== '3v3';

  /** Tensión fija de una referencia de la placa o de una fuente, o null si no es una fuente conocida. */
  function tensionDeRef(ref: string): number | null {
    if (/^board\.GND/.test(ref)) return V_GND;
    if (/^board\.3V3/.test(ref)) return generaRiel3V3 ? V_3V3 : null;
    if (/^board\.IOREF(_\d+)?$/.test(ref)) return placaViva ? vAlto : null;
    if (/^board\.5V(_\d+)?$/.test(ref)) return generaRiel5V ? V_5V : null;
    const fuente = tensionDeFuente(ref);
    if (fuente !== null) return fuente;
    const g = gpioDeRefPin(ref);
    // Sin alimentación el chip no corre: sus salidas no entregan nada.
    if (placaViva && g !== null && gpioDeSalida.has(g)) {
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
  if (alimentacion.estado !== 'ok') {
    avisos.push({ severidad: alimentacion.estado === 'quema' ? 'peligro' : 'advertencia', pin: -1, mensaje: alimentacion.mensaje });
  }
  for (const [net, refs] of porNet) {
    const fuentes = refs.map((r) => ({ ref: r, v: tensionDeRef(r) })).filter((f): f is { ref: string; v: number } => f.v !== null);
    const distintos = new Set(fuentes.map((f) => f.v));
    if (distintos.size > 1) {
      const [a, b] = fuentes as [{ ref: string; v: number }, { ref: string; v: number }];
      avisos.push({
        severidad: 'peligro',
        pin: gpioDeRefPin(a.ref) ?? gpioDeRefPin(b.ref) ?? -1,
        mensaje: `${nombreCorto(a.ref)} (${a.v} V) y ${nombreCorto(b.ref)} (${b.v} V) están cableados directo entre sí, sin nada de por medio: es un cortocircuito.`,
        refs: [a.ref, b.ref],
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
    if (infoOrigen.conflicto || infoOrigen.v === null || infoOrigen.v === 0) continue;
    const refsOrigen = porNet.get(netOrigen)!;
    const origenRef = refsOrigen.find((r) => tensionDeRef(r) !== null) ?? refsOrigen[0]!;
    // Magnitud de la fuente: una fuente `source` puede ser negativa, la corriente que
    // arma el camino usa su valor absoluto (no se modela la dirección de la corriente).
    const magnitudOrigen = Math.abs(infoOrigen.v);

    const pila: { net: string; ohms: number; vf: number; pines: string[]; comps: Rama['componentes']; vistos: Set<string> }[] = [
      { net: netOrigen, ohms: 0, vf: 0, pines: [origenRef], comps: [], vistos: new Set([netOrigen]) },
    ];
    while (pila.length) {
      const actual = pila.pop()!;
      const infoActual = info.get(actual.net);
      if (actual.pines.length > 1 && infoActual?.v === V_GND) {
        const refsDestino = porNet.get(actual.net)!;
        const destinoRef = refsDestino.find((r) => /^board\.GND/.test(r)) ?? refsDestino[0]!;
        const deltaV = magnitudOrigen - actual.vf;
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

  // Fuentes regulables: cuánto entrega cada una. Como una fuente de laboratorio, si la carga
  // pide más que el límite pasa a modo CC: entrega el límite y el voltaje de salida baja. Se
  // aplica ANTES de calcular los LEDs, así un LED detrás de una fuente limitada no se "quema".
  const fuentes: FuenteElectrica[] = [];
  for (const inst of project.modules) {
    const def = buscar(inst.type);
    const pinV = def?.source ? def.pins.find((p) => p.kind === 'power') : undefined;
    if (!pinV) continue;
    const ref = `${inst.id}.${pinV.name}`;
    const vAjuste = tensionDeFuente(ref) ?? 0;
    const limiteMa = limiteMaDeFuente(ref) ?? null;
    const net = netDe(ref);
    if (info.get(net)?.conflicto) {
      // Cableada directo contra otra tensión: una fuente de laboratorio entrega su límite con ~0 V.
      fuentes.push({ id: inst.id, vAjuste, limiteMa, demandaMa: null, mA: limiteMa, vSalida: 0, potenciaW: 0, modo: 'corto' });
      continue;
    }
    const propias = ramas.filter((r) => netDe(r.origenRef) === net);
    // Si alimenta la placa, también paga el consumo de la placa y lo que cuelga de sus rieles
    // y GPIO: el regulador y el chip se lo piden a esta fuente.
    const alimentaPlaca = alimentacion.consumeDe === inst.id;
    const deLaPlaca = alimentaPlaca ? ramas.filter((r) => r.origenRef.startsWith('board.') && netDe(r.origenRef) !== net) : [];
    const cargas = [...propias, ...deLaPlaca];
    const demandaMa = cargas.reduce((s, r) => s + r.amperios * 1000, 0) + (alimentaPlaca ? (alimentacion.consumoMa ?? 0) : 0);
    if (limiteMa !== null && demandaMa > limiteMa) {
      const factor = limiteMa / demandaMa;
      for (const r of cargas) r.amperios *= factor;
      // Con una sola rama el voltaje de salida es exacto (V = I·R + Vf); con varias en
      // paralelo (o la placa como carga), aproximado como si la carga fuera resistiva.
      const r0 = propias.length === 1 && !alimentaPlaca ? propias[0]! : null;
      const vMag = Math.min(Math.abs(vAjuste), r0 ? (limiteMa / 1000) * r0.ohms + r0.vf : Math.abs(vAjuste) * factor);
      const vSalida = Math.sign(vAjuste) * vMag;
      fuentes.push({ id: inst.id, vAjuste, limiteMa, demandaMa, mA: limiteMa, vSalida, potenciaW: (vMag * limiteMa) / 1000, modo: 'CC' });
      avisos.push({
        severidad: 'advertencia', pin: -1,
        mensaje: `${inst.id} está en modo CC: la carga pediría ~${demandaMa.toFixed(0)} mA y la fuente la limita a ${limiteMa} mA ` +
          `(la salida baja de ${vAjuste} V a ~${vSalida.toFixed(2)} V). Subí el límite de corriente si la carga lo necesita.`,
      });
    } else {
      fuentes.push({ id: inst.id, vAjuste, limiteMa, demandaMa, mA: demandaMa, vSalida: vAjuste, potenciaW: (Math.abs(vAjuste) * demandaMa) / 1000, modo: 'CV' });
    }
  }

  // Corriente por cada LED (suma de las ramas que lo atraviesan) y su estado.
  const mAporLed = new Map<string, number>();
  const mAFijoPorLed = new Map<string, number>(); // solo lo que no viene de un GPIO
  for (const rama of ramas) {
    const fija = gpioDeRefPin(rama.origenRef) === null;
    for (const c of rama.componentes) {
      if (c.tipo !== 'led') continue;
      mAporLed.set(c.instId, (mAporLed.get(c.instId) ?? 0) + rama.amperios * 1000);
      if (fija) mAFijoPorLed.set(c.instId, (mAFijoPorLed.get(c.instId) ?? 0) + rama.amperios * 1000);
    }
  }
  const redondear = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);
  const leds: LedElectrico[] = [...limitesLed].map(([id, lim]) => {
    const mA = mAporLed.get(id) ?? 0;
    const estado: EstadoLed = mA > lim.quemaMa ? 'se-quema' : mA > lim.maxMa ? 'sobreexigido' : 'ok';
    return { id, mA: redondear(mA), estado, mAFijo: redondear(mAFijoPorLed.get(id) ?? 0) };
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
        refs: rama.pines,
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

  return { ramas, avisos, leds, fuentes, alimentacion };
}
