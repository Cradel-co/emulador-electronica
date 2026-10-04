import { verificarConservacionDc } from './conservacion.js';
import {
  BOARD_MODULE_ID,
  placasDelProyecto,
  corrienteRecomendada,
  nombreDePin,
  type BoardDescriptor,
  type ModuleDef,
  type Observacion,
  type Primitiva,
  type Project,
} from '@emu/shared';
import { nodosReferenciadosDc } from './conectividadDc.js';
import { NombresSpice } from './nombresSpice.js';
import { instantaneaOpcionesAnalisis } from './instantaneaOpcionesAnalisis.js';
import { gpioDe, gpioDeRef } from '../diagramOps.js';
import { Netlist, type ElementoResuelto } from './netlist.js';
import { armarPlaca, type PlacaArmada, type RielesPlaca } from './placa.js';
import { modeloDe } from './modelos.js';
import { correrSpice, ErrorSpice, type ResultadoSpice } from './spice.js';
import type { AlimentacionPlaca, AvisoElectrico, EstadoLed, FuenteElectrica, LedElectrico } from './tipos.js';

/**
 * Motor eléctrico: arma el circuito del proyecto con los modelos de sus módulos y de la placa,
 * lo resuelve con ngspice (análisis de punto de operación: Kirchhoff, Ohm, diodos reales,
 * fuentes CV/CC, reguladores) y devuelve lo que ve la UI: avisos, LEDs, fuentes, alimentación
 * de la placa, y la tensión de cada pin y la corriente/potencia de cada elemento.
 */

export type BuscarDef = (type: string) => (ModuleDef & { modeloCodigo?: string }) | undefined;

export interface OpcionesAnalisis {
  nivelesPorPlaca?: Map<string, Map<number, 0 | 1>>;
  direccionesPorPlaca?: Map<string, Map<number, DireccionPin>>;
  /** Nivel de cada GPIO que el firmware maneja como salida. Los que falten: en alto (peor caso). */
  niveles?: Map<number, 0 | 1>;
  /** Forzar todas las salidas del firmware a un nivel (0: "lo que no depende del código"). */
  salidasForzadas?: 0 | 1;
  /** En una instantánea real, un nivel que el runtime no informó no se inventa en HIGH. */
  nivelesReales?: boolean;
  /** Interruptores (`switch`) cerrados: pulsador apretado, llave encendida. */
  cerrados?: ReadonlySet<string>;
  /** Fuentes regulables con la salida apagada (proyecto sin placa sin energizar). */
  fuentesApagadas?: boolean;
  /** Estado interno de los modelos (lo que dejó `observar` la vez anterior), por id de instancia. */
  estados?: Map<string, Record<string, unknown>>;
  /**
   * Cómo configura el programa cada pin (salida, o entrada con o sin pull), leído del código.
   * Es lo que manda: en la placa real, que un pin entregue corriente o solo escuche lo decide el
   * firmware, no lo que tenga enchufado. Sin dato de un pin: si el puente informó su nivel es una
   * salida; si no, se deduce de los módulos (una salida si llega a un LED o un relé).
   */
  direcciones?: Map<number, DireccionPin>;
}

/** Configuración de un pin según el programa. */
export interface DireccionPin {
  salida: boolean;
  /** Alto libera el pad; bajo conduce a GND. */
  openDrain?: boolean;
  /** Resistencia interna que el programa activó en una entrada. */
  pull?: 'up' | 'down';
}

/** Lo que lee el programa en un pin de entrada. */
export interface EntradaLeida {
  boardId?: string;
  gpio: number;
  /** Tensión del pin (V). */
  v: number;
  /** 0 por debajo de VIL, 1 por encima de VIH; null en el medio (la placa real no garantiza nada). */
  nivel: 0 | 1 | null;
  /** Sin nada que fije su tensión (ni pull, ni algo conectado que conduzca): lee ruido. */
  flotante: boolean;
}

export interface ModuloResuelto {
  ui?: Observacion['ui'];
  estado?: Record<string, unknown>;
}

export interface AnalisisCircuito {
  /** Sólo publica medidas si el modelo, solver y validación numérica completaron. */
  resuelto: boolean;
  alimentacionesPorPlaca?: Record<string, AlimentacionPlaca>;
  avisos: AvisoElectrico[];
  leds: LedElectrico[];
  fuentes: FuenteElectrica[];
  alimentacion: AlimentacionPlaca;
  /** Tensión de cada pin cableado ("id.PIN" → V, respecto de la tierra del circuito). */
  tensiones: Record<string, number>;
  /** Pines sin ecuación eléctrica: no se publican como lecturas de cero voltios. */
  pinesSinModelo?: string[];
  /** Lo que decidió el modelo de cada módulo (estado visible, estado interno). */
  modulos: Record<string, ModuloResuelto>;
  /** Todos los elementos físicos resueltos (corriente, potencia): para verificar y para medir. */
  elementos: ElementoResuelto[];
  /** ¿El chip de la placa quedó andando? (false sin placa) */
  chipEncendido: boolean;
  /** Lo que lee el programa en cada pin cableado que no maneja como salida (con el chip andando). */
  entradas: EntradaLeida[];
}

class UnionFind {
  private padre = new Map<string, string>();
  tiene(x: string): boolean {
    return this.padre.has(x);
  }
  buscar(x: string): string {
    if (!this.padre.has(x)) this.padre.set(x, x);
    let r = x;
    while (this.padre.get(r) !== r) r = this.padre.get(r)!;
    let c = x;
    while (this.padre.get(c) !== r) {
      const s = this.padre.get(c)!;
      this.padre.set(c, r);
      c = s;
    }
    return r;
  }
  unir(a: string, b: string): void {
    const ra = this.buscar(a);
    const rb = this.buscar(b);
    if (ra !== rb) this.padre.set(ra, rb);
  }
}

