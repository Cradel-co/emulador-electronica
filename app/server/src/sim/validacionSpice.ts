/** Contrato del adaptador: dato ausente o solver fallido nunca equivale a una medición cero. */
export class ErrorSpice extends Error {
  constructor(message: string, readonly errores: string[], readonly netlist: string) {
    super(message);
  }
}

/** Los avisos de gmin/source stepping pueden recuperarse; los fallos finales no. */
export function validarDiagnosticosSpice(errores: readonly string[], netlist: string): void {
  const fatales = errores.filter(e => /(?:^|\n)\s*(?:error|fatal)\s*:|simulation\s+aborted|dc\s+solution\s+failed|no\s+convergence|failed\s+to\s+converge|timestep\s+too\s+small|doAnalyses\s*:.*(?:iteration\s+limit|failed|error)/i.test(e));
  if (fatales.length) throw new ErrorSpice(`ngspice no resolvió el circuito: ${fatales.join(' · ')}`, [...errores], netlist);
}

export function valorSpice(valores: ReadonlyMap<string, number>, nombre: string, errores: readonly string[], netlist: string): number {
  const v = valores.get(nombre.toLowerCase());
  if (v === undefined) throw new ErrorSpice(`ngspice no devolvió el vector requerido ${nombre}`, [...errores], netlist);
  if (!Number.isFinite(v)) throw new ErrorSpice(`ngspice devolvió un valor no finito en ${nombre}`, [...errores], netlist);
  return v;
}

/** Extrae el último punto real y valida cada vector antes de publicar cualquier resultado. */
export function extraerValoresSpice(raw: unknown, errores: readonly string[], netlist: string): Map<string, number> {
  validarDiagnosticosSpice(errores, netlist);
  const resultado = raw as { dataType?: unknown; data?: unknown } | undefined;
  if (resultado?.dataType !== 'real' || !Array.isArray(resultado.data) || !resultado.data.length) {
    throw new ErrorSpice('ngspice no devolvió un punto de operación real', [...errores], netlist);
  }
  const valores = new Map<string, number>();
  for (const rawVector of resultado.data) {
    const vector = rawVector as { name?: unknown; values?: unknown } | null;
    if (!vector || typeof vector.name !== 'string' || !vector.name || !Array.isArray(vector.values) || !vector.values.length) {
      throw new ErrorSpice('ngspice devolvió un vector inválido', [...errores], netlist);
    }
    const v: unknown = vector.values[vector.values.length - 1];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ErrorSpice(`ngspice devolvió una muestra no finita en ${vector.name}`, [...errores], netlist);
    }
    valores.set(vector.name.toLowerCase(), v);
  }
  return valores;
}

export const MAX_VECTORES_TRANSITORIO = 1024;
export const MAX_MUESTRAS_TRANSITORIO = 50_000;
export const MAX_VALORES_TRANSITORIO = 1_000_000;

/** Acota tanto los vectores del worker como las series expandidas de la respuesta. */
export function validarCantidadValoresTransitorio(muestras: number, series: number, errores: readonly string[] = [], netlist = ''): void {
  if (muestras * series > MAX_VALORES_TRANSITORIO) {
    throw new ErrorSpice(`El transitorio excede el presupuesto de ${MAX_VALORES_TRANSITORIO} valores`, [...errores], netlist);
  }
}

