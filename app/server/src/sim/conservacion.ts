import type { ElementoResuelto } from './netlist.js';

/**
 * Gate numérico de una instantánea del equivalente, DC o transitoria:
 * KCL: 1 µA + 0,1 % de corriente bruta; potencia: 1 nW + 0,1 % de potencia bruta.
 * Absorbe redondeo y fugas de regularización; no es la tolerancia del componente real.
 * En transitorio, p de C/L incluye intercambio con su energía almacenada: no es calor.
 */
export function verificarConservacionInstantanea(elementos: readonly Pick<ElementoResuelto, 'id' | 'a' | 'b' | 'va' | 'vb' | 'i' | 'p'>[]): void {
  const nodos = new Map<string, { residual: number; escala: number }>();
  let potencia = 0;
  let escalaPotencia = 0;
  for (const e of elementos) {
    if (![e.va, e.vb, e.i, e.p].every(Number.isFinite)) throw new Error(`Resultado no finito en ${e.id}`);
    for (const [nodo, signo] of [[e.a, -1], [e.b, 1]] as const) {
      const dato = nodos.get(nodo) ?? { residual: 0, escala: 0 };
      dato.residual += signo * e.i;
      dato.escala += Math.abs(e.i);
      nodos.set(nodo, dato);
    }
    potencia += e.p;
    escalaPotencia += Math.abs(e.p);
  }
  for (const [nodo, dato] of nodos) {
    if (Math.abs(dato.residual) > 1e-6 + 1e-3 * dato.escala) {
      throw new Error(`Residuo de Kirchhoff fuera de tolerancia en ${nodo}: ${dato.residual} A`);
    }
  }
  if (Math.abs(potencia) > 1e-9 + 1e-3 * escalaPotencia) {
    throw new Error(`Balance de potencia fuera de tolerancia: ${potencia} W`);
  }
}

/** Nombre conservado para los consumidores del análisis de punto de operación. */
export const verificarConservacionDc = verificarConservacionInstantanea;