/** Todo lo que no cambia entre pasadas (el dibujo, las redes, los nodos). */
interface Contexto {
  boardId: string;
  otras: Contexto[];
  project: Project;
  buscar: BuscarDef;
  opciones: OpcionesAnalisis;
  hayPlaca: boolean;
  placaDef: (ModuleDef & { modeloCodigo?: string }) | undefined;
  desc: BoardDescriptor | undefined;
  etiquetaPlaca: string;
  nodo: (ref: string) => string;
  refsDeNodo: Map<string, string[]>;
  rieles: RielesPlaca;
  gpios: Map<number, string>;
  salidas: Set<number>;
  pullups: Set<number>;
  pulldowns: Set<number>;
  instancias: { id: string; def: ModuleDef & { modeloCodigo?: string }; props: Record<string, string | number | boolean> }[];
}

function preparar(project: Project, buscar: BuscarDef, opciones: OpcionesAnalisis, boardId = placasDelProyecto(project)[0]?.id ?? BOARD_MODULE_ID, secundaria = false): Contexto {
  const placas = placasDelProyecto(project);
  const seleccionada = placas.find(p => p.id === boardId);
  const hayPlaca = Boolean(seleccionada);
  const placaDef = seleccionada ? buscar(seleccionada.board) : undefined;
  opciones = { ...opciones, niveles: opciones.nivelesPorPlaca?.get(boardId) ?? (boardId === placas[0]?.id ? opciones.niveles : undefined), direcciones: opciones.direccionesPorPlaca?.get(boardId) ?? (boardId === placas[0]?.id ? opciones.direcciones : undefined) };
  const desc = placaDef?.board;
  const uf = new UnionFind();
  for (const w of project.wires) uf.unir(w.from, w.to);

  // Rieles separados por placa; sólo los cables unen las alimentaciones.
  for (const placa of placas) {
    const def = buscar(placa.board);
    const logica5 = (def?.board?.logicVoltage ?? 3.3) >= 4.5;
    const rail = (name: string) => `#${placa.id}_${name}`;
    for (const name of ['gnd', '5v', '3v3', 'vin']) uf.buscar(rail(name));
    if (placa.id === placas[0]?.id) uf.unir(rail('gnd'), '#gnd');
    const pads = new Map<number, string>();
    for (const pin of def?.pins ?? []) {
      const ref = `${placa.id}.${pin.name}`;
      const gpio = gpioDeRef(`board.${pin.name}`, def?.board);
      if (gpio !== null) {
        const anterior = pads.get(gpio);
        if (anterior !== undefined) uf.unir(ref, anterior);
        pads.set(gpio, ref);
      }
      if (/^GND(_\d+)?$/.test(pin.name)) uf.unir(ref, rail('gnd'));
      else if (/^5V(_\d+)?$/.test(pin.name)) uf.unir(ref, rail('5v'));
      else if (/^3V3(_\d+)?$/.test(pin.name)) uf.unir(ref, rail('3v3'));
      else if (/^VIN(_\d+)?$/.test(pin.name)) uf.unir(ref, rail('vin'));
      else if (pin.name === 'IOREF') uf.unir(ref, rail(logica5 ? '5v' : '3v3'));
    }
  }

  const instancias = project.modules
    .filter((m) => !placas.some(p => p.id === m.id))
    .flatMap((m) => {
      const def = buscar(m.type);
      if (!def) return [];
      const props: Record<string, string | number | boolean> = {};
      for (const [k, p] of Object.entries(def.props)) if (p.default !== undefined) props[k] = p.default;
      Object.assign(props, m.props);
      return [{ id: m.id, def, props }];
    });

  // Sin placa, la tierra del circuito es el GND de la (primera) fuente.
  if (!hayPlaca) {
    for (const ins of instancias) {
      const gnd = ins.def.source ? ins.def.pins.find((p) => p.kind === 'ground') : undefined;
      if (gnd) {
        uf.unir(`${ins.id}.${gnd.name}`, '#gnd');
        break;
      }
    }
  }

  const tierra = uf.tiene('#gnd') ? uf.buscar('#gnd') : null;
  const nombres = new Map<string, string>();
  let k = 0;
  const nodoDeRed = (raiz: string): string => {
    if (raiz === tierra) return '0';
    let n = nombres.get(raiz);
    if (!n) {
      n = `n${++k}`;
      nombres.set(raiz, n);
    }
    return n;
  };
  const flotantes = new NombresSpice('f');
  const nodo = (ref: string): string => (uf.tiene(ref) ? nodoDeRed(uf.buscar(ref)) : flotantes.de(ref));
  for (const placa of placas) for (const rail of ['gnd', '5v', '3v3', 'vin']) nodo(`#${placa.id}_${rail}`);
  const rieles: RielesPlaca = hayPlaca
    ? { n5v: nodo(`#${boardId}_5v`), n3v3: nodo(`#${boardId}_3v3`), nvin: nodo(`#${boardId}_vin`), ngnd: nodo(`#${boardId}_gnd`) }
    : { n5v: 'p5v', n3v3: 'p3v3', nvin: 'pvin' };

  const refsDeNodo = new Map<string, string[]>();
  const vistos = new Set<string>();
  for (const w of project.wires) {
    for (const ref of [w.from, w.to]) {
      if (vistos.has(ref)) continue;
      vistos.add(ref);
      const n = nodo(ref);
      if (!refsDeNodo.has(n)) refsDeNodo.set(n, []);
      refsDeNodo.get(n)!.push(ref);
    }
  }

  // GPIO cableados, cuáles maneja el firmware como salida y cuáles lee con pull-up.
  const gpios = new Map<number, string>();
  if (hayPlaca) {
    for (const ref of vistos) {
      const g = ref.startsWith(`${boardId}.`) ? gpioDeRef(`board.${ref.slice(boardId.length + 1)}`, desc) : null;
      if (g !== null) gpios.set(g, nodo(ref));
    }
  }
  const salidas = new Set<number>();
  const pullups = new Set<number>();
  const pulldowns = new Set<number>();
  // 1. Lo que dice el programa manda (pinMode, Pin.OUT, output: de ESPHome...).
  const direcciones = opciones.direcciones ?? new Map<number, DireccionPin>();
  for (const [g, d] of direcciones) {
    if (d.salida) salidas.add(g);
    if ((!d.salida || d.openDrain) && d.pull === 'up') pullups.add(g);
    else if ((!d.salida || d.openDrain) && d.pull === 'down') pulldowns.add(g);
  }
  // 2. Sin dato del código: un pin del que el puente informó un nivel lo está manejando el firmware.
  for (const g of opciones.niveles?.keys() ?? []) if (!direcciones.has(g)) salidas.add(g);
  // 3. Si tampoco, se deduce de los módulos (como antes): una salida si llega a un LED o un relé.
  for (const ins of instancias) {
    const b = ins.def.bridge;
    if (!b || !hayPlaca) continue;
    const g = gpioDe(project, ins.id, b.pin, buscar, boardId);
    if (g === null || direcciones.has(g)) continue;
    if (b.role === 'output') salidas.add(g);
    if (b.role === 'input' && b.pull === 'up' && !salidas.has(g)) pullups.add(g);
  }

  return {
    boardId, otras: secundaria ? [] : placas.filter(p => p.id !== boardId).map(p => preparar(project, buscar, opciones, p.id, true)),
    project, buscar, opciones, hayPlaca, placaDef, desc,
    etiquetaPlaca: placaDef?.name ?? (project.board ? project.board : 'la placa'),
    nodo, refsDeNodo, rieles, gpios, salidas, pullups, pulldowns, instancias,
  };
}

