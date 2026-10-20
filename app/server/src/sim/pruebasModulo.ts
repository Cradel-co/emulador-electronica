import {
  BOARD_MODULE_ID,
  lenguajesDe,
  resolverTexto,
  type ModuleInstance,
  type NivelModulo,
  type Primitiva,
  type Project,
  type PruebaModulo,
  type Wire,
} from '@emu/shared';
import type { ModuloCatalogo } from '../catalog.js';
import { analizarCircuito, type BuscarDef } from './analisis.js';
import { modeloDe } from './modelos.js';
import { erroresDeReglas } from './reglas.js';

/**
 * El módulo se prueba a sí mismo (SDD-MODULOS.md, sección 4): cada caso de su `tests.json` arma un
 * banco alrededor del módulo con piezas de fábrica (fuentes, resistencias, una sonda), lo resuelve
 * con el motor eléctrico real y compara con lo que dice la hoja de datos. Además se valida que lo
 * declarado sea coherente (el esquemático, las reglas y las pruebas nombran pines y elementos que
 * existen), y se calcula el nivel del módulo.
 */

export interface ResultadoPrueba {
  nombre: string;
  ok: boolean;
  fallas: string[];
  /** Lo que se midió (para el informe): "tension VCC:GND" → 5,0... */
  medido: Record<string, number | string | boolean>;
}

export interface InformeModulo {
  tipo: string;
  nivel: NivelModulo;
  /** Qué le falta para subir de nivel. */
  falta: string[];
  /** Incoherencias de lo declarado (un pin que no existe, un elemento mal escrito). */
  errores: string[];
  pruebas: ResultadoPrueba[];
  ok: boolean;
}

type Def = ModuloCatalogo;

function varsDe(def: Def, props: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(def.vars).map(([k, v]) => [k, v.map[String(props[v.prop])] ?? v.default]));
}

function propsDe(def: Def, extra: Record<string, string | number | boolean> = {}): Record<string, string | number | boolean> {
  const props: Record<string, string | number | boolean> = {};
  for (const [k, p] of Object.entries(def.props)) if (p.default !== undefined) props[k] = p.default;
  return { ...props, ...extra };
}

/** Lo que arma el model.js con las props por defecto: elementos y nodos internos (null si no hay modelo). */
export function circuitoDe(def: Def, props = propsDe(def)): { elementos: Set<string>; nodos: Set<string> } | null {
  if (def.programmable) return null;
  let prims: Primitiva[];
  try {
    prims = modeloDe(def).circuito({ pines: def.pins.map((p) => p.name), props, control: false, estado: {}, vars: varsDe(def, props) });
  } catch {
    return null;
  }
  const nodos = new Set<string>();
  for (const p of prims) for (const n of [p.a, p.b, ...('tierra' in p ? [p.tierra] : []), ...('cp' in p ? [p.cp, p.cn] : [])]) if (n.startsWith('int:')) nodos.add(n.slice(4));
  return { elementos: new Set(prims.map((p) => p.nombre)), nodos };
}

