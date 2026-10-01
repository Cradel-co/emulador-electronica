import { parseModuleRef, type ModuleDef, type Project } from '@emu/shared';
import { descriptorDe, gpioDeRef } from './diagramOps.js';
import type { Circuit, CircuitBranch, CircuitNode } from './solver.js';

/**
 * Traduce el circuito dibujado a una red eléctrica para el solver (solver.ts), sin
 * preguntarle a nadie "quién maneja a quién".
 *
 * La diferencia con `circuitPhysics.ts` es conceptual: aquel recorre caminos desde una
 * fuente que reconoce de antemano (un GPIO cuenta como fuente solo si llega a un módulo
 * con `bridge.role: "output"`, atravesando resistencias), así que un pulsador en el medio
 * corta el recorrido y el circuito deja de existir. Acá la topología sale de los cables y
 * el comportamiento de cada componente sale de su `module.json`:
 *
 *  - `passthrough` + `ohmsProp` → resistencia.
 *  - `diode` (+ `vars.vf`, `electrical.seriesOhm`) → diodo: el ánodo es el pin que no es `ground`.
 *  - `switch` → interruptor: cerrado une sus dos pines, abierto los separa.
 *  - `source` (+ `voltageProp`) → fuente de voltaje entre su pin `power` y su pin `ground`.
 *
 * Los GPIO de la placa entran como lo que son eléctricamente: un pin que el firmware puso
 * en alto es una fuente de `logicVoltage` con la resistencia interna del pin (`pinOutputOhm`),
 * y uno en bajo es esa misma resistencia a 0 V — o sea, **hunde** corriente. Por eso un LED
 * con el cátodo en un GPIO en bajo prende, como en el hardware de verdad.
 */

/** Estado que el firmware y la persona le imponen al circuito en este instante. */
export interface EstadoElectrico {
  /** Nivel que el firmware puso en cada GPIO que maneja como salida. */
  nivelesGpio?: ReadonlyMap<number, 0 | 1>;
  /** Interruptores cerrados ahora: pulsador apretado, llave encendida. */
  cerrados?: ReadonlySet<string>;
  /** Resistencia interna que el programa activó en cada GPIO de entrada (pull-up / pull-down). */
  pulls?: ReadonlyMap<number, 'up' | 'down'>;
}

export interface RedElectrica {
  /** La red lista para `solveMNA`. */
  circuit: Circuit;
  /** Nodo que le tocó a cada pin del dibujo ("led1.IN" → "n3"), para traducir resultados. */
  nodoDe: ReadonlyMap<string, string>;
}

/** Resistencia de un pin de salida si la placa no la declara (ESP32 con drive strength por defecto). */
const PIN_SALIDA_OHM = 33;
/** Resistencia de los rieles 3V3/5V de la placa (regulador, USB). */
const RIEL_OHM = 0.5;
/** Pull-up / pull-down interno de un GPIO (ESP32: ~45 kΩ). */
const PULL_OHM = 45_000;
/** Corriente a la que la hoja de datos da el Vf de un LED. */
const I_VF = 0.02;

class UnionFind {
  private readonly padre = new Map<string, string>();

  raiz(x: string): string {
    const p = this.padre.get(x);
    if (p === undefined) {
      this.padre.set(x, x);
      return x;
    }
    if (p === x) return x;
    const r = this.raiz(p);
    this.padre.set(x, r);
    return r;
  }

  unir(a: string, b: string): void {
    const ra = this.raiz(a);
    const rb = this.raiz(b);
    if (ra !== rb) this.padre.set(ra, rb);
  }
}