interface PorModulo {
  id: string;
  def: ModuleDef & { modeloCodigo?: string };
  props: Record<string, string | number | boolean>;
  control: boolean;
  vars: Record<string, string>;
  prims: Primitiva[];
  elementos: Map<string, ElementoResuelto>;
}

interface Pasada {
  res: ResultadoSpice;
  elementos: ElementoResuelto[];
  modulos: PorModulo[];
  placa?: PlacaArmada;
  placas: Map<string, PlacaArmada>;
  avisosModelos: AvisoElectrico[];
}

function varsDe(def: ModuleDef, props: Record<string, string | number | boolean>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(def.vars ?? {})) out[k] = v.map[String(props[v.prop])] ?? v.default;
  return out;
}

async function pasada(c: Contexto, chipEncendido: boolean, propsExtra: Map<string, Record<string, number>>, apagadas: Set<string> = new Set()): Promise<Pasada> {
  for (const modulo of c.project.modules) {
    if (!c.buscar(modulo.type)) throw new Error(`No existe el modelo ${modulo.type} (${modulo.id}) en el catálogo.`);
  }
  const n = new Netlist(`proyecto ${c.project.name}`);
  const internos = new NombresSpice('i');
  const avisosModelos: AvisoElectrico[] = [];
  const modulos: PorModulo[] = [];

  for (const ins of c.instancias) {
    const { id, def } = ins;
    const props = { ...ins.props, ...(propsExtra.get(id) ?? {}) };
    const control = def.switch ? Boolean(c.opciones.cerrados?.has(id)) : def.source ? !c.opciones.fuentesApagadas : false;
    const vars = varsDe(def, props);
    const modelo = modeloDe(def);
    if (modelo.error) {
      throw new Error(`${def.name} (${id}): modelo eléctrico inválido (${modelo.error}).`);
    }
    let prims: Primitiva[] = [];
    try {
      prims = modelo.circuito({ pines: def.pins.map((p) => p.name), props, control, estado: c.opciones.estados?.get(id) ?? {}, vars });
    } catch (err) {
      throw new Error(`${def.name} (${id}): su modelo eléctrico falló (${(err as Error).message}).`);
    }
    if (!def.source && prims.some((p) => p.tipo === 'V' && !p.bateria)) {
      // Una fuente de tensión adentro de un módulo que no es una fuente crea energía de la nada
      // (la salida sigue alimentada con la entrada en 0 V). El regulador real es ctx.regulador().
      avisosModelos.push({ severidad: 'advertencia', pin: -1, mensaje: `${def.name} (${id}): su modelo usa fuenteTension sin ser una fuente; eso crea energía de la nada. Para un regulador usá ctx.regulador().` });
    }
    const mapear = (x: string): string => (x.startsWith('pin:') ? c.nodo(`${id}.${x.slice(4)}`) : internos.de(JSON.stringify([id, x])));
    for (const p of prims) {
      if (p.tipo === 'SV') n.agregar(id, { ...p, a: mapear(p.a), b: mapear(p.b), cp: mapear(p.cp), cn: mapear(p.cn) });
      else if (p.tipo === 'REG') n.agregar(id, { ...p, a: mapear(p.a), b: mapear(p.b), tierra: mapear(p.tierra) });
      else n.agregar(id, { ...p, a: mapear(p.a), b: mapear(p.b) });
    }
    modulos.push({ id, def, props, control, vars, prims, elementos: new Map() });
  }

  const placas = new Map<string, PlacaArmada>();
  for (const ctx of [c, ...c.otras]) {
    if (!ctx.hayPlaca) continue;
    const inst = ctx.project.modules.find(m => m.id === ctx.boardId);
    const usb = (inst?.props?.usb ?? ctx.placaDef?.props.usb?.default) === true;
    const niveles = new Map<number, 0 | 1>();
    for (const g of ctx.salidas) {
      const nivel = ctx.opciones.salidasForzadas ?? ctx.opciones.niveles?.get(g) ?? (ctx.opciones.nivelesReales ? undefined : 1);
      if (nivel !== undefined) niveles.set(g, nivel);
    }
    placas.set(ctx.boardId, armarPlaca(n, { id: ctx.boardId, desc: ctx.desc, rieles: ctx.rieles, usb, vinCableado: ctx.refsDeNodo.has(ctx.rieles.nvin), chipEncendido: !apagadas.has(ctx.boardId) && (ctx === c ? chipEncendido : true), openDrain: new Set([...ctx.opciones.direcciones ?? []].filter(([, d]) => d.openDrain).map(([g]) => g)), salidas: niveles, pullups: ctx.pullups, pulldowns: ctx.pulldowns, gpios: ctx.gpios }));
  }
  const placa = placas.get(c.boardId);

  const res = await correrSpice(n.texto());
  const elementos = n.resolver(res);
  verificarConservacionDc(elementos);
  for (const el of elementos) modulos.find((m) => m.id === el.dueno)?.elementos.set(el.local, el);
  return { res, elementos, modulos, placa, placas, avisosModelos };
}