/** Lo declarado, contra el propio módulo. */
export function validarModulo(def: Def): string[] {
  const errores: string[] = [];
  const pines = new Set(def.pins.map((p) => p.name));
  const modelo = modeloDe(def);
  if (modelo.error) errores.push(`model.js no carga: ${modelo.error}`);
  const circ = circuitoDe(def);
  errores.push(...erroresDeReglas(def, circ?.elementos ?? null));

  const e = def.esquematico;
  if (e) {
    if (e.simbolo && !e.pines && def.pins.length) errores.push('esquematico: con `simbolo` hace falta `pines` (pin del módulo → número del símbolo).');
    for (const p of Object.keys(e.pines ?? {})) if (!pines.has(p)) errores.push(`esquematico.pines: el módulo no tiene el pin "${p}".`);
    if (e.pines) for (const p of pines) if (!(p in e.pines)) errores.push(`esquematico.pines: falta el pin "${p}" (sin número no sale en el esquemático).`);
    if (e.huella && e.conectores) errores.push('esquematico: `huella` o `conectores`, no los dos.');
    if (e.conectores) {
      const vistos = new Map<string, number>();
      for (const c of e.conectores) for (const p of c.pines) {
        if (!pines.has(p)) errores.push(`esquematico.conectores: el módulo no tiene el pin "${p}".`);
        vistos.set(p, (vistos.get(p) ?? 0) + 1);
      }
      for (const p of pines) if (!vistos.has(p)) errores.push(`esquematico.conectores: el pin "${p}" no está en ningún conector.`);
    }
    for (const [n, pieza] of (e.discreto ?? []).entries()) {
      const donde = `esquematico.discreto[${n}] (${pieza.ref} ${pieza.valor})`;
      if (pieza.elemento && circ && !circ.elementos.has(pieza.elemento)) errores.push(`${donde}: el modelo no tiene el elemento "${pieza.elemento}".`);
      for (const nodo of Object.values(pieza.nodos)) {
        if (!pines.has(nodo) && !(circ?.nodos.has(nodo))) errores.push(`${donde}: "${nodo}" no es un pin del módulo ni un nodo del modelo (${[...(circ?.nodos ?? [])].join(', ') || 'sin nodos internos'}).`);
      }
    }
  }
  const mpn = def.parte?.mpn;
  if (mpn && typeof mpn !== 'string' && !(mpn.prop in def.props)) errores.push(`parte.mpn: el módulo no tiene la prop "${mpn.prop}".`);

  for (const [n, t] of (def.pruebas ?? []).entries()) {
    const donde = `tests.json[${n}] "${t.nombre}"`;
    for (const [p, c] of Object.entries(t.banco)) {
      if (!pines.has(p)) errores.push(`${donde}: banco: el módulo no tiene el pin "${p}".`);
      if (typeof c === 'object' && 'resistencia' in c && c.a !== 'tierra' && !pines.has(c.a)) errores.push(`${donde}: banco: "${c.a}" no es un pin del módulo.`);
    }
    for (const k of Object.keys(t.espera.tension ?? {})) for (const p of k.split(':')) if (!pines.has(p)) errores.push(`${donde}: espera.tension: el módulo no tiene el pin "${p}".`);
    for (const k of [...Object.keys(t.espera.corrienteMa ?? {}), ...Object.keys(t.espera.potenciaMw ?? {})]) {
      if (circ && !circ.elementos.has(k)) errores.push(`${donde}: el modelo no tiene el elemento "${k}".`);
    }
  }
  return errores;
}

/** Nivel del módulo y qué le falta: dibujo → simula → probado → fabricable. */
export function nivelModulo(def: Def): { nivel: NivelModulo; falta: string[] } {
  const simula = Boolean(def.model || def.passthrough || def.diode || def.switch || def.source || def.chips.length || def.bridge || def.programmable);
  // Un módulo sin pines (un control remoto, un sensor inalámbrico) no tiene nada eléctrico que probar.
  const probado = (def.pruebas?.length ?? 0) > 0 || def.pins.length === 0;
  const e = def.esquematico;
  const conHuella = !!e && (e.fabricacion === 'externo' || !!e.huella || !!e.conectores);
  const falta: string[] = [];
  if (!simula) falta.push('un modelo (model.js) o un rol en la simulación');
  if (!probado) falta.push('tests.json con casos de su hoja de datos');
  if (!def.parte) falta.push('parte (fabricante, número de parte, hoja de datos)');
  if (!conHuella) falta.push('esquematico con su huella (o fabricacion "externo")');
  const nivel: NivelModulo = !simula ? 'dibujo' : !probado ? 'simula' : !def.parte || !conHuella ? 'probado' : 'fabricable';
  return { nivel, falta };
}

/** Cómo sale en el esquemático (lo declarado, o lo que la app genera para un módulo recién inventado). */
export function esquematicoEfectivo(def: Def, props: Record<string, string | number | boolean> = propsDe(def)) {
  const e = def.esquematico;
  const pinesOrden = def.pins.map((p) => p.name);
  const n = String(pinesOrden.length).padStart(2, '0');
  return {
    referencia: e?.referencia ?? (def.programmable ? 'A' : 'U'),
    valor: e?.valor ? resolverTexto(e.valor, props) : def.name,
    simbolo: e?.simbolo ?? 'caja',
    conectores: e?.conectores ?? (pinesOrden.length
      ? [{ huella: e?.huella ?? `Connector_PinHeader_2.54mm:PinHeader_1x${n}_P2.54mm_Vertical`, pines: pinesOrden }]
      : []),
    pines: e?.pines ?? Object.fromEntries(pinesOrden.map((p, i) => [p, String(i + 1)])),
    fabricacion: e?.fabricacion ?? 'modulo',
    mpn: def.parte ? resolverTexto(def.parte.mpn, props) : null,
    generico: !e?.simbolo || !(e?.huella || e?.conectores),
  };
}

