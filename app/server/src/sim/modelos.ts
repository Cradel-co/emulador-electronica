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
  // Los modelos por flags también capturan el descriptor; importar su nueva revisión
  // con el mismo type debe invalidar el equivalente eléctrico anterior.
  const clave = createHash('sha256').update(JSON.stringify(def)).digest('hex');
  let m = cache.get(clave);
  if (!m) {
    m = crear(def);
    cache.set(clave, m);
    // Importaciones sucesivas no deben retener indefinidamente sandboxes y descriptores.
    if (cache.size > 128) {
      const antigua = cache.keys().next().value;
      if (antigua !== undefined) cache.delete(antigua);
    }
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
  function numero(valor: unknown, campo: string, positivo = false): number {
    if (typeof valor !== 'number' || !Number.isFinite(valor) || (positivo && valor <= 0)) {
      throw new ErrorModelo(`modelo de "${def.type}": ${campo} debe ser un número finito${positivo ? ' mayor que cero' : ''}`);
    }
    return valor;
  }
  return {
    circuito(e): Primitiva[] {
      const [p1, p2] = pines;
      if (def.source) {
        const pos = pines.find((p) => p.kind === 'power');
        const neg = pines.find((p) => p.kind === 'ground');
        if (!pos || !neg || !e.control) return [];
        const v = numero(e.props[def.source.voltageProp], def.source.voltageProp);
        const prop = def.source.currentProp;
        const ma = prop ? numero(e.props[prop], prop, true) : def.electrical?.maxCurrentMa;
        // Sólo un descriptor sin límite expresa una fuente ideal: un valor inválido no lo hace.
        const limiteA = ma === undefined ? undefined : numero(ma, prop ?? 'maxCurrentMa', true) / 1000;
        return [{ tipo: 'V', nombre: 'salida', a: pin(pos.name), b: pin(neg.name), voltios: v, limiteA }];
      }
      if (pines.length !== 2 || !p1 || !p2) return [];
      if (def.passthrough && def.ohmsProp) {
        const ohms = numero(e.props[def.ohmsProp], def.ohmsProp, true);
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