const tension = (p: Pasada, nodo: string): number => Netlist.tension(p.res, nodo);
const tieneTension = (p: Pasada, nodo: string): boolean => nodo === '0' || p.res.valores.has(`v(${nodo})`);
const fmt = (x: number, d = 1): string => x.toFixed(d).replace('.', ',');

export async function analizarCircuito(project: Project, buscar: BuscarDef, opciones: OpcionesAnalisis = {}): Promise<AnalisisCircuito> {
  opciones = instantaneaOpcionesAnalisis(opciones);
  const c = preparar(project, buscar, opciones);
  let p: Pasada;
  let chipEncendido = c.hayPlaca;
  const apagadas = new Set<string>();
  const causasBrownout = new Map<string, number>();
  const avisosIniciales: AvisoElectrico[] = [];
  try {
    p = await pasada(c, chipEncendido, new Map());
    // Política DC conservadora: cada placa que cayó se mantiene en reset en esta consulta.
    // Iteración monótona (a lo sumo una incorporación por placa), no una simulación temporal
    // del oscilador de brownout. Preserva la causa antes de retirar el driver que la produjo.
    for (;;) {
      let cambio = false;
      for (const ctx of [c, ...c.otras]) {
        const placa = p.placas.get(ctx.boardId);
        if (!placa || apagadas.has(ctx.boardId)) continue;
        const v = tension(p, placa.riel) - tension(p, ctx.rieles.ngnd ?? '0');
        if (v >= placa.brownout) continue;
        avisosPlaca(ctx, { ...p, placa }, avisosIniciales, sinPlaca());
        apagadas.add(ctx.boardId);
        causasBrownout.set(ctx.boardId, v);
        cambio = true;
      }
      if (!cambio) break;
      chipEncendido = c.hayPlaca && !apagadas.has(c.boardId);
      p = await pasada(c, chipEncendido, new Map(), apagadas);
    }

  } catch (err) {
    return fallido(c, err);
  }

  const avisos: AvisoElectrico[] = [...p.avisosModelos, ...avisosIniciales];
  const modulos: Record<string, ModuloResuelto> = {};
  const tensiones: Record<string, number> = {};
  const pinesSinModelo: string[] = [];
  for (const [nodo, refs] of c.refsDeNodo) {
    if (!tieneTension(p, nodo)) { pinesSinModelo.push(...refs); continue; }
    for (const ref of refs) tensiones[ref] = tension(p, nodo);
  }
  if (pinesSinModelo.length) avisos.push({ severidad: 'advertencia', pin: -1, refs: pinesSinModelo, mensaje: `Sin modelo eléctrico de tensión para: ${pinesSinModelo.join(', ')}. No se pueden verificar sus niveles.` });

  // Cada modelo lee sus voltajes y corrientes reales.
  for (const m of p.modulos) {
    const v: Record<string, number> = {};
    for (const pin of m.def.pins) {
      const nodo = c.nodo(`${m.id}.${pin.name}`);
      if (tieneTension(p, nodo)) v[pin.name] = tension(p, nodo);
    }
    const i: Record<string, number> = {};
    const pot: Record<string, number> = {};
    for (const [local, el] of m.elementos) {
      i[local] = el.i;
      pot[local] = el.p;
    }
    let obs: Observacion = {};
    try {
      obs = modeloDe(m.def).observar({ props: m.props, control: m.control, estado: opciones.estados?.get(m.id) ?? {}, vars: m.vars, v, i, p: pot });
    } catch (err) {
      return fallido(c, new Error(`${m.def.name} (${m.id}): su modelo falló al leer el circuito (${(err as Error).message}).`));
    }
    modulos[m.id] = { ui: obs.ui, estado: obs.estado };
    for (const a of obs.avisos ?? []) avisos.push({ severidad: a.severidad, pin: -1, mensaje: `${m.def.name} (${m.id}): ${a.mensaje}` });
  }

  const leds = calcularLeds(p);
  for (const l of leds) {
    const m = p.modulos.find((x) => x.id === l.id)!;
    const lim = { max: m.def.electrical?.maxCurrentMa ?? 20, quema: m.def.electrical?.burnCurrentMa ?? 60 };
    if (l.estado === 'se-quema') {
      avisos.push({ severidad: 'peligro', pin: -1, mensaje: `Por el LED (${l.id}) circulan ~${fmt(l.mA, 0)} mA: supera el umbral de riesgo configurado (${lim.quema} mA). Puede dañarse; este modelo DC no predice temperatura ni tiempo de avería. Dimensioná una resistencia en serie según la tensión y la corriente nominal.` });
    } else if (l.estado === 'sobreexigido') {
      avisos.push({ severidad: 'advertencia', pin: -1, mensaje: `~${fmt(l.mA, 0)} mA por el LED (${l.id}): más de lo recomendado (${lim.max} mA). Hay riesgo de daño; la duración no está modelada. Poné (o subí) una resistencia en serie.` });
    }
  }

  const fuentes = await calcularFuentes(c, p, chipEncendido, avisos, apagadas);
  const alimentacionesPorPlaca: Record<string, AlimentacionPlaca> = {};
  const entradas: EntradaLeida[] = [];
  for (const ctx of [c, ...c.otras]) {
    if (!ctx.hayPlaca) continue;
    const placa = p.placas.get(ctx.boardId);
    const vista = { ...p, placa };
    const encendida = Boolean(placa && !apagadas.has(ctx.boardId) && tension(p, placa.riel) - tension(p, ctx.rieles.ngnd ?? '0') >= placa.brownout);
    const alimentacion = calcularAlimentacion(ctx, vista, encendida, fuentes);
    const caida = causasBrownout.get(ctx.boardId);
    if (caida !== undefined && alimentacion.estado !== 'quema' && alimentacion.estado !== 'sin-energia') {
      alimentacion.estado = 'baja';
      alimentacion.mensaje += ` ${ctx.etiquetaPlaca}: brownout por baja tensión (${fmt(caida, 2)} V). Se retiraron sus salidas; la tensión posterior no garantiza que pueda reiniciar con esa carga. El análisis DC no simula el ciclo de reinicio.`;
    }
    alimentacionesPorPlaca[ctx.boardId] = alimentacion;
    if (alimentacion.estado !== 'ok') avisos.unshift({ severidad: alimentacion.estado === 'quema' ? 'peligro' : 'advertencia', pin: -1, mensaje: alimentacion.mensaje });
    if (placa) avisosPlaca(ctx, vista, avisos, alimentacion);
    if (placa && encendida) entradas.push(...leerEntradas(ctx, vista, avisos));
  }
  const alimentacion = alimentacionesPorPlaca[c.boardId] ?? sinPlaca();
  return { resuelto: true, avisos, leds, fuentes, alimentacion, alimentacionesPorPlaca, tensiones, pinesSinModelo, modulos, elementos: p.elementos, chipEncendido, entradas };
}