/** Arma el banco de un caso: el proyecto sin placa (o con el módulo como placa) alrededor del módulo. */
function banco(def: Def, t: PruebaModulo): { project: Project; dut: string } {
  const placa = def.programmable;
  const dut = placa ? BOARD_MODULE_ID : 'dut';
  const props = propsDe(def, t.props);
  const modules: ModuleInstance[] = [];
  const wires: Wire[] = [];
  const m = (id: string, type: string, p: Record<string, string | number | boolean>) => modules.push({ id, type, x: 0, y: 0, props: p });
  // Sin placa, la tierra del circuito es el GND de la primera fuente: una de 0 V de referencia.
  if (!placa) m('ref', 'fuente-regulable', { voltage: 0, currentLimitMa: 1 });
  m(dut, def.type, props);
  const gndPlaca = def.pins.find((p) => p.kind === 'ground')?.name;
  const tierra = placa ? `${dut}.${gndPlaca ?? 'GND'}` : 'ref.GND';
  const conexiones = { ...t.banco };
  for (const k of Object.keys(t.espera.tension ?? {})) for (const p of k.split(':')) if (!(p in conexiones)) conexiones[p] = 'sonda';
  let k = 0;
  for (const [pin, c] of Object.entries(conexiones)) {
    const ref = `${dut}.${pin}`;
    if (c === 'abierto') continue;
    if (c === 'tierra') { if (ref !== tierra) wires.push({ from: ref, to: tierra }); continue; }
    const id = `b${++k}`;
    if (c === 'sonda') {
      m(id, 'resistor', { ohms: 1e7 });
      wires.push({ from: `${id}.1`, to: ref }, { from: `${id}.2`, to: tierra });
    } else if ('fuente' in c) {
      m(id, 'fuente-regulable', { voltage: c.fuente, currentLimitMa: c.limiteMa ?? 1000 });
      wires.push({ from: `${id}.V`, to: ref }, { from: `${id}.GND`, to: tierra });
    } else {
      m(id, 'resistor', { ohms: c.resistencia });
      wires.push({ from: `${id}.1`, to: ref }, { from: `${id}.2`, to: c.a === 'tierra' ? tierra : `${dut}.${c.a}` });
    }
  }
  return {
    dut,
    project: {
      schemaVersion: 1, name: `prueba-${def.type}`, board: placa ? def.type : null,
      language: placa ? (def.board ? lenguajesDe(def.board)[0] ?? 'arduino' : 'arduino') : null,
      modules, wires, sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false },
    },
  };
}

const coma = (x: number) => (Math.round(x * 1000) / 1000).toString().replace('.', ',');
const enRango = (x: number, [a, b]: [number, number]) => x >= Math.min(a, b) - 1e-9 && x <= Math.max(a, b) + 1e-9;

