import { createHash } from 'node:crypto';
import type { ModuleDef, Observacion, Primitiva } from '@emu/shared';
import { SandboxModelo, ErrorModelo, type EntradaCircuito, type EntradaObservar } from './sandbox.js';

/**
 * El modelo eléctrico de cada tipo de módulo: el `model.js` del módulo (en su sandbox) o, si
 * no tiene, uno armado a partir de sus flags del module.json (`passthrough` + `ohmsProp`,
 * `diode`, `switch`, `source`), así los módulos importados de antes siguen andando.
 */

export interface ModeloEjecutable {
  circuito(entrada: EntradaCircuito): Primitiva[];
  observar(entrada: EntradaObservar): Observacion;
  /** Si el model.js no cargó, por qué (y se usa el de los flags). */
  error?: string;
}

type DefConCodigo = ModuleDef & { modeloCodigo?: string };

const cache = new Map<string, ModeloEjecutable>();

export function modeloDe(def: DefConCodigo): ModeloEjecutable {
  const clave = def.modeloCodigo
    ? `${def.type}:${createHash('sha1').update(def.modeloCodigo).digest('hex')}`
    : `${def.type}:flags`;
  let m = cache.get(clave);
  if (!m) {
    m = crear(def);
    cache.set(clave, m);
  }
  return m;
}

function crear(def: DefConCodigo): ModeloEjecutable {
  if (def.modeloCodigo) {
    try {
      const sb = new SandboxModelo(def.type, def.modeloCodigo);
      return { circuito: (e) => sb.circuito(e), observar: (e) => sb.observar(e) };
    } catch (err) {
      const error = (err as Error).message;
      return { ...modeloPorFlags(def), error };
    }
  }
  return modeloPorFlags(def);
}

const VT = 0.025865;

/** Modelo armado a partir de los flags del module.json (sin código propio). */
export function modeloPorFlags(def: ModuleDef): ModeloEjecutable {
  const pines = def.pins;
  const pin = (n: string) => `pin:${n}`;
  return {
    circuito(e): Primitiva[] {
      const [p1, p2] = pines;
      if (def.source) {
        const pos = pines.find((p) => p.kind === 'power');
        const neg = pines.find((p) => p.kind === 'ground');
        if (!pos || !neg || !e.control) return [];
        const v = Number(e.props[def.source.voltageProp] ?? 0);
        const prop = def.source.currentProp;
        const ma = prop ? Number(e.props[prop]) : def.electrical?.maxCurrentMa;
        const limiteA = Number.isFinite(ma) && (ma as number) > 0 ? (ma as number) / 1000 : undefined;
        return [{ tipo: 'V', nombre: 'salida', a: pin(pos.name), b: pin(neg.name), voltios: Number.isFinite(v) ? v : 0, limiteA }];
      }
      if (pines.length !== 2 || !p1 || !p2) return [];
      if (def.passthrough && def.ohmsProp) {
        const ohms = Number(e.props[def.ohmsProp]);
        if (!(ohms > 0)) return [];
        return [{ tipo: 'R', nombre: 'r', a: pin(p1.name), b: pin(p2.name), ohms }];
      }
      if (def.diode) {
        const vf = Number(e.vars.vf ?? def.diodeVfDefault ?? 2);
        const is = 0.02 / Math.exp((vf - 0.02 * 2) / (2 * VT));
        return [{ tipo: 'D', nombre: 'led', a: pin(p1.name), b: pin(p2.name), modelo: { is, n: 2, rs: 2, bv: 5, ibv: 1e-5 } }];
      }
      if (def.switch) return [{ tipo: 'S', nombre: 'contacto', a: pin(p1.name), b: pin(p2.name), cerrado: e.control }];
      return [];
    },
    observar(e): Observacion {
      if (def.diode && 'led' in e.i) {
        const mA = (e.i.led ?? 0) * 1000;
        return { ui: { on: mA > 0.5, brillo: Math.max(0, Math.min(1, mA / 20)) } };
      }
      return {};
    },
  };
}

export { ErrorModelo };