/**
 * Lo que lee el programa en cada pin que no maneja como salida: la tensión del nodo, comparada con
 * los umbrales del chip (VIL/VIH de la hoja de datos, proporcionales a su tensión real). Entre los
 * dos la placa real no garantiza nada: se devuelve null y quien lo use mantiene lo que había
 * (política del puente, no un modelo de histéresis ni de ruido). Un pin sin nada que fije su tensión
 * (ni pull, ni algo conectado que conduzca) "flota": lee ruido, y si el programa lo usa se avisa.
 */
function leerEntradas(c: Contexto, p: Pasada, avisos: AvisoElectrico[]): EntradaLeida[] {
  const tierra = tension(p, c.rieles.ngnd ?? '0');
  const vdd = tension(p, p.placa!.riel) - tierra;
  const umbral = c.desc?.inputThresholds ?? { low: 0.25, high: 0.75 };
  const out: EntradaLeida[] = [];
  const referencias = new Set([c.rieles.ngnd ?? '0', p.placa!.riel]);
  let referenciados = nodosReferenciadosDc(p.elementos, [...referencias]);
  // Un driver de otra placa fija la entrada si sus referencias están enlazadas. No anclar
  // indiscriminadamente todos los rieles: las alimentaciones aisladas pueden flotar entre sí.
  for (let i = 0; i < p.placas.size; i++) {
    let cambio = false;
    for (const [id, placa] of p.placas) {
      const gnd = p.elementos.find(e => e.dueno === id && e.local === 'chip')?.b;
      if (gnd === undefined || !referenciados.has(gnd) || referencias.has(placa.riel)) continue;
      if (tension(p, placa.riel) - tension(p, gnd) < placa.brownout) continue;
      referencias.add(placa.riel);
      cambio = true;
    }
    if (!cambio) break;
    referenciados = nodosReferenciadosDc(p.elementos, [...referencias]);
  }
  for (const [g, nodo] of c.gpios) {
    if (c.salidas.has(g)) continue;
    const v = tension(p, nodo) - tierra;
    const nivel = v <= umbral.low * vdd ? 0 : v >= umbral.high * vdd ? 1 : null;
    // ¿Algo fija la tensión del nodo? Los diodos de protección del propio pin no (casi no conducen
    // entre los rieles), ni un interruptor abierto; un pull interno, una resistencia, una fuente, sí.
    const flotante = !referenciados.has(nodo);
    out.push({ boardId: c.boardId, gpio: g, v, nivel: flotante ? null : nivel, flotante });
    if (flotante && c.opciones.direcciones?.get(g)?.salida === false) {
      const nombre = nombreDePin(c.desc, g);
      avisos.push({
        severidad: 'advertencia', pin: g,
        mensaje: `${nombre} está flotando: el programa lo lee como entrada pero nada fija su tensión, su nivel es indeterminado. Activá el pull-up o pull-down interno, o poné una resistencia.`,
      });
    }
  }
  return out;
}

function sinPlaca(): AlimentacionPlaca {
  return { estado: 'ok', via: null, pin: null, entrada: null, fuenteId: null, v: null, consumoMa: null, consumeDe: null, mensaje: 'Proyecto sin placa: solo circuito.' };
}

/** ngspice no pudo resolver: no se inventa nada, se avisa con lo que dijo. */
function fallido(c: Contexto, err: unknown): AnalisisCircuito {
  const detalle = err instanceof ErrorSpice ? (err.errores.filter((e) => e.trim()).slice(-3).join(' · ') || err.message) : (err as Error).message;
  return {
    resuelto: false,
    avisos: [{ severidad: 'peligro', pin: -1, mensaje: `No se pudo resolver el circuito eléctrico${detalle ? `: ${detalle}` : ''}. Revisá si hay fuentes ideales en paralelo o lazos imposibles.` }],
    leds: [],
    fuentes: [],
    alimentacion: c.hayPlaca
      ? { ...sinPlaca(), estado: 'sin-energia', mensaje: 'No se pudo resolver el circuito eléctrico.' }
      : sinPlaca(),
    tensiones: {},
    modulos: {},
    elementos: [],
    chipEncendido: false,
    entradas: [],
  };
}

function calcularLeds(p: Pasada): LedElectrico[] {
  return p.modulos
    .filter((m) => m.def.diode)
    .map((m) => {
      const d = m.prims.find((x) => x.tipo === 'D');
      const el = d ? m.elementos.get(d.nombre) : undefined;
      const mA = el ? el.i * 1000 : 0;
      const max = m.def.electrical?.maxCurrentMa ?? 20;
      const quema = m.def.electrical?.burnCurrentMa ?? 60;
      // 5 % de margen: un LED de 20 mA a 20,1 mA está bien (tolerancia normal de componentes).
      const estado: EstadoLed = mA > quema ? 'se-quema' : mA > max * 1.05 ? 'sobreexigido' : 'ok';
      const r = Math.round(mA * 10) / 10;
      return { id: m.id, mA: r, estado, mAFijo: r };
    });
}

