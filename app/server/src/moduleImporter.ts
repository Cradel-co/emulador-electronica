import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { MODULE_TYPE_RE, ModuleDefSchema, type ModuleDef } from '@emu/shared';
import { validarPlaca } from './boardRegistry.js';

/**
 * Importador de módulos (sección 12: "para agregar un módulo nuevo…").
 *
 * Un módulo es una carpeta `modules/<tipo>/` con `module.json` + `module.svg`.
 * Se puede importar desde: archivos sueltos (una carpeta elegida en la UI), un
 * zip, un chip custom de Wokwi (`.chip.json`), o una URL (zip, module.json,
 * .chip.json o un repo de GitHub). Los módulos no traen código ejecutable:
 * solo el dibujo, los pines y su rol en el puente, así que importar uno de
 * terceros no ejecuta nada. El SVG igual se revisa porque va a parar al DOM.
 */

export type OrigenKind = 'carpeta' | 'zip' | 'wokwi' | 'url' | 'github';

/** Un módulo listo para validar: textos crudos tal como llegaron. */
export interface Paquete {
  json: string;
  svg?: string;
  /** De dónde salió (ruta dentro del zip, URL...), para los mensajes. */
  origen: string;
  kind: OrigenKind;
}

export interface Validacion {
  def?: ModuleDef;
  errores: string[];
  avisos: string[];
}

export interface ResultadoImportacion {
  importados: { type: string; name: string; origen: string }[];
  errores: { origen: string; mensajes: string[] }[];
  avisos: { origen: string; mensajes: string[] }[];
}

export class ImportError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export const LIMITES = {
  json: 256 * 1024,
  svg: 256 * 1024,
  /** Por archivo descomprimido dentro de un zip. */
  archivoZip: 512 * 1024,
  totalZip: 8 * 1024 * 1024,
  entradasZip: 2000,
  descarga: 15 * 1024 * 1024,
  timeoutMs: 20_000,
  modulosPorImportacion: 100,
};

// --- SVG ---------------------------------------------------------------------

/** Elementos SVG que puede tener el dibujo de un módulo (el frontend usa la misma lista). */
export const SVG_ELEMENTOS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'title', 'desc', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern',
  'use', 'symbol',
]);

/**
 * Problemas de seguridad de un SVG. Rechaza (no "limpia"): scripts, manejadores
 * `on*`, referencias externas, entidades XML. El frontend además filtra al dibujar.
 */
