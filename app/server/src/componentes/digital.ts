import type { NivelDigital, PerfilDigital } from '@emu/shared';
import type { ResultadoGrafoDc } from './electrico.js';

export interface EstadoDigitalComponente {
  ruta: string[];
  estado: 'apagado' | 'reset' | 'activo';
  alimentacionVoltios: number | null;
  entradas: Record<string, NivelDigital>;
}
export interface CambioEntradaDigital {
  puerto: string; anterior: NivelDigital; actual: NivelDigital; instanteMuestraPs: bigint;
}

/** Decodifica voltajes del solver: no impone niveles ni inventa una tierra por nombre. */
export function leerEstadoDigital(perfil: PerfilDigital, ruta: readonly string[], dc: Extract<ResultadoGrafoDc, { resuelto: true }>): EstadoDigitalComponente {
  const clave = JSON.stringify(ruta);
  const terminales = dc.tensiones.filter(t => JSON.stringify(t.ruta) === clave);
  const porPuerto = new Map(terminales.map(t => [t.puerto, t.voltios]));
  const referenciados = new Set(terminales.filter(t => t.referenciada === true).map(t => t.puerto));
  const positivo = porPuerto.get(perfil.alimentacion.positivo), negativo = porPuerto.get(perfil.alimentacion.negativo);
  const vcc = typeof positivo === 'number' && typeof negativo === 'number' ? positivo - negativo : null;
  const alimentado = vcc !== null && Number.isFinite(vcc) && vcc >= perfil.alimentacion.minVoltios && vcc <= perfil.alimentacion.maxVoltios;
  const entradas: Record<string, NivelDigital> = Object.create(null) as Record<string, NivelDigital>;
  for (const [puerto, umbral] of Object.entries(perfil.entradas)) {
    const voltios = porPuerto.get(puerto);
    const relacion = referenciados.has(puerto) && alimentado && vcc !== null && typeof negativo === 'number' && typeof voltios === 'number' ? (voltios - negativo) / vcc : NaN;
    entradas[puerto] = !Number.isFinite(relacion) ? 'X'
      : relacion <= umbral.vil ? 0 : relacion >= umbral.vih ? 1 : 'X';
  }
  const reset = perfil.reset ? entradas[perfil.reset.puerto] : undefined;
  const estado = !alimentado ? 'apagado' : perfil.reset && (reset === 'X' || reset === perfil.reset.activo) ? 'reset' : 'activo';
  return { ruta: [...ruta], estado, alimentacionVoltios: vcc, entradas };
}