async function calcularFuentes(c: Contexto, p: Pasada, chipEncendido: boolean, avisos: AvisoElectrico[], apagadas: Set<string>): Promise<FuenteElectrica[]> {
  const out: FuenteElectrica[] = [];
  for (const m of p.modulos.filter((x) => x.def.source)) {
    const src = m.def.source!;
    const vAjuste = Number(m.props[src.voltageProp] ?? 0);
    const limiteRaw = src.currentProp ? Number(m.props[src.currentProp]) : m.def.electrical?.maxCurrentMa;
    const limiteMa = Number.isFinite(limiteRaw) && (limiteRaw as number) > 0 ? (limiteRaw as number) : null;
    const v = m.prims.find((x) => x.tipo === 'V');
    const el = v ? m.elementos.get(v.nombre) : undefined;
    if (!el || c.opciones.fuentesApagadas) {
      out.push({ id: m.id, vAjuste, limiteMa, demandaMa: 0, mA: 0, vSalida: 0, potenciaW: 0, modo: 'apagada' });
      continue;
    }
    const entregado = -el.i; // la corriente que sale por su terminal positivo
    const mA = entregado * 1000;
    const vSalida = el.va - el.vb;
    const enCC = limiteMa !== null && Math.abs(mA) >= 0.97 * limiteMa;
    const corto = enCC && Math.abs(vSalida) < Math.max(0.1, 0.05 * Math.abs(vAjuste));
    let demandaMa: number | null = Math.abs(mA);
    if (corto) demandaMa = null;
    else if (enCC && src.currentProp) {
      // ¿Cuánto pediría la carga sin límite? Misma corriente, la fuente "sin perilla".
      try {
        const sinLimite = await pasada(c, chipEncendido, new Map([[m.id, { [src.currentProp]: 1e9 }]]), apagadas);
        const el2 = sinLimite.modulos.find((x) => x.id === m.id)?.elementos.get(v!.nombre);
        demandaMa = el2 ? Math.abs(el2.i) * 1000 : null;
      } catch {
        demandaMa = null;
      }
    }
    const modo: FuenteElectrica['modo'] = corto ? 'corto' : enCC ? 'CC' : 'CV';
    out.push({ id: m.id, vAjuste, limiteMa, demandaMa, mA: Math.abs(mA), vSalida, potenciaW: Math.abs(vSalida * entregado), modo });

    const refV = `${m.id}.${m.def.pins.find((x) => x.kind === 'power')?.name ?? 'V'}`;
    const refG = `${m.id}.${m.def.pins.find((x) => x.kind === 'ground')?.name ?? 'GND'}`;
    if (corto) {
      avisos.push({
        severidad: 'peligro', pin: -1, refs: refsDelCorto(c, refV, refG),
        mensaje: `${m.id} está en cortocircuito: su salida quedó unida a su GND (o a otra tensión) sin nada que limite la corriente, y entrega todo su límite (${limiteMa} mA) con ~0 V. Revisá el cableado.`,
      });
    } else if (enCC) {
      avisos.push({
        severidad: 'advertencia', pin: -1,
        mensaje: `${m.id} está en modo CC: la carga pediría ~${demandaMa === null ? '?' : fmt(demandaMa, 0)} mA y la fuente la limita a ${limiteMa} mA (la salida baja de ${fmt(vAjuste, 2)} V a ~${fmt(vSalida, 2)} V). Subí el límite de corriente si la carga lo necesita.`,
      });
    }
  }
  return out;
}

/** Refs para dibujar un corto: dos puntas de la misma red (un cable real), o las dos del elemento. */
function refsDelCorto(c: Contexto, a: string, b: string): string[] {
  const na = c.nodo(a);
  const enRed = c.refsDeNodo.get(na) ?? [];
  if (na === c.nodo(b) && enRed.length >= 2) {
    const otro = enRed.find((r) => r !== a) ?? b;
    return [a, otro];
  }
  return [a, b];
}

