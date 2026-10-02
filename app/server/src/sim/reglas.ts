import type { ModuleDef, Project, Regla } from '@emu/shared';

/**
 * Las `reglas` de un module.json: límites de la hoja de datos dichos como datos, no como código.
 * Las dinámicas leen lo mismo que `observar()` (tensión de cada pin, corriente y potencia de cada
 * elemento del model.js); la estática `conectado` mira el cableado. De varias reglas que miran lo
 * mismo (dos umbrales de tensión entre VCC y GND) sale solo la más grave, como haría una persona.
 */

export interface AvisoRegla {
  severidad: 'advertencia' | 'peligro';
  mensaje: string;
}

export interface LecturaReglas {
  /** Tensión de cada pin del módulo respecto de tierra (V). */
  v: Record<string, number>;
  /** Corriente de cada elemento del model.js (A). */
  i: Record<string, number>;
  /** Potencia de cada elemento (W). */
  p: Record<string, number>;
}

const coma = (x: number, d: number) => x.toFixed(d).replace('.', ',');

function texto(r: Regla, medido: number, defecto: string): string {
  if (!r.mensaje) return defecto;
  return r.mensaje
    .replace(/\{v\}/g, coma(medido, 1))
    .replace(/\{ma\}/g, coma(medido * 1000, 0))
    .replace(/\{mw\}/g, coma(medido * 1000, 0))
    .replace(/\{w\}/g, coma(medido, 2));
}

/** Qué mira la regla (para quedarse con la más grave de las que miran lo mismo). */
function objetivo(r: Regla): string {
  switch (r.tipo) {
    case 'tensionMax':
    case 'tensionMin':
      return `${r.tipo}:${r.entre.join(':')}`;
    case 'corrienteMax':
    case 'potenciaMax':
      return `${r.tipo}:${r.elemento}`;
    case 'conectado':
      return `conectado:${r.pines.join(',')}`;
  }
}

/** Reglas dinámicas, con los valores resueltos por el motor. */
export function evaluarReglas(reglas: Regla[], l: LecturaReglas): AvisoRegla[] {
  const peor = new Map<string, AvisoRegla>();
  const poner = (r: Regla, a: AvisoRegla) => {
    const k = objetivo(r);
    const antes = peor.get(k);
    if (!antes || (antes.severidad === 'advertencia' && a.severidad === 'peligro')) peor.set(k, a);
  };
  for (const r of reglas) {
    switch (r.tipo) {
      case 'tensionMax': {
        const v = (l.v[r.entre[0]] ?? 0) - (l.v[r.entre[1]] ?? 0);
        if (v > r.max) poner(r, { severidad: r.severidad, mensaje: texto(r, v, `${r.entre.join('–')} en ${coma(v, 1)} V: el máximo de la hoja de datos es ${coma(r.max, 1)} V.`) });
        break;
      }
      case 'tensionMin': {
        const v = (l.v[r.entre[0]] ?? 0) - (l.v[r.entre[1]] ?? 0);
        if (v > r.desde && v < r.min) poner(r, { severidad: r.severidad, mensaje: texto(r, v, `${r.entre.join('–')} en ${coma(v, 1)} V: necesita al menos ${coma(r.min, 1)} V.`) });
        break;
      }
      case 'corrienteMax': {
        const i = Math.abs(l.i[r.elemento] ?? 0);
        if (i * 1000 > r.maxMa) poner(r, { severidad: r.severidad, mensaje: texto(r, i, `Por ${r.elemento} pasan ${coma(i * 1000, 0)} mA: el máximo es ${coma(r.maxMa, 0)} mA.`) });
        break;
      }
      case 'potenciaMax': {
        const p = Math.abs(l.p[r.elemento] ?? 0);
        if (p * 1000 > r.maxMw) poner(r, { severidad: r.severidad, mensaje: texto(r, p, `${r.elemento} disipa ${coma(p * 1000, 0)} mW: el máximo es ${coma(r.maxMw, 0)} mW.`) });
        break;
      }
      case 'conectado':
        break; // estática: ver reglasDeCableado
    }
  }
  return [...peor.values()];
}

/** Reglas estáticas (ERC): no hace falta simular, alcanza con los cables del proyecto. */
export function reglasDeCableado(reglas: Regla[], project: Project, id: string): AvisoRegla[] {
  const cableados = new Set<string>();
  for (const w of project.wires) for (const ref of [w.from, w.to]) if (ref.startsWith(`${id}.`)) cableados.add(ref.slice(id.length + 1));
  const avisos: AvisoRegla[] = [];
  for (const r of reglas) {
    if (r.tipo !== 'conectado') continue;
    const faltan = r.pines.filter((p) => !cableados.has(p));
    if (faltan.length) avisos.push({ severidad: r.severidad, mensaje: r.mensaje ?? `${faltan.join(', ')} sin conectar: ${faltan.length === 1 ? 'tiene' : 'tienen'} que ir cableado${faltan.length === 1 ? '' : 's'}.` });
  }
  return avisos;
}

/** Errores de una regla contra el módulo: pines o elementos que no existen. */
export function erroresDeReglas(def: ModuleDef, elementos: Set<string> | null): string[] {
  const pines = new Set(def.pins.map((p) => p.name));
  const errores: string[] = [];
  for (const [n, r] of def.reglas.entries()) {
    const donde = `reglas[${n}] (${r.tipo})`;
    if (r.tipo === 'tensionMax' || r.tipo === 'tensionMin') for (const p of r.entre) if (!pines.has(p)) errores.push(`${donde}: el módulo no tiene el pin "${p}".`);
    if (r.tipo === 'conectado') for (const p of r.pines) if (!pines.has(p)) errores.push(`${donde}: el módulo no tiene el pin "${p}".`);
    if ((r.tipo === 'corrienteMax' || r.tipo === 'potenciaMax') && elementos && !elementos.has(r.elemento)) {
      errores.push(`${donde}: el modelo no tiene un elemento "${r.elemento}" (tiene: ${[...elementos].join(', ') || 'ninguno'}).`);
    }
  }
  return errores;
}
