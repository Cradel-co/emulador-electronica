import { firmaDiagramaElectrico, type ObservacionElectrica, type MedicionElectrica } from './electrico.js';
import { placasDelProyecto, type Project } from './project.js';
import type { ModuleDef } from './module.js';

export interface MedidaInforme extends Omit<MedicionElectrica, 'tensionV' | 'corrienteMa' | 'potenciaMw'> {
  tensionV: number | null; corrienteMa: number | null; potenciaMw: number | null;
  validez: 'valida' | 'desconocida';
}
export interface InformePrototipo {
  schemaVersion: 1; fechaUtc: string; proyecto: string; revisionProyecto: string;
  dominio: 'instantanea-dc'; unidades: { tension: 'V'; corriente: 'mA'; potencia: 'mW'; resistencia: 'ohm' };
  circuito: Pick<Project, 'modules' | 'wires'> & { placas: ReturnType<typeof placasDelProyecto>; perfiles: Pick<Project['sim'], 'i2cFisico' | 'analogicoAvr' | 'analogicoEsp'> };
  catalogo: { type: string; name: string; pins: string[]; disponible: boolean }[];
  observacion: { contexto: ObservacionElectrica['contexto']; estado: ObservacionElectrica['estado']; resuelto: boolean; energizado: boolean; placas: ObservacionElectrica['placas']; placa: ObservacionElectrica['placa']; nivelesPorPlaca: ObservacionElectrica['nivelesPorPlaca']; tensiones: Record<string, number | null>; mediciones: MedidaInforme[] };
  avisos: string[];
}
const finito = (n: number | null): number | null => n !== null && Number.isFinite(n) ? n : null;

/** Recibe el circuito completo (placas implícitas incluidas) y una lectura recién calculada. */
export function crearInforme(project: Project, lectura: ObservacionElectrica, revision: string, catalogo: readonly ModuleDef[], fechaUtc: string): InformePrototipo {
  const contextoCorrecto = lectura.contexto.proyecto === project.name && lectura.contexto.topologia === firmaDiagramaElectrico(project);
  const valida = contextoCorrecto && lectura.estado === 'valida' && lectura.resuelto;
  const estado = contextoCorrecto ? (lectura.estado === 'valida' && !lectura.resuelto ? 'no-resuelta' : lectura.estado) : 'obsoleta';
  const informe: InformePrototipo = {
    schemaVersion: 1, fechaUtc, proyecto: project.name, revisionProyecto: revision, dominio: 'instantanea-dc',
    unidades: { tension: 'V', corriente: 'mA', potencia: 'mW', resistencia: 'ohm' },
    circuito: { modules: project.modules, wires: project.wires, placas: placasDelProyecto(project),
      perfiles: { i2cFisico: project.sim.i2cFisico, analogicoAvr: project.sim.analogicoAvr, analogicoEsp: project.sim.analogicoEsp } },
    catalogo: [...new Set(project.modules.map(m => m.type))].map(type => {
      const def = catalogo.find(m => m.type === type);
      return { type, name: def?.name ?? type, pins: def?.pins.map(p => p.name) ?? [], disponible: Boolean(def) };
    }),
    observacion: { contexto: lectura.contexto, estado, resuelto: valida, energizado: valida && lectura.energizado, placas: valida ? lectura.placas : {}, placa: valida ? lectura.placa : null,
      nivelesPorPlaca: valida ? lectura.nivelesPorPlaca : {},
      tensiones: valida ? Object.fromEntries(Object.entries(lectura.tensiones).map(([k, v]) => [k, finito(v)])) : {},
      mediciones: valida ? lectura.mediciones.map(m => ({ ...m, tensionV: finito(m.tensionV), corrienteMa: finito(m.corrienteMa), potenciaMw: finito(m.potenciaMw), resistenciaOhm: finito(m.resistenciaOhm),
        validez: [m.tensionV, m.corrienteMa, m.potenciaMw].every(Number.isFinite) && (m.resistenciaOhm === null || Number.isFinite(m.resistenciaOhm)) ? 'valida' : 'desconocida' })) : [] },
    avisos: ['Instantánea del modelo eléctrico; no es una medición de hardware físico.', 'Los signos siguen la orientación interna de cada elemento: tensión Va−Vb y corriente de a hacia b.',
      ...(!valida ? ['La observación no es válida; no se exportan medidas anteriores.'] : []),
      ...(!lectura.energizado ? ['El proyecto no está energizado como circuito independiente; consultá también el estado de las placas y los niveles reportados.'] : [])],
  };
  return structuredClone(informe);
}
export const formatearMedidaInforme = (n: number | null): string => n === null || !Number.isFinite(n) ? 'Desconocida' : Number(n.toPrecision(6)).toString();

const escapar = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
const tabla = (titulos: string[], filas: unknown[][]): string => `<table><thead><tr>${titulos.map(t => `<th>${escapar(t)}</th>`).join('')}</tr></thead><tbody>${filas.map(f => `<tr>${f.map(v => `<td>${v === null ? 'Desconocida' : escapar(typeof v === 'number' ? formatearMedidaInforme(v) : v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

/** HTML autónomo: todos los datos se escapan y no se inserta código ejecutable del catálogo. */
export function informeHtml(i: InformePrototipo): string {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Informe: ${escapar(i.proyecto)}</title><style>body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:1000px;color:#17212b}table{width:100%;border-collapse:collapse;margin:1rem 0;overflow-wrap:anywhere}th,td{border:1px solid #aaa;padding:.5rem;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}h2{margin-top:2rem}@media print{body{max-width:none;margin:0}tr{break-inside:avoid}}</style><body><h1>Informe del prototipo: ${escapar(i.proyecto)}</h1><p>${escapar(i.fechaUtc)} · ${escapar(i.dominio)} · ${escapar(i.observacion.estado)}</p><p>Revisión persistida: ${escapar(i.revisionProyecto)}</p><h2>Contexto</h2><pre>${escapar(JSON.stringify(i.observacion.contexto, null, 2))}</pre><h2>Placas</h2>${tabla(['Instancia', 'Tipo', 'Lenguaje'], i.circuito.placas.map(p => [p.id, p.board, p.language]))}<h2>Medidas</h2>${tabla(['Módulo', 'Elemento', 'Tipo', 'Tensión (V)', 'Corriente (mA)', 'Potencia (mW)', 'Resistencia (ohm)', 'Validez'], i.observacion.mediciones.map(m => [m.modulo, m.elemento, m.tipo, m.tensionV, m.corrienteMa, m.potenciaMw, m.resistenciaOhm, m.validez]))}<h2>Tensiones de nodos (V)</h2>${tabla(['Nodo', 'V'], Object.entries(i.observacion.tensiones))}<h2>Instancias del circuito</h2>${tabla(['ID', 'Tipo', 'X', 'Y', 'Rotación', 'Propiedades', 'Entorno'], i.circuito.modules.map(m => [m.id, m.type, m.x, m.y, m.rotation ?? 0, JSON.stringify(m.props), JSON.stringify(m.entorno ?? {})]))}<h2>Conexiones</h2>${tabla(['Desde', 'Hasta'], i.circuito.wires.map(w => [w.from, w.to]))}<h2>Catálogo y perfiles declarados</h2><pre>${escapar(JSON.stringify({ catalogo: i.catalogo, perfiles: i.circuito.perfiles, alimentacionPlacas: i.observacion.placas, nivelesPorPlaca: i.observacion.nivelesPorPlaca }, null, 2))}</pre><h2>Alcance</h2><ul>${i.avisos.map(a => `<li>${escapar(a)}</li>`).join('')}</ul></body></html>`;
}