export function problemasSvg(svg: string): string[] {
  const problemas: string[] = [];
  if (!/<svg[\s>]/i.test(svg)) problemas.push('no es un SVG (falta la etiqueta <svg>)');
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) problemas.push('no se permiten DOCTYPE ni entidades XML');
  if (/<\?xml-stylesheet/i.test(svg)) problemas.push('no se permiten hojas de estilo externas');
  const etiquetas = new Set<string>();
  for (const m of svg.matchAll(/<\s*([a-zA-Z][\w:.-]*)/g)) {
    const nombre = m[1]!.toLowerCase().replace(/^svg:/, '');
    if (!SVG_ELEMENTOS.has(nombre)) etiquetas.add(`<${m[1]}>`);
  }
  if (etiquetas.size) problemas.push(`elementos no permitidos: ${[...etiquetas].join(', ')}`);
  if (/\son[a-z]+\s*=/i.test(svg)) problemas.push('no se permiten atributos de eventos (onclick, onload...)');
  if (/(?:xlink:)?href\s*=\s*["']\s*(?!#)/i.test(svg)) problemas.push('los href solo pueden apuntar dentro del mismo SVG (#id)');
  if (/javascript:/i.test(svg)) problemas.push('no se permite "javascript:"');
  if (/url\(\s*['"]?\s*(?!#)/i.test(svg)) problemas.push('url(...) solo puede apuntar dentro del mismo SVG (#id)');
  if (/@import/i.test(svg)) problemas.push('no se permite @import');
  return problemas;
}

// --- Validación ----------------------------------------------------------------

/** Valida un paquete (module.json + svg) sin escribir nada. */
export function validarPaquete(p: Paquete): Validacion {
  const errores: string[] = [];
  const avisos: string[] = [];
  if (p.json.length > LIMITES.json) return { errores: ['module.json es demasiado grande (máx. 256 KB)'], avisos };
  let raw: unknown;
  try {
    raw = JSON.parse(p.json);
  } catch (err) {
    return { errores: [`module.json no es JSON válido: ${(err as Error).message}`], avisos };
  }
  if (raw && typeof raw === 'object') {
    // Campos que pone el importador, no el autor del módulo.
    delete (raw as Record<string, unknown>).origin;
    if (!(raw as Record<string, unknown>).svg) (raw as Record<string, unknown>).svg = 'module.svg';
  }
  const parsed = ModuleDefSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errores.push(`${issue.path.join('.') || 'module.json'}: ${issue.message}`);
    }
    return { errores, avisos };
  }
  const def = parsed.data;

  if (def.programmable) {
    // Un módulo programable es una placa: se acepta si trae su descriptor (`board`) y es
    // válido contra los motores/toolchains de este server (boardRegistry.ts).
    if (!def.board) {
      errores.push('un módulo programable es una placa: le falta el bloque "board" (esquema en GET /api/boards/schema)');
    } else {
      const v = validarPlaca(def);
      errores.push(...v.errores.map((e) => `placa: ${e}`));
      avisos.push(...v.avisos.map((a) => `placa: ${a}`));
    }
  }
  if (def.width < 10 || def.height < 10 || def.width > 2000 || def.height > 2000) {
    errores.push(`tamaño fuera de rango: ${def.width}×${def.height} (entre 10 y 2000)`);
  }
  const nombres = new Set<string>();
  for (const pin of def.pins) {
    if (!/^[A-Za-z0-9_+-]{1,16}$/.test(pin.name)) errores.push(`pin "${pin.name}": nombre inválido ([A-Za-z0-9_+-], hasta 16)`);
    if (nombres.has(pin.name)) errores.push(`pin "${pin.name}" repetido`);
    nombres.add(pin.name);
    const fuera = pin.x < -2 || pin.y < -2 || pin.x > def.width + 2 || pin.y > def.height + 2;
    if (fuera) errores.push(`pin "${pin.name}" en (${pin.x}, ${pin.y}) queda fuera del módulo (${def.width}×${def.height})`);
  }
  if (def.bridge && def.bridge.role !== 'air' && !nombres.has(def.bridge.pin)) {
    errores.push(`bridge.pin "${def.bridge.pin}" no es ninguno de los pines del módulo`);
  }
  if (def.bridge?.role === 'air' && def.pins.length > 0) {
    avisos.push('es inalámbrico (role "air") pero tiene pines: no se van a usar en la simulación');
  }
  for (const [nombre, v] of Object.entries(def.vars)) {
    if (!(v.prop in def.props)) avisos.push(`vars.${nombre} usa la propiedad "${v.prop}", que no está en props`);
  }

  if (p.svg === undefined) {
    avisos.push('no trae dibujo (module.svg): se va a ver como una caja con su nombre');
  } else if (p.svg.length > LIMITES.svg) {
    errores.push('module.svg es demasiado grande (máx. 256 KB)');
  } else {
    errores.push(...problemasSvg(p.svg).map((x) => `module.svg: ${x}`));
    if (def.controls.some((c) => c.kind !== 'none') && !/data-ctrl\s*=/.test(p.svg)) {
      avisos.push('declara controls pero el SVG no marca ninguna parte con data-ctrl: no se va a poder tocar');
    }
  }
  return { def: errores.length ? undefined : def, errores, avisos };
}

// --- Wokwi ------------------------------------------------------------------------

export interface OpcionesWokwi {
  type?: string;
  category?: string;
  /** Rol en el puente. Sin rol, el módulo se cablea pero no interactúa con la simulación. */
  role?: 'input' | 'output' | 'rf-rx' | 'rf-tx';
  /** Pin del puente (por defecto, el primer pin que no es alimentación). */
  pin?: string;
}

const escXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const slug = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function kindDePin(nombre: string): 'power' | 'ground' | 'digital-io' {
  if (/^(GND|VSS|AGND|DGND)\d*$/i.test(nombre)) return 'ground';
  if (/^(VCC|VDD|VIN|V\+|3V3|3\.3V|5V|VBAT)\d*$/i.test(nombre)) return 'power';
  return 'digital-io';
}

/**
 * Convierte un chip custom de Wokwi (`.chip.json`, https://docs.wokwi.com/chips-api/chip-json)
 * a un módulo. Wokwi dibuja los chips como un DIP: la primera mitad de los pines
 * a la izquierda (de arriba a abajo) y la segunda a la derecha (de abajo a arriba).
 * La lógica del chip (WASM) no se ejecuta: solo se importan pines y dibujo.
 */
export function convertirChipWokwi(chipJson: string, opciones: OpcionesWokwi = {}): { json: string; svg: string; avisos: string[] } {
  let chip: { name?: unknown; author?: unknown; pins?: unknown; controls?: unknown };
  try {
    chip = JSON.parse(chipJson);
  } catch (err) {
    throw new ImportError(`el .chip.json no es JSON válido: ${(err as Error).message}`);
  }
  if (typeof chip.name !== 'string' || !Array.isArray(chip.pins) || !chip.pins.every((p) => typeof p === 'string')) {
    throw new ImportError('no parece un chip de Wokwi: tiene que tener "name" y "pins" (lista de nombres)');
  }
  const pinesWokwi = chip.pins as string[];
  const avisos = ['chip de Wokwi: su lógica (WASM) no se ejecuta; se importan los pines y un dibujo genérico'];
  if (Array.isArray(chip.controls) && chip.controls.length > 0) {
    avisos.push(`los controles de Wokwi (${chip.controls.length}) no se importan`);
  }

  const n = pinesWokwi.length;
  const mitad = Math.ceil(n / 2);
  const PASO = 16;
  const Y0 = 26;
  const largo = Math.max(3, ...pinesWokwi.map((p) => p.length));
  const W = Math.max(90, largo * 6 * 2 + 40);
  const H = Y0 + Math.max(1, mitad) * PASO + 6;
  const pins: { name: string; x: number; y: number; kind: string }[] = [];
  const vistos = new Map<string, number>();
  pinesWokwi.forEach((nombre, i) => {
    if (!nombre) return; // Wokwi usa "" para dejar un hueco
    const izquierda = i < mitad;
    const fila = izquierda ? i : n - 1 - i;
    const k = (vistos.get(nombre) ?? 0) + 1;
    vistos.set(nombre, k);
    pins.push({
      name: k === 1 ? nombre : `${nombre}_${k}`,
      x: izquierda ? 0 : W,
      y: Y0 + fila * PASO,
      kind: kindDePin(nombre),
    });
  });

  const type = opciones.type ?? slug(chip.name);
  let bridge: { role: string; pin: string } | undefined;
  if (opciones.role) {
    const pin = opciones.pin ?? pins.find((p) => p.kind === 'digital-io')?.name;
    if (!pin) throw new ImportError('el chip no tiene pines de señal para conectar al puente');
    bridge = { role: opciones.role, pin };
  }
  const autor = typeof chip.author === 'string' && chip.author ? ` de ${chip.author}` : '';
  const def = {
    type,
    name: chip.name,
    category: opciones.category ?? 'Wokwi',
    description: `Chip de Wokwi "${chip.name}"${autor}. Se importan los pines y un dibujo genérico; la lógica del chip no se ejecuta.`,
    width: W,
    height: H,
    pins,
    ...(bridge ? { bridge } : {}),
    controls: [],
    props: {},
    svg: 'module.svg',
  };

  // Solo las patitas: los nombres de los pines los rotula la app (así no se ven dos veces).
  const rotulos = pins.map((p) => {
    const izq = p.x === 0;
    return `  <line x1="${izq ? -8 : W}" y1="${p.y}" x2="${izq ? 0 : W + 8}" y2="${p.y}" stroke="#aab4be" stroke-width="2"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" rx="4" fill="#1d232b" stroke="#566374"/>
  <path d="M${W / 2 - 8} 0 A8 8 0 0 0 ${W / 2 + 8} 0" fill="#0c1116" stroke="#566374"/>
  <text x="${W / 2}" y="16" class="txt-chico claro" text-anchor="middle">${escXml(chip.name.slice(0, 24))}</text>
${rotulos.join('\n')}
</svg>
`;
  return { json: JSON.stringify(def, null, 2), svg, avisos };
}

// --- Zip y archivos sueltos -------------------------------------------------------

/** Textos .json/.svg de un zip (con límites contra zip bombs). Ignora el resto. */
export function leerZip(datos: Uint8Array): Map<string, string> {
  let total = 0;
  let entradas = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(datos, {
      filter: (f) => {
        entradas++;
        if (entradas > LIMITES.entradasZip) throw new ImportError('el zip tiene demasiados archivos');
        if (f.name.includes('__MACOSX/') || !/\.(json|svg)$/i.test(f.name)) return false;
        if (f.originalSize > LIMITES.archivoZip) throw new ImportError(`${f.name} es demasiado grande (máx. 512 KB)`);
        total += f.originalSize;
        if (total > LIMITES.totalZip) throw new ImportError('el zip descomprimido es demasiado grande (máx. 8 MB)');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError(`no se pudo leer el zip: ${(err as Error).message}`);
  }
  const archivos = new Map<string, string>();
  const dec = new TextDecoder();
  for (const [nombre, contenido] of Object.entries(unzipped)) archivos.set(nombre, dec.decode(contenido));
  return archivos;
}

const esChipWokwi = (ruta: string): boolean => /\.chip\.json$/i.test(ruta);

/**
 * Busca módulos dentro de un conjunto de archivos (carpeta o zip): cada
 * `module.json` con su SVG al lado, y cada `.chip.json` de Wokwi.
 */
export function paquetesDeArchivos(archivos: Map<string, string>, kind: OrigenKind, opcionesWokwi: OpcionesWokwi = {}): {
  paquetes: Paquete[];
  errores: { origen: string; mensajes: string[] }[];
  avisos: { origen: string; mensajes: string[] }[];
} {
  const paquetes: Paquete[] = [];
  const errores: { origen: string; mensajes: string[] }[] = [];
  const avisos: { origen: string; mensajes: string[] }[] = [];
  const rutas = [...archivos.keys()].map((r) => r.replace(/\\/g, '/'));
  const normal = new Map([...archivos].map(([r, t]) => [r.replace(/\\/g, '/'), t]));
  for (const ruta of rutas.sort()) {
    const base = ruta.split('/').pop()!;
    if (base === 'module.json') {
      const dir = ruta.slice(0, ruta.length - base.length);
      let svgNombre = 'module.svg';
      try {
        const s = (JSON.parse(normal.get(ruta)!) as { svg?: unknown }).svg;
        if (typeof s === 'string' && /^[\w.-]+\.svg$/.test(s)) svgNombre = s;
      } catch {
        /* el error de JSON lo informa la validación */
      }
      paquetes.push({ json: normal.get(ruta)!, svg: normal.get(dir + svgNombre), origen: ruta, kind });
    } else if (esChipWokwi(ruta)) {
      try {
        const conv = convertirChipWokwi(normal.get(ruta)!, rutas.filter(esChipWokwi).length === 1 ? opcionesWokwi : {});
        paquetes.push({ json: conv.json, svg: conv.svg, origen: ruta, kind: 'wokwi' });
        avisos.push({ origen: ruta, mensajes: conv.avisos });
      } catch (err) {
        errores.push({ origen: ruta, mensajes: [(err as Error).message] });
      }
    }
  }
  if (paquetes.length === 0 && errores.length === 0) {
    errores.push({ origen: kind, mensajes: ['no se encontró ningún module.json ni .chip.json'] });
  }
  if (paquetes.length > LIMITES.modulosPorImportacion) {
    throw new ImportError(`demasiados módulos en una sola importación (máx. ${LIMITES.modulosPorImportacion})`);
  }
  return { paquetes, errores, avisos };
}

// --- URL ------------------------------------------------------------------------------

/** Descarga con límites: solo https, tamaño y tiempo acotados. */
export async function descargar(url: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ImportError(`URL inválida: ${url}`);
  }
  if (u.protocol !== 'https:') throw new ImportError('solo se aceptan URLs https://');
  let res: Response;
  try {
    res = await fetcher(u, { signal: AbortSignal.timeout(LIMITES.timeoutMs), redirect: 'follow' });
  } catch (err) {
    throw new ImportError(`no se pudo descargar ${url}: ${(err as Error).message}`);
  }
  if (res.url && !res.url.startsWith('https:')) throw new ImportError('la descarga redirigió a una URL que no es https');
  if (!res.ok) throw new ImportError(`no se pudo descargar ${url}: HTTP ${res.status}`);
  const largo = Number(res.headers.get('content-length') ?? 0);
  if (largo > LIMITES.descarga) throw new ImportError('el archivo es demasiado grande (máx. 15 MB)');
  const datos = new Uint8Array(await res.arrayBuffer());
  if (datos.length > LIMITES.descarga) throw new ImportError('el archivo es demasiado grande (máx. 15 MB)');
  return datos;
}

/** Repos de GitHub: https://github.com/dueño/repo[/tree/rama/sub/carpeta] */
export function urlGithub(url: string): { zip: string; subcarpeta: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/.exec(url);
  if (!m) return null;
  const [, dueno, repo, rama, sub] = m;
  return {
    zip: `https://github.com/${dueno}/${repo}/archive/${rama ?? 'HEAD'}.zip`,
    subcarpeta: (sub ?? '').replace(/\/+$/, ''),
  };
}

/** Paquetes que hay detrás de una URL (zip, repo de GitHub, module.json o .chip.json). */
export async function paquetesDeUrl(url: string, opcionesWokwi: OpcionesWokwi = {}, fetcher: typeof fetch = fetch) {
  const gh = urlGithub(url);
  if (gh) {
    const archivos = leerZip(await descargar(gh.zip, fetcher));
    // El zip de GitHub tiene una carpeta raíz "repo-rama/": se filtra por la subcarpeta pedida.
    const filtrados = new Map(
      [...archivos].filter(([ruta]) => {
        const sinRaiz = ruta.slice(ruta.indexOf('/') + 1);
        return !gh.subcarpeta || sinRaiz.startsWith(gh.subcarpeta + '/');
      }),
    );
    return paquetesDeArchivos(filtrados, 'github', opcionesWokwi);
  }
  const datos = await descargar(url, fetcher);
  if (datos[0] === 0x50 && datos[1] === 0x4b) return paquetesDeArchivos(leerZip(datos), 'url', opcionesWokwi); // "PK": zip
  const texto = new TextDecoder().decode(datos);
  let json: { pins?: unknown; svg?: unknown };
  try {
    json = JSON.parse(texto);
  } catch {
    throw new ImportError('la URL no es un zip, ni un module.json, ni un .chip.json');
  }
  if (Array.isArray(json.pins) && json.pins.every((p) => typeof p === 'string')) {
    const conv = convertirChipWokwi(texto, opcionesWokwi);
    return { paquetes: [{ json: conv.json, svg: conv.svg, origen: url, kind: 'wokwi' as const }], errores: [], avisos: [{ origen: url, mensajes: conv.avisos }] };
  }
  // module.json suelto: el SVG se busca al lado.
  const svgNombre = typeof json.svg === 'string' && /^[\w.-]+\.svg$/.test(json.svg) ? json.svg : 'module.svg';
  let svg: string | undefined;
  try {
    svg = new TextDecoder().decode(await descargar(new URL(svgNombre, url).toString(), fetcher));
  } catch {
    svg = undefined; // sin dibujo: la validación avisa
  }
  return { paquetes: [{ json: texto, svg, origen: url, kind: 'url' as const }], errores: [], avisos: [] };
}

// --- Instalación ----------------------------------------------------------------------

export class ModuleInstaller {
  constructor(private readonly dir: string) {}

  private carpeta(type: string): string {
    if (!MODULE_TYPE_RE.test(type)) throw new ImportError(`tipo de módulo inválido: ${type}`);
    return path.join(this.dir, type);
  }

  /** ¿Existe y es de fábrica (sin `origin`)? */
  async estado(type: string): Promise<'no-existe' | 'fabrica' | 'importado'> {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.carpeta(type), 'module.json'), 'utf8'));
      return raw.origin ? 'importado' : 'fabrica';
    } catch {
      return 'no-existe';
    }
  }

  async instalar(def: ModuleDef, svg: string | undefined, origin: NonNullable<ModuleDef['origin']>, sobrescribir: boolean): Promise<void> {
    const estado = await this.estado(def.type);
    if (estado === 'fabrica') throw new ImportError(`"${def.type}" es un módulo de fábrica: no se puede reemplazar`, 409);
    if (estado === 'importado' && !sobrescribir) {
      throw new ImportError(`ya hay un módulo "${def.type}" importado (marcá "reemplazar" para pisarlo)`, 409);
    }
    const destino = this.carpeta(def.type);
    const tmp = `${destino}.tmp-${process.pid}-${Date.now()}`;
    await fs.mkdir(tmp, { recursive: true });
    try {
      await fs.writeFile(path.join(tmp, 'module.json'), JSON.stringify({ ...def, svg: 'module.svg', origin }, null, 2) + '\n');
      if (svg !== undefined) await fs.writeFile(path.join(tmp, 'module.svg'), svg);
      await fs.rm(destino, { recursive: true, force: true });
      await fs.rename(tmp, destino);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true });
      throw err;
    }
  }

  async quitar(type: string): Promise<void> {
    const estado = await this.estado(type);
    if (estado === 'no-existe') throw new ImportError(`no existe el módulo "${type}"`, 404);
    if (estado === 'fabrica') throw new ImportError(`"${type}" es un módulo de fábrica: no se puede quitar`, 409);
    await fs.rm(this.carpeta(type), { recursive: true, force: true });
  }
}