/** Corre un caso. `buscar` tiene que conocer al módulo y a las piezas del banco (fuente, resistencia). */
export async function correrPrueba(def: Def, t: PruebaModulo, buscar: BuscarDef): Promise<ResultadoPrueba> {
  const { project, dut } = banco(def, t);
  const fallas: string[] = [];
  const medido: ResultadoPrueba['medido'] = {};
  let r;
  try {
    r = await analizarCircuito(project, buscar, { cerrados: t.control ? new Set([dut]) : undefined });
  } catch (err) {
    return { nombre: t.nombre, ok: false, fallas: [`el motor no pudo resolver el banco: ${(err as Error).message}`], medido };
  }
  // El motor también informa fallos como resultado, sin lanzar una excepción. Sin mediciones
  // esperadas (por ejemplo, en humo), el resultado vacío no puede contar como una prueba aprobada.
  if (!r.resuelto) {
    medido.avisos = r.avisos.map(a => `${a.severidad}: ${a.mensaje}`).join(' | ');
    return {
      nombre: t.nombre, ok: false,
      fallas: [`el motor no pudo resolver el banco: ${r.avisos.map(a => a.mensaje).join(' / ') || 'sin diagnóstico'}`],
      medido,
    };
  }
  for (const [k, rango] of Object.entries(t.espera.tension ?? {})) {
    const [a, b] = k.split(':');
    const va = r.tensiones[`${dut}.${a}`];
    const vb = b === undefined ? 0 : r.tensiones[`${dut}.${b}`];
    if (va === undefined || vb === undefined) { fallas.push(`tension ${k}: no se pudo medir (¿el pin está conectado en el banco?)`); continue; }
    const v = va - vb;
    medido[`tension ${k}`] = v;
    if (!enRango(v, rango)) fallas.push(`tension ${k} = ${coma(v)} V, se esperaba entre ${coma(rango[0])} y ${coma(rango[1])} V`);
  }
  const elemento = (n: string) => r.elementos.find((e) => e.dueno === dut && e.local === n);
  for (const [n, rango] of Object.entries(t.espera.corrienteMa ?? {})) {
    const el = elemento(n);
    if (!el) { fallas.push(`corrienteMa ${n}: el modelo no tiene ese elemento`); continue; }
    const ma = Math.abs(el.i) * 1000;
    medido[`corrienteMa ${n}`] = ma;
    if (!enRango(ma, rango)) fallas.push(`corriente de ${n} = ${coma(ma)} mA, se esperaba entre ${coma(rango[0])} y ${coma(rango[1])} mA`);
  }
  for (const [n, rango] of Object.entries(t.espera.potenciaMw ?? {})) {
    const el = elemento(n);
    if (!el) { fallas.push(`potenciaMw ${n}: el modelo no tiene ese elemento`); continue; }
    const mw = Math.abs(el.p) * 1000;
    medido[`potenciaMw ${n}`] = mw;
    if (!enRango(mw, rango)) fallas.push(`potencia de ${n} = ${coma(mw)} mW, se esperaba entre ${coma(rango[0])} y ${coma(rango[1])} mW`);
  }
  const ui = (r.modulos[dut]?.ui ?? {}) as Record<string, unknown>;
  for (const [k, esperado] of Object.entries(t.espera.ui ?? {})) {
    const v = ui[k];
    medido[`ui ${k}`] = typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : String(v);
    const ok = Array.isArray(esperado) ? typeof v === 'number' && enRango(v, esperado) : typeof esperado === 'number' ? typeof v === 'number' && Math.abs(v - esperado) < 1e-6 : v === esperado;
    if (!ok) fallas.push(`ui.${k} = ${JSON.stringify(v)}, se esperaba ${JSON.stringify(esperado)}`);
  }
  const avisos = def.programmable ? r.avisos : r.avisos.filter((a) => a.mensaje.includes(`(${dut})`) || a.mensaje.startsWith(`${dut} `));
  medido.avisos = avisos.map((a) => `${a.severidad}: ${a.mensaje}`).join(' | ');
  if (t.espera.sinAvisos && avisos.length) fallas.push(`se esperaba sin avisos y hubo: ${avisos.map((a) => a.mensaje).join(' / ')}`);
  for (const esperado of t.espera.avisos ?? []) {
    const hay = avisos.some((a) => a.mensaje.includes(esperado.contiene) && (!esperado.severidad || a.severidad === esperado.severidad));
    if (!hay) fallas.push(`faltó el aviso${esperado.severidad ? ` (${esperado.severidad})` : ''} "${esperado.contiene}"; hubo: ${avisos.map((a) => a.mensaje).join(' / ') || 'ninguno'}`);
  }
  for (const el of r.elementos.filter((e) => e.dueno === dut)) {
    if (!Number.isFinite(el.i) || !Number.isFinite(el.p)) fallas.push(`el elemento ${el.local} quedó sin resolver (NaN)`);
  }
  return { nombre: t.nombre, ok: fallas.length === 0, fallas, medido };
}

/**
 * Prueba de humo que corre siempre (también sin tests.json): con 3,3 V en sus pines de
 * alimentación y GND a tierra, el modelo resuelve sin NaN.
 */
export function pruebaDeHumo(def: Def): PruebaModulo | null {
  const banco: PruebaModulo['banco'] = {};
  for (const p of def.pins) {
    if (p.kind === 'ground') banco[p.name] = 'tierra';
    else if (p.kind === 'power' && !def.source) banco[p.name] = { fuente: 3.3, limiteMa: 500 };
  }
  if (def.programmable || !Object.values(banco).some((c) => typeof c === 'object')) return null;
  return { nombre: 'humo: con 3,3 V resuelve sin NaN', control: false, banco, espera: {} };
}

/** Informe completo: validaciones, humo, cada caso del tests.json y el nivel. */
export async function probarModulo(def: Def, buscar: BuscarDef): Promise<InformeModulo> {
  const errores = validarModulo(def);
  const casos = [...(pruebaDeHumo(def) ? [pruebaDeHumo(def)!] : []), ...(def.pruebas ?? [])];
  const pruebas: ResultadoPrueba[] = [];
  for (const t of casos) pruebas.push(await correrPrueba(def, t, buscar));
  const { nivel, falta } = nivelModulo(def);
  return { tipo: def.type, nivel, falta, errores, pruebas, ok: errores.length === 0 && pruebas.every((p) => p.ok) };
}