/** Valida el barrido completo: nunca convierte una salida parcial en una simulación terminada. */
export function extraerSeriesSpice(raw: unknown, errores: readonly string[], netlist: string, duracionS: number): { t: number[]; valores: Map<string, number[]> } {
  validarDiagnosticosSpice(errores, netlist);
  const resultado = raw as { dataType?: unknown; data?: unknown } | undefined;
  const fallar = (mensaje: string): never => { throw new ErrorSpice(mensaje, [...errores], netlist); };
  if (resultado?.dataType !== 'real' || !Array.isArray(resultado.data) || !resultado.data.length) {
    return fallar('ngspice no devolvió un transitorio real');
  }
  if (resultado.data.length > MAX_VECTORES_TRANSITORIO) return fallar('El transitorio excedió el límite de vectores');
  const valores = new Map<string, number[]>();
  let cantidad: number | undefined;
  for (const rawVector of resultado.data) {
    const vector = rawVector as { name?: unknown; values?: unknown } | null;
    if (!vector || typeof vector.name !== 'string' || !vector.name || !Array.isArray(vector.values)) {
      return fallar('ngspice devolvió un vector transitorio inválido');
    }
    if (vector.values.length < 2 || vector.values.length > MAX_MUESTRAS_TRANSITORIO) return fallar('Cantidad de muestras transitorias fuera del límite');
    cantidad ??= vector.values.length;
    validarCantidadValoresTransitorio(cantidad, resultado.data.length, errores, netlist);
    if (vector.values.length !== cantidad) return fallar('ngspice devolvió vectores de distinta longitud');
    // for...of también recorre los huecos; Array.every los omite y aceptaría datos ausentes.
    for (const v of vector.values) if (typeof v !== 'number' || !Number.isFinite(v)) return fallar(`Muestra no finita en ${vector.name}`);
    const nombre = vector.name.toLowerCase();
    if (valores.has(nombre)) return fallar(`Vector transitorio duplicado: ${nombre}`);
    valores.set(nombre, vector.values as number[]);
  }
  const t = valores.get('time');
  if (!t) return fallar('ngspice no devolvió el vector de tiempo');
  let anterior = -1;
  for (const tiempo of t) {
    if (tiempo < 0 || tiempo <= anterior) return fallar('El tiempo transitorio no es creciente');
    anterior = tiempo;
  }
  if (Math.abs(anterior - duracionS) > Math.max(Number.MIN_VALUE, duracionS * 1e-9)) return fallar('ngspice devolvió un transitorio incompleto');
  return { t, valores };
}

/** También valida modelos internos/fallback: no todos atraviesan el sandbox de módulos. */
export function validarPrimitivaSpice(p: import('@emu/shared').Primitiva): void {
  const finito = (nombre: string, v: number): void => {
    if (!Number.isFinite(v)) throw new ErrorSpice(`Primitiva ${p.nombre}: ${nombre} debe ser finito`, [], '');
  };
  const positivo = (nombre: string, v: number): void => {
    finito(nombre, v);
    if (v <= 0) throw new ErrorSpice(`Primitiva ${p.nombre}: ${nombre} debe ser mayor que cero`, [], '');
  };
  const opcional = (nombre: string, v: number | undefined, validar = positivo): void => {
    if (v !== undefined) validar(nombre, v);
  };
  const noNegativo = (nombre: string, v: number): void => {
    finito(nombre, v);
    if (v < 0) throw new ErrorSpice(`Primitiva ${p.nombre}: ${nombre} no puede ser negativo`, [], '');
  };
  switch (p.tipo) {
    case 'R': positivo('ohms', p.ohms); break;
    case 'C': positivo('faradios', p.faradios); opcional('v0', p.v0, finito); break;
    case 'L': positivo('henrios', p.henrios); opcional('i0', p.i0, finito); break;
    case 'D':
      positivo('is', p.modelo.is); positivo('n', p.modelo.n);
      opcional('rs', p.modelo.rs, noNegativo); opcional('bv', p.modelo.bv); opcional('ibv', p.modelo.ibv);
      break;
    case 'V':
      finito('voltios', p.voltios); opcional('rSerie', p.rSerie); opcional('limiteA', p.limiteA);
      break;
    case 'I': finito('amperios', p.amperios); break;
    case 'S': opcional('ron', p.ron); opcional('roff', p.roff); break;
    case 'SV':
      finito('umbral', p.umbral); opcional('histeresis', p.histeresis, noNegativo);
      opcional('ron', p.ron); opcional('roff', p.roff);
      break;
    case 'REG':
      positivo('voltios', p.voltios); noNegativo('caida', p.caida); positivo('limiteA', p.limiteA); opcional('iq', p.iq, noNegativo);
      break;
  }
}