function calcularAlimentacion(c: Contexto, p: Pasada, chipEncendido: boolean, fuentes: FuenteElectrica[]): AlimentacionPlaca {
  const power = c.desc?.power;
  const base = { pin: null, entrada: null, fuenteId: null, v: null, consumoMa: power?.currentMa ?? null, consumeDe: null };
  const et = c.etiquetaPlaca;
  if (!power) {
    return { ...base, estado: chipEncendido ? 'ok' : 'baja', via: 'sin-datos', mensaje: `${et}: su descriptor no dice cómo se alimenta; se asume enchufada.` };
  }
  const nodoEntrada = (feeds: 'vin' | '5v' | '3v3') => (feeds === 'vin' ? c.rieles.nvin : feeds === '5v' ? c.rieles.n5v : c.rieles.n3v3);
  // Qué fuente regulable llega a cada entrada (su salida está en ese nodo).
  const fuenteEn = (nodo: string) =>
    p.modulos.find((m) => {
      if (!m.def.source) return false;
      const pos = m.def.pins.find((x) => x.kind === 'power');
      return pos !== undefined && c.nodo(`${m.id}.${pos.name}`) === nodo && nodo !== '0';
    });
  const gndDe = (id: string) => {
    const m = p.modulos.find((x) => x.id === id)!;
    const g = m.def.pins.find((x) => x.kind === 'ground');
    return g ? c.nodo(`${id}.${g.name}`) : '';
  };

  // Violación del rango modelado: riesgo, no prueba de avería irreversible.
  for (const ent of power.inputs) {
    const nodo = nodoEntrada(ent.feeds);
    // Un VIN no cableado puede no tener elemento en el netlist. Ausencia no es 0 V.
    if (!tieneTension(p, nodo)) continue;
    const v = tension(p, nodo) - tension(p, c.rieles.ngnd ?? '0');
    if (v > ent.max + 0.05 || v < -0.3) {
      const f = fuenteEn(nodo);
      const quien = f ? f.id : 'Algo';
      return {
        ...base, estado: 'quema', via: f ? 'fuente' : null, pin: ent.pin, entrada: ent.feeds, fuenteId: f?.id ?? null, v,
        mensaje: v < 0
          ? `${quien} pone ${fmt(v, 2)} V en ${et} · ${ent.pin}: polaridad invertida y riesgo de daño. Se bloquea la ejecución fuera del rango modelado; no se predice una avería permanente.`
          : `${quien} pone ${fmt(v, 2)} V en ${et} · ${ent.pin}: supera el límite configurado de ${fmt(ent.max)} V y puede dañarla. Se bloquea la ejecución fuera del rango modelado; no se predice una avería permanente.`,
      };
    }
  }

  const inst = c.project.modules.find((m) => m.id === c.boardId);
  const usb = (inst?.props?.usb ?? c.placaDef?.props.usb?.default) === true;
  // La entrada que efectivamente la alimenta: una fuente regulable entregando en ella.
  let porFuente: { ent: (typeof power.inputs)[number]; id: string } | null = null;
  for (const ent of power.inputs) {
    const f = fuenteEn(nodoEntrada(ent.feeds));
    const fe = f && fuentes.find((x) => x.id === f.id);
    if (f && fe && fe.modo !== 'apagada') {
      porFuente = { ent, id: f.id };
      break;
    }
  }

  if (chipEncendido) {
    if (porFuente) {
      const v = tension(p, nodoEntrada(porFuente.ent.feeds)) - tension(p, c.rieles.ngnd ?? '0');
      return {
        ...base, estado: 'ok', via: 'fuente', pin: porFuente.ent.pin, entrada: porFuente.ent.feeds, fuenteId: porFuente.id, v,
        consumeDe: porFuente.id, mensaje: `${et} alimentada por ${porFuente.id} (${fmt(v, 2)} V en ${porFuente.ent.pin}).`,
      };
    }
    return { ...base, estado: 'ok', via: usb ? 'usb' : null, entrada: usb ? '5v' : null, v: tension(p, c.rieles.n5v) - tension(p, c.rieles.ngnd ?? '0'), mensaje: usb ? `${et} alimentada por USB.` : `${et} alimentada.` };
  }

  // No arranca: por qué.
  if (porFuente) {
    const f = fuentes.find((x) => x.id === porFuente!.id)!;
    const v = tension(p, nodoEntrada(porFuente.ent.feeds)) - tension(p, c.rieles.ngnd ?? '0');
    const datos = { ...base, via: 'fuente' as const, pin: porFuente.ent.pin, entrada: porFuente.ent.feeds, fuenteId: porFuente.id, v };
    if (gndDe(porFuente.id) !== (c.rieles.ngnd ?? '0')) {
      return { ...datos, estado: 'sin-energia', mensaje: `${porFuente.id} llega a ${et} · ${porFuente.ent.pin}, pero su GND no está unido al GND de la placa: el circuito no cierra y la placa no arranca.` };
    }
    if (f.modo === 'CC' || f.modo === 'corto') {
      return {
        ...datos, estado: 'baja', consumeDe: porFuente.id,
        mensaje: `${porFuente.id} limita a ${f.limiteMa} mA y ${et} necesita ~${power.currentMa} mA: la fuente entra en modo CC, la tensión cae a ${fmt(v, 2)} V y la placa no arranca (se resetea por baja tensión). Subí el límite de corriente.`,
      };
    }
    if (v < porFuente.ent.min) {
      return { ...datos, estado: 'baja', mensaje: `${porFuente.id} entrega ${fmt(v, 2)} V en ${et} · ${porFuente.ent.pin}, y hacen falta al menos ${fmt(porFuente.ent.min)} V: la placa no arranca.` };
    }
    return { ...datos, estado: 'baja', mensaje: `${et} no llega a arrancar con ${fmt(v, 2)} V en ${porFuente.ent.pin}: la tensión de su chip cae por debajo del mínimo.` };
  }
  if (usb) {
    return { ...base, estado: 'baja', via: 'usb', mensaje: `${et} está enchufada por USB pero su tensión cae por debajo del mínimo: algo le pide más de el límite USB configurado (${power.usb?.currentLimitMa ?? 500} mA).` };
  }
  const opciones = power.inputs.map((i) => `${fmt(i.min)}–${fmt(i.max)} V a ${i.pin}`).join(' o ');
  return {
    ...base, estado: 'sin-energia', via: null,
    mensaje: `${et} no tiene alimentación: prendé "USB conectado" en la placa, o cableá una Fuente regulable (${opciones}) con su GND al GND de la placa.`,
  };
}

