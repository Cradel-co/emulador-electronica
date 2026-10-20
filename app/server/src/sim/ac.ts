import { cantidadFrecuenciasAc, ParametrosAcSchema, type ComplejoAc, type ParametrosAc } from '@emu/shared';
import type { Netlist } from './netlist.js';
import { correrSpiceAc } from './spice.js';

export function transferenciaAc(entrada: readonly ComplejoAc[], salida: readonly ComplejoAc[]): { transferencia: ComplejoAc[]; gananciaDb: (number | null)[]; faseGrados: (number | null)[] } {
  if (entrada.length !== salida.length || entrada.length < 2) throw new Error('Fasores AC incompletos');
  const transferencia: ComplejoAc[] = [], gananciaDb: (number | null)[] = [], faseGrados: (number | null)[] = [];
  for (const [k, a] of entrada.entries()) {
    const b = salida[k];
    const magnitud = Math.hypot(a.real, a.imaginaria);
    if (!b || !Number.isFinite(magnitud) || magnitud < 1e-12) throw new Error('Entrada AC nula o insuficiente para calcular ganancia');
    const ar = a.real / magnitud, ai = a.imaginaria / magnitud;
    const real = (b.real * ar + b.imaginaria * ai) / magnitud;
    const imaginaria = (b.imaginaria * ar - b.real * ai) / magnitud;
    const modulo = Math.hypot(real, imaginaria);
    if (![real, imaginaria, modulo].every(Number.isFinite)) throw new Error('Transferencia AC no finita');
    transferencia.push({ real, imaginaria });
    gananciaDb.push(modulo === 0 ? null : 20 * Math.log10(modulo));
    faseGrados.push(modulo === 0 ? null : Math.atan2(imaginaria, real) * 180 / Math.PI);
  }
  return { transferencia, gananciaDb, faseGrados };
}

export async function correrAc(n: Netlist, parametros: ParametrosAc, nodoEntrada: string, nodoSalida: string) {
  ParametrosAcSchema.parse(parametros);
  const cantidad = cantidadFrecuenciasAc(parametros);
  // Este ngspice reparte los pasos logarítmicos entre ambos extremos, aun con décadas fraccionarias.
  const frecuencias = Array.from({ length: cantidad }, (_, k) => 10 ** (Math.log10(parametros.inicioHz) + k * (Math.log10(parametros.finHz) - Math.log10(parametros.inicioHz)) / (cantidad - 1)));
  const r = await correrSpiceAc(n.textoAc(parametros, nodoEntrada, nodoSalida), frecuencias);
  const tension = (nodo: string): ComplejoAc[] => {
    if (nodo === '0') return r.frecuenciaHz.map(() => ({ real: 0, imaginaria: 0 }));
    const v = r.valores.get(`v(${nodo})`.toLowerCase());
    if (!v) throw new Error(`Falta vector AC para ${nodo}`);
    return v;
  };
  const entrada = tension(nodoEntrada), salida = tension(nodoSalida);
  return { frecuenciaHz: r.frecuenciaHz, entrada, salida, ...transferenciaAc(entrada, salida), advertencias: r.errores.filter(e => /warning/i.test(e)) };
}
