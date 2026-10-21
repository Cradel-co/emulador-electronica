import { z } from 'zod';
import { SeleccionRepresentacionSchema, type SeleccionRepresentacion, type DominioEfecto, type DefinicionComponente, type PuertoComponente, type ReferenciaComponente, type ValorParametroComponente } from '@emu/shared';
import { CatalogoComponentes } from './catalogo.js';
import { ErrorComponente } from './errores.js';

export const LIMITES_ELABORACION = { profundidad: 16, instancias: 2000, terminales: 20_000, conexiones: 10_000, redes: 10_000 } as const;
type Limites = { [K in keyof typeof LIMITES_ELABORACION]: number };
type Valores = Record<string, ValorParametroComponente>;
export interface InstanciaElaborada {
  ruta: string[];
  definicion: ReferenciaComponente;
  tipo: DefinicionComponente['tipo'];
  parametros: Valores;
  representacion?: { seleccion: SeleccionRepresentacion; componente: ReferenciaComponente };
  dominiosActivos?: DominioEfecto[];
  origenRepresentacion?: { ruta: string[]; seleccion: 'equivalente' };
}
export interface TerminalElaborado extends PuertoComponente { clave: string; ruta: string[]; puerto: string }
export interface OrigenRed { ruta: string[]; conexion: string; observacion?: true; representacion?: 'equivalente' }
export interface RedElaborada {
  id: string;
  dominio: PuertoComponente['dominio'];
  ancho: number;
  terminales: TerminalElaborado[];
  origenes: OrigenRed[];
}
export interface GrafoComponentes { instancias: InstanciaElaborada[]; redes: RedElaborada[] }
const Selecciones = z.array(z.object({
  ruta: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(16),
  seleccion: SeleccionRepresentacionSchema,
}).strict()).max(2000);
export interface OpcionesElaboracion {
  parametros?: Valores; limites?: Partial<Limites>;
  representaciones?: z.infer<typeof Selecciones>;
}

const claveTerminal = (ruta: readonly string[], puerto: string): string => JSON.stringify([ruta, puerto]);
const ordenar = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const poseeDominio = (i: InstanciaElaborada, dominio: DominioEfecto): boolean => i.dominiosActivos === undefined || i.dominiosActivos.includes(dominio);

export function validarParametrosComponente(def: DefinicionComponente, valores: Valores, ruta: string[]): Valores {
  const resultado: Valores = Object.create(null) as Valores;
  for (const clave of Object.keys(valores)) {
    if (!Object.hasOwn(def.parametros, clave)) throw new ErrorComponente('PARAMETRO', `Parámetro desconocido: ${clave}`, ruta);
  }
  for (const [clave, p] of Object.entries(def.parametros)) {
    const valor = Object.hasOwn(valores, clave) ? valores[clave] : p.default;
    const valido = p.tipo === 'numero'
      ? typeof valor === 'number' && Number.isFinite(valor) && (p.min === undefined || valor >= p.min) && (p.max === undefined || valor <= p.max)
      : p.tipo === 'texto' ? typeof valor === 'string' && valor.length <= 500 && (!p.valores || p.valores.includes(valor))
        : typeof valor === 'boolean';
    if (!valido || valor === undefined) throw new ErrorComponente('PARAMETRO', `Parámetro inválido: ${clave}`, ruta);
    resultado[clave] = valor;
  }
  return resultado;
}