// --- Orquestación -----------------------------------------------------------------------

/** Lo que se puede pedir importar (API REST y MCP). */
export type SolicitudImportacion =
  | { fuente: 'archivos'; archivos: Record<string, string> }
  | { fuente: 'zip'; base64: string }
  | { fuente: 'wokwi'; chipJson: string }
  | { fuente: 'url'; url: string };

export interface OpcionesImportacion {
  sobrescribir?: boolean;
  /** Valida sin instalar nada. */
  soloValidar?: boolean;
  wokwi?: OpcionesWokwi;
}

export async function importar(
  solicitud: SolicitudImportacion,
  instalador: ModuleInstaller,
  opciones: OpcionesImportacion = {},
  fetcher: typeof fetch = fetch,
): Promise<ResultadoImportacion> {
  let encontrados: ReturnType<typeof paquetesDeArchivos>;
  switch (solicitud.fuente) {
    case 'archivos':
      encontrados = paquetesDeArchivos(new Map(Object.entries(solicitud.archivos)), 'carpeta', opciones.wokwi);
      break;
    case 'zip':
      encontrados = paquetesDeArchivos(leerZip(Buffer.from(solicitud.base64, 'base64')), 'zip', opciones.wokwi);
      break;
    case 'wokwi': {
      const conv = convertirChipWokwi(solicitud.chipJson, opciones.wokwi);
      encontrados = {
        paquetes: [{ json: conv.json, svg: conv.svg, origen: 'chip.json', kind: 'wokwi' }],
        errores: [],
        avisos: [{ origen: 'chip.json', mensajes: conv.avisos }],
      };
      break;
    }
    case 'url':
      encontrados = await paquetesDeUrl(solicitud.url, opciones.wokwi, fetcher);
      break;
  }

  const resultado: ResultadoImportacion = { importados: [], errores: [...encontrados.errores], avisos: [...encontrados.avisos] };
  const desde = solicitud.fuente === 'url' ? solicitud.url : undefined;
  const tipos = new Set<string>();
  for (const p of encontrados.paquetes) {
    const v = validarPaquete(p);
    if (v.avisos.length) resultado.avisos.push({ origen: p.origen, mensajes: v.avisos });
    if (!v.def) {
      resultado.errores.push({ origen: p.origen, mensajes: v.errores });
      continue;
    }
    if (tipos.has(v.def.type)) {
      resultado.errores.push({ origen: p.origen, mensajes: [`el tipo "${v.def.type}" aparece dos veces en la misma importación`] });
      continue;
    }
    tipos.add(v.def.type);
    try {
      if (opciones.soloValidar) {
        const estado = await instalador.estado(v.def.type);
        if (estado === 'fabrica') throw new ImportError(`"${v.def.type}" es un módulo de fábrica: no se puede reemplazar`, 409);
        if (estado === 'importado' && !opciones.sobrescribir) throw new ImportError(`ya hay un módulo "${v.def.type}" importado`, 409);
      } else {
        await instalador.instalar(
          v.def,
          p.svg,
          { kind: p.kind, from: (desde ?? p.origen).slice(0, 500), importedAt: new Date().toISOString() },
          Boolean(opciones.sobrescribir),
        );
      }
      resultado.importados.push({ type: v.def.type, name: v.def.name, origen: p.origen });
    } catch (err) {
      resultado.errores.push({ origen: p.origen, mensajes: [(err as Error).message] });
    }
  }
  return resultado;
}
