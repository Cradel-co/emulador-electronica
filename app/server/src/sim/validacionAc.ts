import type { ComplejoAc } from '@emu/shared';
import { ErrorSpice, validarDiagnosticosSpice } from './validacionSpice.js';

/** Frontera del adaptador: traduce img de ngspice y valida el barrido antes de publicarlo. */
export function extraerAcSpice(raw: unknown, errores: readonly string[], netlist: string, frecuencias: readonly number[]): { frecuenciaHz: number[]; valores: Map<string, ComplejoAc[]> } {
  validarDiagnosticosSpice(errores, netlist);
  const fallar = (m: string): never => { throw new ErrorSpice(m, [...errores], netlist); };
  const r = raw as { dataType?: unknown; data?: unknown } | undefined;
  if (r?.dataType !== 'complex' || !Array.isArray(r.data) || !r.data.length) return fallar('ngspice no devolvió AC complejo');
  if (r.data.length > 1024 || frecuencias.length * r.data.length * 2 > 1000000) return fallar('AC excede el presupuesto de valores');
  const valores = new Map<string, ComplejoAc[]>();
  for (const v of r.data) {
    if (!v || typeof v.name !== 'string' || !v.name || !Array.isArray(v.values) || v.values.length !== frecuencias.length) return fallar('Barrido AC incompleto');
    const nombre = v.name.toLowerCase();
    if (valores.has(nombre)) return fallar('Vector AC duplicado');
    const serie: ComplejoAc[] = [];
    for (const x of v.values) {
      if (!x || typeof x.real !== 'number' || typeof x.img !== 'number' || !Number.isFinite(x.real) || !Number.isFinite(x.img)) return fallar('Valor AC no finito');
      serie.push({ real: x.real, imaginaria: x.img });
    }
    valores.set(nombre, serie);
  }
  const f = valores.get('frequency');
  if (!f || f.some((v, k) => Math.abs(Math.log10(v.real) - Math.log10(frecuencias[k] ?? NaN)) > 1e-8 || v.real <= 0 || v.imaginaria !== 0)) return fallar('Barrido AC incompleto o frecuencia inválida');
  return { frecuenciaHz: f.map(v => v.real), valores };
}
