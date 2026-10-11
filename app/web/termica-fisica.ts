import { ModeloTermicoRcSchema, type ModeloTermicoRc, type InformePrototipo } from '@emu/shared';
export const camposTermicos = [
  ['id', 'Identificador del modelo', false], ['fuente', 'Fuente de los parámetros', false], ['condiciones', 'Condiciones de aplicación', false],
  ['resistenciaKPorW', 'Resistencia térmica (K/W)', true], ['capacidadJPorK', 'Capacidad térmica (J/K)', true],
  ['ambienteC', 'Temperatura ambiente (°C)', true], ['inicialC', 'Temperatura inicial (°C)', true],
  ['minimoC', 'Rango mínimo (°C)', true], ['maximoC', 'Rango máximo (°C)', true],
] as const;
export type CampoTermico = typeof camposTermicos[number][0];
export type FormularioTermico = Record<CampoTermico, string>;
export function formularioTermicoVacio(): FormularioTermico {
  return { id: '', fuente: '', condiciones: '', resistenciaKPorW: '', capacidadJPorK: '', ambienteC: '', inicialC: '', minimoC: '', maximoC: '' };
}
export function modeloDesdeFormulario(f: FormularioTermico): ModeloTermicoRc {
  if (camposTermicos.some(([k]) => !f[k].trim())) throw new Error('Completá todos los parámetros, su fuente y condiciones.');
  const r = ModeloTermicoRcSchema.safeParse({ id: f.id, fuente: f.fuente, condiciones: f.condiciones,
    resistenciaKPorW: Number(f.resistenciaKPorW), capacidadJPorK: Number(f.capacidadJPorK),
    ambienteC: Number(f.ambienteC), inicialC: Number(f.inicialC), rangoDeclaradoC: [Number(f.minimoC), Number(f.maximoC)] });
  if (!r.success) throw new Error('Modelo térmico inválido: R y C positivas y finitas; rango creciente, ambiente e inicial dentro del rango sobre cero absoluto.');
  return r.data;
}
export function elementosTermicos(informe: InformePrototipo): string[] {
  if (!informe.observacion.resuelto || informe.observacion.estado !== 'valida') return [];
  return [...new Set(informe.observacion.mediciones.filter(m => m.validez === 'valida' && (m.tipo === 'R' || m.tipo === 'S')).map(m => `${m.modulo}.${m.elemento}`))];
}
