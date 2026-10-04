import type { Project } from '@emu/shared';
import { armarNetlistCircuito, type BuscarDef, type OpcionesAnalisis } from './analisis.js';
import { verificarConservacionInstantanea } from './conservacion.js';
import { integrarElectrotermica, validarElectrotermica, type ModeloResistenciaElectrotermica, type ParametrosElectrotermicos, type ResultadoElectrotermico } from './electrotermica.js';
import type { Netlist } from './netlist.js';
import { correrSpice } from './spice.js';

/** Solver eléctrico real en cada etapa térmica; no reinterpreta una traza desacoplada. */
export async function analizarElectrotermicaNetlist(
  n: Netlist, modelos: Record<string, ModeloResistenciaElectrotermica>, parametros: ParametrosElectrotermicos,
  inicioPlazoMs = performance.now(),
): Promise<ResultadoElectrotermico> {
  validarElectrotermica(modelos, parametros);
  if (n.elementos.length > 128) throw new Error('El análisis electro térmico admite hasta 128 elementos eléctricos.');
  if (n.elementos.some(e => e.tipo === 'C' || e.tipo === 'L')) throw new Error('El perfil cuasiestático excluye C/L eléctricos: su dinámica necesita otro análisis.');
  for (const [id, m] of Object.entries(modelos)) {
    const el = n.elementos.find(e => e.id === id);
    if (!el || el.tipo !== 'R' || el.ohms === undefined) throw new Error(`El modelo electro térmico ${id} requiere un elemento R del proyecto.`);
    if (Math.abs(el.ohms - m.resistenciaReferenciaOhm) > 1e-12 * m.resistenciaReferenciaOhm) throw new Error(`Rref de ${id} no coincide con la resistencia nominal del proyecto.`);
  }
  return integrarElectrotermica(modelos, parametros, async resistencias => {
    for (const [id, ohms] of resistencias) n.actualizarResistencia(id, ohms);
    const resultado = await correrSpice(n.texto());
    const elementos = n.resolver(resultado);
    verificarConservacionInstantanea(elementos);
    return new Map(elementos.filter(e => resistencias.has(e.id)).map(e => [e.id, { v: e.va - e.vb, i: e.i, p: e.p }]));
  }, () => performance.now(), inicioPlazoMs);
}

export async function analizarElectrotermicaCircuito(
  proyecto: Project, buscar: BuscarDef, opciones: OpcionesAnalisis,
  modelos: Record<string, ModeloResistenciaElectrotermica>, parametros: ParametrosElectrotermicos,
): Promise<ResultadoElectrotermico> {
  const inicioPlazoMs = performance.now();
  validarElectrotermica(modelos, parametros);
  if (proyecto.modules.length > 128) throw new Error('El análisis electro térmico admite hasta 128 módulos antes del armado.');
  return analizarElectrotermicaNetlist(armarNetlistCircuito(proyecto, buscar, opciones), modelos, parametros, inicioPlazoMs);
}
