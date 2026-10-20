import { randomUUID } from 'node:crypto';
import type { Project, Primitiva, AvisoElectrico } from '@emu/shared';
import type { ReferenciaComponente } from '@emu/shared';
import { analizarCircuito } from '../sim/analisis.js';
import { CatalogoComponentes } from './catalogo.js';
import { elaborarComponente, type GrafoComponentes, type OpcionesElaboracion } from './elaboracion.js';
import { ErrorComponente } from './errores.js';
import { PaquetesComponentes, type ModuloElectricoVerificado } from './paquetes.js';

interface TensionTerminal { ruta: string[]; puerto: string; voltios: number | null }
interface ElementoJerarquico { ruta: string[]; local: string; tipo: Primitiva['tipo'] | 'X'; va: number; vb: number; i: number; p: number }
interface DiagnosticoDc extends AvisoElectrico { mensajeOriginal?: string; origenes: { ruta: string[]; puerto?: string }[] }
interface ContextoResultado { grafo: GrafoComponentes; diagnosticos: DiagnosticoDc[] }
export type ResultadoGrafoDc = ContextoResultado & (
  | { resuelto: true; tensiones: TensionTerminal[]; elementos: ElementoJerarquico[] }
  | { resuelto: false; tensiones: null; elementos: [] }
);
interface OpcionesGrafoDc extends OpcionesElaboracion { fuentesApagadas?: boolean }

