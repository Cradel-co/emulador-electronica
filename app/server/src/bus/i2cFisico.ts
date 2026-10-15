import { PerfilI2cRcSchema, type PerfilI2cRc, type LineaI2cRc } from '@emu/shared';

/** NXP UM10204 rev.7, tablas de Standard/Fast/Fast-mode Plus y §7.1. */
const limites = {
  standard: { hz: 100_000, subidaS: 1e-6, subidaMinS: 0, bajadaS: 300e-9, bajoS: 4.7e-6, altoS: 4e-6, capacitanciaF: 400e-12 },
  fast: { hz: 400_000, subidaS: 300e-9, subidaMinS: 20e-9, bajadaS: 300e-9, bajoS: 1.3e-6, altoS: 0.6e-6, capacitanciaF: 400e-12 },
  'fast-plus': { hz: 1_000_000, subidaS: 120e-9, subidaMinS: 0, bajadaS: 120e-9, bajoS: 0.5e-6, altoS: 0.26e-6, capacitanciaF: 550e-12 },
} as const;

export interface MedidaLineaI2c {
  altoV: number; bajoV: number; corrienteSinkA: number;
  subidaS: number | null; bajadaS: number | null;
  hastaAltoS: number | null; hastaBajoS: number | null;
}
export interface EvaluacionI2c {
  perfil: 'i2c-rc-declarado'; apto: boolean; problemas: string[];
  lineas: Partial<Record<'sda' | 'scl', MedidaLineaI2c>>;
}
export class ErrorElectricoI2c extends Error {
  override readonly name = 'ErrorElectricoI2c';
  readonly codigo = 'ELECTRICO_I2C';
  constructor(readonly diagnostico: EvaluacionI2c) { super(`[i2c] ${diagnostico.problemas.join('; ')}`); }
}

/** Modelo concentrado RC, conductor bajo óhmico y fuga constante hacia masa. */
function medir(l: LineaI2cRc): MedidaLineaI2c | undefined {
  const rp = l.resistenciaPullupOhm;
  if (rp === null) return undefined;
  const altoV = l.tensionPullupV - rp * l.fugaA;
  const bajoV = altoV * l.resistenciaLowOhm / (rp + l.resistenciaLowOhm);
  const corrienteSinkA = (l.tensionPullupV - bajoV) / rp - l.fugaA;
  const tauSubida = rp * l.capacitanciaF;
  const tauBajada = rp * l.resistenciaLowOhm / (rp + l.resistenciaLowOhm) * l.capacitanciaF;
  const subir = (desde: number, hasta: number) => altoV > hasta && hasta >= desde
    ? tauSubida * Math.log((altoV - desde) / (altoV - hasta)) : null;
  const bajar = (desde: number, hasta: number) => bajoV < hasta && desde >= hasta
    ? tauBajada * Math.log((desde - bajoV) / (hasta - bajoV)) : null;
  const r = {
    altoV, bajoV, corrienteSinkA,
    subidaS: subir(0.3 * l.tensionPullupV, 0.7 * l.tensionPullupV),
    bajadaS: bajar(0.7 * l.tensionPullupV, 0.3 * l.tensionPullupV),
    hastaAltoS: subir(bajoV, l.vihMinV), hastaBajoS: bajar(altoV, l.vilMaxV),
  };
  if (Object.values(r).some(v => v !== null && (!Number.isFinite(v) || v < 0))) throw new Error('Equivalente I2C fuera del dominio numérico/fuga declarado');
  return r;
}

/**
 * Comprobación necesaria, no suficiente: no modela arbitraje, stretching ni cada bit.
 * La fracción de reloj describe el drive del maestro; se descuentan cruces de umbral RC.
 * https://www.nxp.com/docs/en/user-guide/UM10204.pdf
 */
export function evaluarI2cRc(entrada: PerfilI2cRc, hz: number): EvaluacionI2c {
  const p = PerfilI2cRcSchema.parse(entrada);
  if (!Number.isFinite(hz) || hz <= 0) throw new Error('Frecuencia I2C desconocida o inválida');
  const max = limites[p.modo];
  const problemas: string[] = [];
  if (hz > max.hz) problemas.push(`frecuencia ${hz} Hz supera ${max.hz} Hz del modo ${p.modo}`);
  const lineas: EvaluacionI2c['lineas'] = {};
  for (const nombre of ['sda', 'scl'] as const) {
    const l = p[nombre], r = medir(l);
    if (!r) { problemas.push(`${nombre}: falta pull-up; línea flotante`); continue; }
    lineas[nombre] = r;
    if (r.altoV < l.vihMinV) problemas.push(`${nombre}: el alto no alcanza VIH`);
    if (r.altoV > l.entradaMaxV) problemas.push(`${nombre}: sobretensión respecto del receptor`);
    if (r.bajoV > l.vilMaxV) problemas.push(`${nombre}: el bajo supera VIL`);
    if (r.corrienteSinkA > l.corrienteSinkMaxA) problemas.push(`${nombre}: corriente de hundimiento supera el límite declarado`);
    if (l.capacitanciaF > max.capacitanciaF) problemas.push(`${nombre}: capacitancia supera el perfil ${p.modo}; no se modelan extensores ni excepciones de carga`);
    if (r.subidaS === null || r.subidaS > max.subidaS) problemas.push(`${nombre}: tiempo de subida fuera de límite`);
    if (r.bajadaS === null || r.bajadaS > max.bajadaS) problemas.push(`${nombre}: tiempo de bajada fuera de límite`);
    if (r.subidaS !== null && r.subidaS < max.subidaMinS) problemas.push(`${nombre}: tiempo de subida inferior al mínimo del modo`);
    if (p.modo !== 'standard' && r.bajadaS !== null && r.bajadaS < 20e-9 * l.tensionPullupV / 5.5) problemas.push(`${nombre}: tiempo de bajada inferior al mínimo del modo`);
    if (nombre === 'scl') {
      if (r.hastaBajoS === null || p.fraccionSclBaja / hz - r.hastaBajoS < max.bajoS) problemas.push('scl: tiempo bajo insuficiente');
      if (r.hastaAltoS === null || (1 - p.fraccionSclBaja) / hz - r.hastaAltoS < max.altoS) problemas.push('scl: tiempo alto insuficiente');
    }
  }
  return { perfil: 'i2c-rc-declarado', apto: problemas.length === 0, problemas, lineas };
}