/** Pines del microcontrolador: sobrecorriente, cortos, tensión de afuera por los diodos de protección. */
function avisosPlaca(c: Contexto, p: Pasada, avisos: AvisoElectrico[], alimentacion: AlimentacionPlaca): void {
  const desc = c.desc;
  const max = desc?.maxPinCurrentMa ?? 40;
  const recomendado = desc ? corrienteRecomendada(desc) : 20;
  const chip = desc?.chipName ?? desc?.chip ?? 'chip';
  const el = (local: string) => p.elementos.find((e) => e.dueno === c.boardId && e.local === local);
  const riel = p.placa!.riel;
  const tierra = tension(p, c.rieles.ngnd ?? '0');
  const vRiel = tension(p, riel) - tierra;

  for (const [g, nodo] of c.gpios) {
    const nombre = nombreDePin(desc, g);
    const refPin = `${c.boardId}.${nombre}`;
    const salida = el(`gpio${g}`);
    if (salida) {
      const mA = Math.abs(salida.i) * 1000;
      const vPin = tension(p, nodo) - tierra;
      const alto = salida.a === riel;
      const rating = desc?.pinCurrentRating;
      const limite = rating ? (alto ? rating.sourceMa : rating.sinkMa) : max;
      const esAbsoluto = rating?.kind !== 'typical-drive';
      // Contra la tensión opuesta, sin nada de por medio: un corto (p. ej. un GPIO en alto a GND).
      const cortocircuitoDirecto = nodo === (alto ? (c.rieles.ngnd ?? '0') : riel);
      if ((cortocircuitoDirecto && mA > 0.001) || (mA > 2 * max && Math.abs(vPin - (alto ? 0 : vRiel)) < 0.2)) {
        const otros = (c.refsDeNodo.get(nodo) ?? []).filter((r) => r !== refPin);
        avisos.push({
          severidad: 'peligro', pin: g, refs: [refPin, otros[0] ?? refPin],
          mensaje: `${nombre} en ${alto ? 'alto' : 'bajo'} está en cortocircuito contra ${alto ? 'GND' : 'la alimentación'}: tendría que manejar ~${fmt(mA, 0)} mA, la corriente depende del límite de la alimentación. La conexión puede dañar el pin y provocar brownout.`,
        });
      } else if (mA > limite) {
        avisos.push({ severidad: esAbsoluto ? 'peligro' : 'advertencia', pin: g, mensaje: esAbsoluto
          ? `${nombre} conduce ~${fmt(mA, 0)} mA: por encima del máximo del ${chip} (${limite} mA). Agregá o subí una resistencia en serie.`
          : `${nombre} conduce ~${fmt(mA, 0)} mA: supera la característica típica de ${alto ? 'entrega' : 'absorción'} (${limite} mA). No se garantiza el nivel de salida; ese valor típico no es un máximo absoluto. Revisá la carga y las condiciones de la hoja de datos.` });
      } else if (mA > recomendado) {
        avisos.push({ severidad: 'advertencia', pin: g, mensaje: `${nombre} entregaría ~${fmt(mA, 0)} mA: por encima de lo recomendado (${recomendado} mA). El funcionamiento y la vida útil no están garantizados por este modelo DC.` });
      }
    }
    // Diodos de protección conduciendo: le entra tensión de afuera al pin.
    const alto = el(`prot_alto_${g}`);
    const bajo = el(`prot_bajo_${g}`);
    const iny = Math.max(alto?.i ?? 0, bajo?.i ?? 0) * 1000;
    if (iny > 1) {
      const vPin = tension(p, nodo) - tierra;
      avisos.push({
        severidad: 'peligro', pin: g,
        mensaje: (alto?.i ?? 0) > (bajo?.i ?? 0)
          ? `A ${nombre} le llegan ${fmt(vPin, 2)} V de afuera, más que su alimentación (${fmt(vRiel, 2)} V): conducen sus diodos de protección (~${fmt(iny, 0)} mA) y puede dañarse el chip. Usá un divisor resistivo o un adaptador de nivel.`
          : `A ${nombre} le llega tensión negativa (${fmt(vPin, 2)} V): conducen sus diodos de protección (~${fmt(iny, 0)} mA) y puede dañarse el chip.`,
      });
    }
  }

  // Anda, pero con la entrada por debajo de su mínimo (p. ej. el regulador en dropout): fuera de
  // especificación, como una placa real que arranca "de casualidad" y se resetea con cualquier pico.
  const entrada = c.desc?.power?.inputs.find((i) => i.pin === alimentacion.pin);
  if (alimentacion.estado === 'ok' && entrada && alimentacion.v !== null && alimentacion.v < entrada.min) {
    avisos.push({
      severidad: 'advertencia', pin: -1,
      mensaje: `${c.etiquetaPlaca} recibe ${fmt(alimentacion.v, 2)} V en ${entrada.pin} y su mínimo es ${fmt(entrada.min)} V: arranca, pero está fuera de especificación (su regulador no llega a la tensión nominal y cualquier pico de consumo la resetea).`,
    });
  }

  // Rieles de la placa en corto (el regulador o el USB que lo alimenta entregan su límite con ~0 V).
  const ldo = el('ldo');
  const limite3v3 = (desc?.power?.regulators?.logic3v3?.currentLimitMa ?? 600) / 1000;
  const corto3v3 = ldo !== undefined && (c.rieles.n3v3 === (c.rieles.ngnd ?? '0') || Math.abs(ldo.i) > 0.95 * limite3v3) && tension(p, c.rieles.n3v3) - tierra < 0.3;
  if (corto3v3) {
    const refs = (c.refsDeNodo.get(c.rieles.n3v3) ?? []).slice(0, 2);
    avisos.push({ severidad: 'peligro', pin: -1, refs: refs.length === 2 ? refs : undefined, mensaje: `La salida 3V3 de ${c.etiquetaPlaca} está en cortocircuito: su regulador entrega todo lo que puede (~${fmt(Math.abs(ldo!.i) * 1000, 0)} mA) con ~0 V. Se recalienta. Revisá el cableado de 3V3.` });
  }
  const usb = el('usb');
  const limiteUsbMa = desc?.power?.usb?.currentLimitMa ?? 500;
  if (usb && Math.abs(usb.i) > 0.96 * limiteUsbMa / 1000) {
    const v5 = tension(p, c.rieles.n5v) - tierra;
    if (corto3v3) {
      // Es consecuencia del corto del 3V3: el USB no da abasto y su 5V también cae.
    } else if (v5 < 0.5) {
      const refs = (c.refsDeNodo.get(c.rieles.n5v) ?? []).slice(0, 2);
      avisos.push({ severidad: 'peligro', pin: -1, refs: refs.length === 2 ? refs : undefined, mensaje: `El 5V de ${c.etiquetaPlaca} está en cortocircuito: el modelo limita el USB a ${limiteUsbMa} mA con ~0 V. No se simula el disparo térmico del polifusible.` });
    } else {
      avisos.push({ severidad: 'advertencia', pin: -1, mensaje: `El USB alcanza el límite configurado (${limiteUsbMa} mA): lo que cuelga de ${c.etiquetaPlaca} pide demasiado, la tensión cae (${fmt(v5, 2)} V).` });
    }
  }
}