/** Elaboración pura de conectividad: no ejecuta hojas, solver ni firmware. */
export function elaborarComponente(catalogo: CatalogoComponentes, raiz: ReferenciaComponente, opciones: OpcionesElaboracion = {}): GrafoComponentes {
  const limites: Limites = { ...LIMITES_ELABORACION, ...opciones.limites };
  for (const [nombre, max] of Object.entries(LIMITES_ELABORACION)) {
    const valor = limites[nombre as keyof Limites];
    if (!Number.isSafeInteger(valor) || valor < 1 || valor > max) throw new ErrorComponente('LIMITE', `Límite inválido: ${nombre}`);
  }
  const validacion = Selecciones.safeParse(opciones.representaciones ?? []);
  if (!validacion.success) throw new ErrorComponente('FORMATO', 'Selección de representaciones inválida');
  const pendientes = new Map<string, SeleccionRepresentacion>();
  for (const s of validacion.data) {
    const clave = JSON.stringify(s.ruta);
    if (pendientes.has(clave)) throw new ErrorComponente('FORMATO', 'Selección duplicada', s.ruta);
    pendientes.set(clave, s.seleccion);
  }
  const instancias: InstanciaElaborada[] = [];
  const terminales = new Map<string, TerminalElaborado>();
  const padres = new Map<string, string>();
  const fisicos = new Map<string, string>();
  const conexiones: { terminal: string; origen: OrigenRed }[] = [];
  let cantidadConexiones = 0;
  const limite = (condicion: boolean, nombre: string, ruta: string[]): void => {
    if (condicion) throw new ErrorComponente('LIMITE', `Límite global de ${nombre} excedido`, ruta);
  };
  const raizDe = (mapa: Map<string, string>, clave: string): string => {
    let raiz = clave;
    for (;;) { const p = mapa.get(raiz); if (p === undefined) throw new ErrorComponente('PUERTO_AUSENTE', `Terminal ausente: ${clave}`); if (p === raiz) break; raiz = p; }
    let actual = clave;
    while (actual !== raiz) { const proximo = mapa.get(actual); mapa.set(actual, raiz); if (proximo === undefined) break; actual = proximo; }
    return raiz;
  };
  const buscar = (clave: string): string => raizDe(padres, clave);
  const unirFisicos = (a: string, b: string): void => { const x = raizDe(fisicos, a), y = raizDe(fisicos, b); if (x !== y) fisicos.set(y, x); };
  const visitar = (ref: ReferenciaComponente, ruta: string[], valores: Valores, dominios: DominioEfecto[]): void => {
    limite(ruta.length > limites.profundidad, 'profundidad', ruta);
    limite(instancias.length >= limites.instancias, 'instancias', ruta);
    let def = catalogo.resolver(ref);
    const componente = { ...ref };
    const claveSeleccion = JSON.stringify(ruta), solicitada = pendientes.get(claveSeleccion);
    let representacion: InstanciaElaborada['representacion'];
    let internos = dominios, adicional: { referencia: ReferenciaComponente; dominios: DominioEfecto[]; id: string } | undefined;
    if (def.tipo === 'compuesto' && def.representaciones) {
      const seleccion = solicitada ?? def.representaciones.predeterminada;
      pendientes.delete(claveSeleccion);
      representacion = { seleccion, componente };
      const unico = typeof seleccion === 'string' ? seleccion : seleccion.electrico === seleccion.funcional ? seleccion.electrico : undefined;
      if (unico === 'equivalente') {
        ref = def.representaciones.equivalente;
        def = catalogo.resolver(ref);
      } else if (typeof seleccion !== 'string' && unico === undefined) {
        internos = dominios.filter(d => seleccion[d] === 'interno');
        const otros = dominios.filter(d => seleccion[d] === 'equivalente');
        let id = 'equivalente', n = 0;
        while (def.instancias.some(i => i.id === id)) id = `equivalente-${++n}`;
        if (otros.length) adicional = { referencia: def.representaciones.equivalente, dominios: otros, id };
      }
    } else if (solicitada !== undefined) throw new ErrorComponente('FORMATO', 'La instancia no ofrece representaciones', ruta);
    const resueltos = validarParametrosComponente(def, valores, ruta);
    instancias.push({ ruta: [...ruta], definicion: { ...ref }, tipo: def.tipo, parametros: resueltos, ...(representacion ? { representacion } : {}),
      ...(dominios.length < 2 ? { dominiosActivos: [...dominios] } : {}) });
    for (const puerto of [...def.puertos].sort((a, b) => ordenar(a.id, b.id))) {
      limite(terminales.size >= limites.terminales, 'terminales', ruta);
      const clave = claveTerminal(ruta, puerto.id);
      terminales.set(clave, { ...puerto, clave, ruta: [...ruta], puerto: puerto.id });
      padres.set(clave, clave);
      fisicos.set(clave, clave);
    }
    if (def.tipo !== 'compuesto') return;
    for (const hijo of internos.length ? [...def.instancias].sort((a, b) => ordenar(a.id, b.id)) : []) {
      const overrides: Valores = Object.create(null) as Valores;
      const contratoHijo = catalogo.resolver(hijo.definicion);
      for (const [clave, valor] of Object.entries(hijo.parametros)) {
        if (typeof valor === 'object') {
          const origen = resueltos[valor.parametro];
          if (!Object.hasOwn(resueltos, valor.parametro) || origen === undefined) throw new ErrorComponente('PARAMETRO', `Parámetro del padre ausente: ${valor.parametro}`, [...ruta, hijo.id]);
          const padre = def.parametros[valor.parametro], destino = contratoHijo.parametros[clave];
          if (padre?.tipo === 'numero' && destino?.tipo === 'numero' && padre.unidad !== destino.unidad) {
            throw new ErrorComponente('PARAMETRO', `Unidad incompatible en el parámetro: ${clave}`, [...ruta, hijo.id]);
          }
          overrides[clave] = origen;
        } else overrides[clave] = valor;
      }
      visitar(hijo.definicion, [...ruta, hijo.id], overrides, internos);
    }
    for (const red of internos.length ? [...def.conexiones].sort((a, b) => ordenar(a.id, b.id)) : []) {
      limite(++cantidadConexiones > limites.conexiones, 'conexiones', ruta);
      const puntos = red.terminales.map(t => {
        const camino = t.tipo === 'externo' ? ruta : [...ruta, t.instancia];
        const punto = terminales.get(claveTerminal(camino, t.puerto));
        if (!punto) throw new ErrorComponente('PUERTO_AUSENTE', `Puerto ausente: ${t.puerto}`, camino);
        return punto;
      });
      const primero = puntos[0];
      if (!primero) throw new ErrorComponente('FORMATO', 'Red sin terminales', ruta);
      for (const p of puntos) {
        if (p.dominio !== primero.dominio) throw new ErrorComponente('DOMINIO_INCOMPATIBLE', `Dominio incompatible en ${red.id}`, ruta);
        if (p.ancho !== primero.ancho) throw new ErrorComponente('ANCHO_INCOMPATIBLE', `Ancho incompatible en ${red.id}`, ruta);
        if (primero.dominio !== 'electrico' && !internos.includes('funcional')) continue;
        const a = buscar(primero.clave), b = buscar(p.clave);
        if (a !== b) padres.set(b, a);
        if (primero.dominio === 'electrico' && internos.includes('electrico')) unirFisicos(primero.clave, p.clave);
      }
      if (primero.dominio === 'electrico' || internos.includes('funcional')) conexiones.push({ terminal: primero.clave,
        origen: { ruta: [...ruta], conexion: red.id, ...(primero.dominio === 'electrico' && !internos.includes('electrico') ? { observacion: true as const } : {}) } });
    }
    if (adicional) {
      const inicio = instancias.length, camino = [...ruta, adicional.id];
      visitar(adicional.referencia, camino, resueltos, adicional.dominios);
      const extra = instancias[inicio];
      if (extra) extra.origenRepresentacion = { ruta: [...ruta], seleccion: 'equivalente' };
      for (const puerto of def.puertos) {
        limite(++cantidadConexiones > limites.conexiones, 'conexiones', ruta);
        if (puerto.dominio !== 'electrico' && !adicional.dominios.includes('funcional')) continue;
        const a = buscar(claveTerminal(ruta, puerto.id)), b = buscar(claveTerminal(camino, puerto.id));
        if (a !== b) padres.set(b, a);
        if (puerto.dominio === 'electrico' && adicional.dominios.includes('electrico')) unirFisicos(claveTerminal(ruta, puerto.id), claveTerminal(camino, puerto.id));
        conexiones.push({ terminal: claveTerminal(ruta, puerto.id), origen: { ruta: [...ruta], conexion: adicional.id, representacion: 'equivalente',
          ...(puerto.dominio === 'electrico' && !adicional.dominios.includes('electrico') ? { observacion: true as const } : {}) } });
      }
    }
  };
  visitar(raiz, [], opciones.parametros ?? {}, ['electrico', 'funcional']);
  if (pendientes.size) throw new ErrorComponente('FORMATO', 'Selección para una ruta inexistente o inactiva');
  const grupos = new Map<string, TerminalElaborado[]>();
  for (const terminal of terminales.values()) {
    const clave = buscar(terminal.clave);
    const grupo = grupos.get(clave);
    if (grupo) grupo.push(terminal); else grupos.set(clave, [terminal]);
  }
  limite(grupos.size > limites.redes, 'redes', []);
  const origenes = new Map<string, OrigenRed[]>();
  for (const c of conexiones) {
    const grupo = buscar(c.terminal), anteriores = origenes.get(grupo);
    if (anteriores) anteriores.push(c.origen); else origenes.set(grupo, [c.origen]);
  }
  const hojas = new Set(instancias.filter(i => i.tipo === 'hoja-legada' && poseeDominio(i, 'funcional')).map(i => JSON.stringify(i.ruta)));
  const hojasElectricas = new Set(instancias.filter(i => i.tipo === 'hoja-legada' && poseeDominio(i, 'electrico')).map(i => JSON.stringify(i.ruta)));
  const redes = [...grupos.entries()].map(([grupo, puntos]) => {
    puntos.sort((a, b) => ordenar(a.clave, b.clave));
    const primero = puntos[0];
    if (!primero) throw new ErrorComponente('FORMATO', 'Grupo vacío');
    if (primero.dominio === 'electrico') {
      const anclas = new Set(puntos.filter(p => hojasElectricas.has(JSON.stringify(p.ruta))).map(p => raizDe(fisicos, p.clave)));
      if (anclas.size > 1) throw new ErrorComponente('DOMINIO_INCOMPATIBLE', 'Topología de observación eléctrica ambigua: une nodos físicos distintos', primero.ruta);
    }
    if (primero.dominio !== 'electrico') {
      // Las interfaces de compuestos no agregan drivers: cuentan las hojas y la entrada raíz.
      const drivers = puntos.filter(p => hojas.has(JSON.stringify(p.ruta)) ? p.direccion === 'salida' : p.ruta.length === 0 && p.direccion === 'entrada');
      if (drivers.length > 1) throw new ErrorComponente('MULTIPLES_SALIDAS', 'Múltiples salidas declaradas en una red funcional', primero.ruta);
    }
    return { id: primero.clave, dominio: primero.dominio, ancho: primero.ancho, terminales: puntos, origenes: origenes.get(grupo) ?? [] };
  }).sort((a, b) => ordenar(a.id, b.id));
  return { instancias, redes };
}
