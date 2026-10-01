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
  const nodoTierra = (tierras[0] !== undefined ? nodoDe.get(tierras[0]) : undefined) ?? [...nodoDe.values()][0];
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
        vf: vfDe(inst.props, def),
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
      // Fuente de voltaje: su pin `power` queda a la tensión configurada. El `ground` de la
      // fuente tiene que estar cableado a la tierra del circuito (fuente flotante: pendiente).
      const iPower = def.pins.findIndex((p) => p.kind === 'power');
      if (iPower === -1) continue;
      const v = Number(inst.props[def.source.voltageProp] ?? def.props[def.source.voltageProp]?.default);
      if (!Number.isFinite(v)) continue;
      const idNodo = nodoRef(iPower);
      nodos.set(idNodo, { id: idNodo, kind: 'voltage_source', params: { voltage: v } });
    }
  }

  // 4. La placa: cada GPIO que el firmware maneja es una fuente real con la resistencia
  //    interna del pin (en alto entrega corriente, en bajo la hunde). Los rieles de
  //    alimentación entran como fuentes si alguien los cableó.
  if (placa && defPlaca) {
    for (const p of defPlaca.pins) {
      const ref = `${placa.id}.${p.name}`;
      const idNodo = nodoDe.get(ref);
      if (idNodo === undefined || idNodo === nodoTierra) continue;

      const gpio = gpioDeRef(ref, desc);
      if (gpio !== null) {
        const nivel = niveles.get(gpio);
        if (nivel === undefined) continue; // Entrada o sin configurar: alta impedancia.
        branches.push(...fuenteConResistencia(`${ref}#drv`, nivel === 1 ? vAlto : 0, ohmsPin, idNodo, nodos));
        continue;
      }

      // Riel de alimentación de la placa (5V/3V3): solo si está alimentada por USB.
      if (p.kind === 'power' && placa.props['usb'] === true) {
        const v = p.name.startsWith('3V3') ? 3.3 : 5;
        branches.push(...fuenteConResistencia(`${ref}#riel`, v, ohmsRiel, idNodo, nodos));
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