export function construirRed(project: Project, buscar: (type: string) => ModuleDef | undefined, estado: EstadoElectrico = {}): RedElectrica {
  const niveles = estado.nivelesGpio ?? new Map<number, 0 | 1>();
  const cerrados = estado.cerrados ?? new Set<string>();
  const desc = descriptorDe(project, buscar);
  const vAlto = desc?.logicVoltage ?? 3.3;
  const ohmsPin = desc?.pinOutputOhm ?? PIN_SALIDA_OHM;
  const ohmsRiel = desc?.supplyOutputOhm ?? RIEL_OHM;

  // 1. Los cables unen pines: cada grupo de pines unidos es un nodo.
  const uf = new UnionFind();
  const pines = new Set<string>();
  const anotar = (ref: string): void => { pines.add(ref); uf.raiz(ref); };
  for (const w of project.wires) {
    anotar(w.from);
    anotar(w.to);
    uf.unir(w.from, w.to);
  }
  for (const inst of project.modules) {
    const def = buscar(inst.type);
    for (const p of def?.pins ?? []) anotar(`${inst.id}.${p.name}`);
  }

  // 2. Todos los pines de tierra de la placa son el mismo cobre, estén cableados entre sí
  //    o no: GND y GND_2 de un ESP32 son el mismo plano de masa.
  const placa = project.modules.find((m) => m.id === 'board' || buscar(m.type)?.programmable);
  const defPlaca = placa && buscar(placa.type);
  const tierras = (defPlaca?.pins ?? []).filter((p) => p.kind === 'ground').map((p) => `${placa!.id}.${p.name}`);
  for (const t of tierras) {
    anotar(t);
    uf.unir(t, tierras[0]!);
  }

  const nodoDe = new Map<string, string>();
  for (const ref of pines) nodoDe.set(ref, uf.raiz(ref));

  // El nodo de referencia (0 V) es el de esas tierras. El pin "GND" de un módulo suelto es
  // solo una etiqueta del fabricante: si nadie lo cableó a la tierra de la placa, no es tierra.
  // Sin placa, la referencia es el GND de la primera fuente (como la punta negra del tester ahí).
  const gndFuente = project.modules
    .map((m) => ({ m, def: buscar(m.type) }))
    .find((x) => x.def?.source)
  const pinGndFuente = gndFuente?.def?.pins.find((p) => p.kind === 'ground');
  const refGndFuente = gndFuente && pinGndFuente ? `${gndFuente.m.id}.${pinGndFuente.name}` : undefined;
  const nodoTierra = (tierras[0] !== undefined ? nodoDe.get(tierras[0]) : undefined)
    ?? (refGndFuente !== undefined ? nodoDe.get(refGndFuente) : undefined)
    ?? [...nodoDe.values()][0];
  if (nodoTierra === undefined) return { circuit: { nodes: [{ id: 'gnd', kind: 'ground' }], branches: [] }, nodoDe };

  const nodos = new Map<string, CircuitNode>([[nodoTierra, { id: nodoTierra, kind: 'ground' }]]);
  const nodo = (id: string): void => { if (!nodos.has(id)) nodos.set(id, { id, kind: 'passive' }); };
  for (const n of nodoDe.values()) nodo(n);

  const branches: CircuitBranch[] = [];

  // 3. Cada módulo aporta su comportamiento eléctrico, declarado en su module.json.
  for (const inst of project.modules) {
    const def = buscar(inst.type);
    if (!def || def.programmable) continue;
    const refs = def.pins.map((p) => `${inst.id}.${p.name}`);
    const nodoRef = (i: number): string => nodoDe.get(refs[i]!) ?? refs[i]!;

    if (def.switch && def.pins.length === 2) {
      branches.push({ id: inst.id, kind: 'switch', closed: cerrados.has(inst.id), nodes: [nodoRef(0), nodoRef(1)] });
      continue;
    }

    if (def.diode && def.pins.length === 2) {
      // El ánodo es el pin que no es tierra; si ninguno lo es, el primero.
      const iCatodo = def.pins.findIndex((p) => p.kind === 'ground');
      const iAnodo = iCatodo === 0 ? 1 : 0;
      branches.push({
        id: inst.id,
        kind: 'diode',
        nodes: [nodoRef(iAnodo), nodoRef(iCatodo === -1 ? 1 : iCatodo)],
        // El Vf de la hoja de datos es la caída total a 20 mA: el codo del modelo va Rs·20 mA más
        // abajo, así a 20 mA cae exactamente el Vf (antes se sumaba Rs encima: 2,3 V a 20 mA).
        vf: Math.max(0, vfDe(inst.props, def) - (def.electrical?.seriesOhm ?? 0) * I_VF),
        rs: def.electrical?.seriesOhm ?? 0,
      });
      continue;
    }

    if (def.passthrough && def.ohmsProp && def.pins.length === 2) {
      const ohms = Number(inst.props[def.ohmsProp] ?? def.props[def.ohmsProp]?.default ?? 0);
      branches.push({ id: inst.id, kind: 'resistor', ohms: Number.isFinite(ohms) ? ohms : 0, nodes: [nodoRef(0), nodoRef(1)] });
      continue;
    }

    if (def.source) {
      // Fuente de laboratorio: tensión entre su pin `power` y su pin `ground` (no contra la tierra
      // del circuito: si su GND no está cableado, no cierra circuito), con su límite de corriente.
      const iPower = def.pins.findIndex((p) => p.kind === 'power');
      const iGnd = def.pins.findIndex((p) => p.kind === 'ground');
      if (iPower === -1 || iGnd === -1) continue;
      const v = Number(inst.props[def.source.voltageProp] ?? def.props[def.source.voltageProp]?.default);
      if (!Number.isFinite(v)) continue;
      const limiteMa = Number(def.source.currentProp ? inst.props[def.source.currentProp] ?? def.props[def.source.currentProp]?.default : def.electrical?.maxCurrentMa);
      branches.push({
        id: inst.id, kind: 'vsource', voltage: v, nodes: [nodoRef(iPower), nodoRef(iGnd)],
        ...(Number.isFinite(limiteMa) && limiteMa > 0 ? { limitA: limiteMa / 1000 } : {}),
      });
    }
  }

  // 4. La placa: cada GPIO que el firmware maneja es una fuente real con la resistencia
  //    interna del pin (en alto entrega corriente, en bajo la hunde). Los rieles de
  //    alimentación entran como fuentes si alguien los cableó.
  if (placa && defPlaca) {
    // ¿Tiene energía? Por USB, o una fuente cableada a su 5V o a su 3V3 (con el GND en común).
    const nodoPin = (nombre: string) => nodoDe.get(`${placa.id}.${nombre}`);
    const usb = placa.props['usb'] === true;
    const fuenteEn = (nombre: string) => {
      const n = nodoPin(nombre);
      return n !== undefined && branches.some((b) => b.kind === 'vsource' && b.nodes[0] === n && b.nodes[1] === nodoTierra);
    };
    const por5v = usb || fuenteEn('5V');
    const alimentada = por5v || fuenteEn('3V3');
    const pulls = estado.pulls ?? new Map<number, 'up' | 'down'>();
    for (const p of defPlaca.pins) {
      const ref = `${placa.id}.${p.name}`;
      const idNodo = nodoDe.get(ref);
      if (idNodo === undefined) continue;

      const gpio = gpioDeRef(ref, desc);
      if (gpio !== null) {
        // Sin energía el chip no anda: no maneja nada, aunque el firmware "lo haya puesto" en alto.
        if (!alimentada) continue;
        const nivel = niveles.get(gpio);
        if (nivel !== undefined) {
          // Salida: aunque esté cableada directo a GND (un corto), el pin entrega lo que su
          // resistencia interna deja.
          branches.push(...fuenteConResistencia(`${ref}#drv`, nivel === 1 ? vAlto : 0, ohmsPin, idNodo, nodos));
        } else if (pulls.get(gpio) === 'up') {
          branches.push(...fuenteConResistencia(`${ref}#pullup`, vAlto, PULL_OHM, idNodo, nodos));
        } else if (pulls.get(gpio) === 'down') {
          branches.push(...fuenteConResistencia(`${ref}#pulldown`, 0, PULL_OHM, idNodo, nodos));
        }
        continue; // entrada sin pull: alta impedancia
      }
      if (idNodo === nodoTierra) continue;

      // Rieles: el 5V lo da el USB; el 3V3 sale del regulador, que anda si hay 5 V (USB o fuente).
      // Si una fuente ya fija ese pin, el pin es la fuente (no se le suma otra).
      // Por nombre, como los rieles del motor ngspice: en el S3 los pines 3V3 no están marcados
      // `power` en su module.json, y por eso este riel nunca entregaba nada (ni con USB).
      const es3v3 = /^3V3(_\d+)?$/.test(p.name);
      if (es3v3 || /^5V(_\d+)?$/.test(p.name)) {
        if (es3v3 ? por5v && !fuenteEn(p.name) : usb && !fuenteEn(p.name)) {
          branches.push(...fuenteConResistencia(`${ref}#riel`, es3v3 ? 3.3 : 5, ohmsRiel, idNodo, nodos));
        }
      }
    }
  }

  return { circuit: { nodes: [...nodos.values()], branches }, nodoDe };
}

/**
 * Una fuente real no es ideal: entrega su tensión detrás de una resistencia (la del pin o
 * la del regulador). Se arma con un nodo interno fijado a `voltios` y la resistencia hasta
 * el nodo del circuito, que es lo que el solver sabe resolver.
 */
function fuenteConResistencia(id: string, voltios: number, ohms: number, destino: string, nodos: Map<string, CircuitNode>): CircuitBranch[] {
  const interno = `${id}@v`;
  nodos.set(interno, { id: interno, kind: 'voltage_source', params: { voltage: voltios } });
  return [{ id, kind: 'resistor', ohms, nodes: [interno, destino] }];
}

/** Caída directa del diodo: la del `vars.vf` que depende de una prop (el color del LED), o el valor por defecto. */
function vfDe(props: Record<string, unknown>, def: ModuleDef): number {
  const regla = def.vars['vf'];
  if (regla) {
    const clave = String(props[regla.prop] ?? def.props[regla.prop]?.default ?? '');
    const v = Number(regla.map[clave] ?? regla.default);
    if (Number.isFinite(v)) return v;
  }
  return def.diodeVfDefault;
}

export { parseModuleRef };