/** Adapta hojas verificadas al motor DC de la app; el aplanado es temporal, nunca se persiste. */
export async function analizarGrafoDc(catalogo: CatalogoComponentes, referencia: ReferenciaComponente, paquetes: PaquetesComponentes, opciones: OpcionesGrafoDc = {}, analizar = analizarCircuito): Promise<ResultadoGrafoDc> {
  const grafo = elaborarComponente(catalogo, referencia, opciones);
  const proyecto: Project = { schemaVersion: 1, name: 'componentes-dc', board: null, language: null, modules: [], wires: [], sim: { wifiSsid: 'sin-red', wifiPassword: 'sin-red', autoReload: false } };
  const modelos = new Map<string, ModuloElectricoVerificado>();
  const tiposOrigen = new Map<string, string>();
  const referencias = new Map<string, string>();
  const rutas = new Map<string, string[]>();
  // El modelo legado puede contener variables globales. Aislar su sandbox por hoja y corrida,
  // conservando los IDs observables del grafo, evita compartirlas mediante la caché de modeloDe.
  const corrida = randomUUID().replaceAll('-', '');
  if (grafo.instancias.filter(i => i.tipo === 'hoja-legada').length > 100) throw new ErrorComponente('LIMITE', 'El piloto DC admite hasta 100 hojas (200 primitivas por hoja)');
  for (const instancia of grafo.instancias) {
    if (instancia.tipo !== 'hoja-legada') continue;
    const def = catalogo.resolver(instancia.definicion);
    let modulo: ModuloElectricoVerificado;
    try { modulo = await paquetes.verificar(def); }
    catch (error) { if (error instanceof ErrorComponente) throw new ErrorComponente(error.codigo, error.detalle, instancia.ruta); throw error; }
    if (modulo.programmable || modulo.board) throw new ErrorComponente('SIN_MODELO', 'El adaptador DC de hojas aún no ejecuta placas programables', instancia.ruta);
    if (!modulo.model && !modulo.source && !modulo.switch && !modulo.diode && !modulo.passthrough) throw new ErrorComponente('SIN_MODELO', 'La hoja no declara modelo eléctrico', instancia.ruta);
    const id = `h${proyecto.modules.length + 1}`, tipo = `h-${corrida}-${proyecto.modules.length.toString(36)}`;
    modelos.set(tipo, { ...modulo, type: tipo });
    tiposOrigen.set(tipo, modulo.type);
    rutas.set(id, [...instancia.ruta]);
    proyecto.modules.push({ id, type: tipo, x: 0, y: 0, props: { ...instancia.parametros } });
    for (const puerto of def.puertos) referencias.set(JSON.stringify([instancia.ruta, puerto.id]), `${id}.${puerto.id}`);
  }
  if (!proyecto.modules.length) throw new ErrorComponente('SIN_MODELO', 'El grafo no tiene hojas eléctricas');
  for (const red of grafo.redes) {
    if (red.dominio !== 'electrico') throw new ErrorComponente('SIN_MODELO', `Dominio no soportado por DC: ${red.dominio}`);
    const refs = red.terminales.flatMap(t => { const ref = referencias.get(t.clave); return ref ? [ref] : []; });
    const primera = refs[0];
    if (!primera) continue;
    // La autorreferencia registra también los puertos abiertos sin unirlos a otro nodo.
    for (const ref of refs.length === 1 ? refs : refs.slice(1)) proyecto.wires.push({ from: primera, to: ref });
  }
  const resultado = await analizar(proyecto, tipo => modelos.get(tipo), { fuentesApagadas: opciones.fuentesApagadas });
  const porRef = new Map<string, { ruta: string[]; puerto: string }>();
  for (const red of grafo.redes) for (const t of red.terminales) {
    const ref = referencias.get(t.clave);
    if (ref) porRef.set(ref, { ruta: [...t.ruta], puerto: t.puerto });
  }
  const diagnosticos: DiagnosticoDc[] = resultado.avisos.map(a => {
    const origenes: DiagnosticoDc['origenes'] = (a.refs ?? []).flatMap(ref => { const t = porRef.get(ref); return t ? [t] : []; });
    let mensaje = a.mensaje;
    for (const [interno, original] of tiposOrigen) mensaje = mensaje.replaceAll(interno, original);
    mensaje = mensaje.replace(/\((h\d+)\)/g, (original: string, id: string) => {
      const ruta = rutas.get(id);
      if (!ruta) return original;
      if (!origenes.some(o => JSON.stringify(o.ruta) === JSON.stringify(ruta))) origenes.push({ ruta: [...ruta] });
      return `(${JSON.stringify(ruta)})`;
    });
    return { ...a, mensaje, mensajeOriginal: a.mensaje, origenes };
  });
  const noFinitos = resultado.elementos.some(e => ![e.va, e.vb, e.i, e.p].every(Number.isFinite)) || Object.values(resultado.tensiones).some(v => !Number.isFinite(v));
  if (!resultado.resuelto || !resultado.elementos.length || noFinitos) {
    if (resultado.resuelto) diagnosticos.push({ mensaje: noFinitos ? 'El motor devolvió medidas no finitas.' : 'Sin elementos eléctricos resueltos; no se acredita una simulación vacía.', severidad: 'peligro', pin: -1, origenes: [] });
    if (!diagnosticos.length) diagnosticos.push({ mensaje: 'El motor no resolvió el circuito.', severidad: 'peligro', pin: -1, origenes: [] });
    return { resuelto: false, grafo, diagnosticos, tensiones: null, elementos: [] };
  }
  const tensiones: TensionTerminal[] = [];
  for (const red of grafo.redes) {
    const valor = red.terminales.map(t => referencias.get(t.clave)).flatMap(ref => ref && Object.hasOwn(resultado.tensiones, ref) ? [resultado.tensiones[ref]] : []).find(v => v !== undefined && Number.isFinite(v));
    for (const t of red.terminales) tensiones.push({ ruta: [...t.ruta], puerto: t.puerto, voltios: valor ?? null });
  }
  const elementos = resultado.elementos.map(e => {
    const ruta = rutas.get(e.dueno);
    if (!ruta) throw new ErrorComponente('FORMATO', `Elemento sin instancia de origen: ${e.dueno}`);
    return { ruta: [...ruta], local: e.local, tipo: e.tipo, va: e.va, vb: e.vb, i: e.i, p: e.p };
  });
  return { resuelto: true, grafo, diagnosticos, tensiones, elementos };
}
