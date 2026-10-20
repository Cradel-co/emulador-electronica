import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChipDefSchema, DefinicionComponenteSchema, MODULE_TYPE_RE, ModuleDefSchema, PruebasModuloSchema, type DefinicionComponente, type ModuleDef, type PropDef } from '@emu/shared';
import { PATHS } from '../paths.js';
import { compilarFuente } from '../fuenteSandbox.js';
import { huellaContenido } from './catalogo.js';
import { ErrorComponente } from './errores.js';

export type ModuloElectricoVerificado = ModuleDef & { modeloCodigo?: string };
export interface ArchivoPaquete { nombre: string; sha256: string }
export interface PaqueteComponente { id: string; sha256: string; descriptor: ModuleDef; archivos: ArchivoPaquete[] }
type Hoja = Extract<DefinicionComponente, { tipo: 'hoja-legada' }>;
interface Snapshot extends PaqueteComponente { fuente?: string }
interface DirectoriosPaquetes { modulos: string; chips: string }
const KB = 1024;
const dentro = (raiz: string, archivo: string): boolean => {
  const relativo = path.relative(raiz, archivo);
  return relativo !== '..' && !relativo.startsWith(`..${path.sep}`) && !path.isAbsolute(relativo);
};

async function carpeta(base: string, id: string): Promise<string> {
  if (!MODULE_TYPE_RE.test(id)) throw new ErrorComponente('PAQUETE_INVALIDO', `ID de paquete inválido: ${id}`);
  const raiz = await fs.realpath(base), destino = await fs.realpath(path.join(raiz, id));
  if (!dentro(raiz, destino)) throw new ErrorComponente('PAQUETE_INVALIDO', 'La carpeta sale del catálogo configurado');
  return destino;
}

/** Una sola lectura acotada por archivo; hash y ejecución usan esos mismos bytes capturados. */
async function leer(raiz: string, nombre: string, max: number, opcional = false): Promise<{ texto: string; sha256: string } | undefined> {
  if (path.basename(nombre) !== nombre || nombre === '.' || nombre === '..' || nombre.includes('\\')) throw new ErrorComponente('PAQUETE_INVALIDO', `Ruta de archivo inválida: ${nombre}`);
  let real: string;
  try { real = await fs.realpath(path.join(raiz, nombre)); }
  catch (error) { if (opcional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!dentro(raiz, real)) throw new ErrorComponente('PAQUETE_INVALIDO', `Enlace fuera del paquete: ${nombre}`);
  const estado = await fs.stat(real);
  if (!estado.isFile()) throw new ErrorComponente('PAQUETE_INVALIDO', `No es un archivo regular: ${nombre}`);
  if (estado.size > max) throw new ErrorComponente('LIMITE', `Archivo demasiado grande: ${nombre}`);
  const fd = await fs.open(real, 'r');
  try {
    const buffer = Buffer.alloc(max + 1);
    let cantidad = 0;
    while (cantidad < buffer.length) {
      const r = await fd.read(buffer, cantidad, buffer.length - cantidad, null);
      if (!r.bytesRead) break;
      cantidad += r.bytesRead;
    }
    if (cantidad > max) throw new ErrorComponente('LIMITE', `Archivo demasiado grande: ${nombre}`);
    const bytes = buffer.subarray(0, cantidad);
    return { texto: new TextDecoder('utf-8', { fatal: true }).decode(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await fd.close(); }
}

function valorValido(p: PropDef, valor: unknown): boolean {
  if (p.type === 'number') return typeof valor === 'number' && Number.isFinite(valor) && (p.min === undefined || valor >= p.min) && (p.max === undefined || valor <= p.max);
  if (p.type === 'boolean') return typeof valor === 'boolean';
  return typeof valor === 'string' && (!p.enum || p.enum.includes(valor));
}

function verificarContrato(hoja: Hoja, modulo: ModuleDef): void {
  const pines = new Set(modulo.pins.map(p => p.name));
  if (pines.size !== modulo.pins.length || pines.size !== hoja.puertos.length || hoja.puertos.some(p => !pines.has(p.id) || p.dominio !== 'electrico' || p.ancho !== 1 || p.direccion !== 'bidireccional')) {
    throw new ErrorComponente('PUERTO_INCOMPATIBLE', `Los puertos no corresponden a los pines eléctricos de ${modulo.type}`);
  }
  for (const [nombre, declarado] of Object.entries(hoja.parametros)) {
    const p = Object.hasOwn(modulo.props, nombre) ? modulo.props[nombre] : undefined;
    const tipo = declarado.tipo === 'numero' ? 'number' : declarado.tipo === 'texto' ? 'string' : 'boolean';
    if (!p || p.type !== tipo || !valorValido(p, declarado.default)) throw new ErrorComponente('PARAMETRO', `Parámetro incompatible con el módulo: ${nombre}`);
    if (declarado.tipo === 'numero' && ((p.min !== undefined && (declarado.min === undefined || declarado.min < p.min)) || (p.max !== undefined && (declarado.max === undefined || declarado.max > p.max)))) {
      throw new ErrorComponente('PARAMETRO', `El parámetro amplía el rango del módulo: ${nombre}`);
    }
    if (declarado.tipo === 'texto' && p.enum && (!declarado.valores || declarado.valores.some(v => !p.enum?.includes(v)))) {
      throw new ErrorComponente('PARAMETRO', `El parámetro amplía los valores del módulo: ${nombre}`);
    }
  }
  for (const [nombre, p] of Object.entries(modulo.props)) {
    const valor = Object.hasOwn(hoja.parametros, nombre) ? hoja.parametros[nombre]?.default : p.default;
    if (!valorValido(p, valor)) throw new ErrorComponente('PARAMETRO', `Default ausente o inválido en el módulo: ${nombre}`);
    if ((p.min !== undefined && !Number.isFinite(p.min)) || (p.max !== undefined && !Number.isFinite(p.max)) || (p.min !== undefined && p.max !== undefined && p.min > p.max)) {
      throw new ErrorComponente('PARAMETRO', `Rango inválido en el módulo: ${nombre}`);
    }
  }
}

/** Raíces de confianza del servidor. No recibe rutas de un proyecto ni usa la caché mutable del catálogo. */
export class PaquetesComponentes {
  constructor(private readonly directorios: DirectoriosPaquetes = { modulos: PATHS.modules, chips: PATHS.chips }) {}

  private async capturar(id: string): Promise<Snapshot> {
    try {
      const raiz = await carpeta(this.directorios.modulos, id);
      const json = await leer(raiz, 'module.json', 256 * KB);
      if (!json) throw new ErrorComponente('PAQUETE_INVALIDO', 'Falta module.json');
      const raw: unknown = JSON.parse(json.texto), descriptor = ModuleDefSchema.parse(raw);
      if (descriptor.type !== id) throw new ErrorComponente('PAQUETE_INVALIDO', 'El ID del descriptor no coincide con la carpeta');
      const archivos: ArchivoPaquete[] = [{ nombre: 'module.json', sha256: huellaContenido(raw) }];
      const svg = await leer(raiz, descriptor.svg, 256 * KB);
      if (!svg) throw new ErrorComponente('PAQUETE_INVALIDO', 'Falta el SVG declarado');
      archivos.push({ nombre: descriptor.svg, sha256: svg.sha256 });
      let fuente: string | undefined;
      if (descriptor.model) {
        const modelo = await leer(raiz, descriptor.model, 128 * KB);
        if (!modelo) throw new ErrorComponente('PAQUETE_INVALIDO', 'Falta el modelo declarado');
        fuente = modelo.texto;
        archivos.push({ nombre: descriptor.model, sha256: modelo.sha256 });
      }
      const pruebas = await leer(raiz, 'tests.json', 256 * KB, true);
      if (pruebas) { PruebasModuloSchema.parse(JSON.parse(pruebas.texto)); archivos.push({ nombre: 'tests.json', sha256: pruebas.sha256 }); }
      for (const chipId of [...new Set(descriptor.chips.map(c => c.id))].sort()) {
        const dir = await carpeta(this.directorios.chips, chipId), entrada = await leer(dir, 'chip.json', 256 * KB);
        if (!entrada) throw new ErrorComponente('PAQUETE_INVALIDO', `Falta chip.json: ${chipId}`);
        const rawChip: unknown = JSON.parse(entrada.texto), chip = ChipDefSchema.parse(rawChip);
        if (chip.id !== chipId) throw new ErrorComponente('PAQUETE_INVALIDO', 'El ID del chip no coincide con la carpeta');
        const comportamiento = await leer(dir, chip.comportamiento, 128 * KB);
        if (!comportamiento) throw new ErrorComponente('PAQUETE_INVALIDO', `Falta comportamiento: ${chipId}`);
        archivos.push({ nombre: `chips/${chipId}/chip.json`, sha256: huellaContenido(rawChip) }, { nombre: `chips/${chipId}/${chip.comportamiento}`, sha256: comportamiento.sha256 });
      }
      archivos.sort((a, b) => a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0);
      return { id, descriptor, archivos, fuente, sha256: huellaContenido({ formato: 'paquete-componente-v1', archivos }) };
    } catch (error) {
      if (error instanceof ErrorComponente) throw error;
      throw new ErrorComponente('PAQUETE_INVALIDO', `Paquete ${id} inválido: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async inspeccionar(id: string): Promise<PaqueteComponente> {
    const { fuente: _fuente, ...paquete } = await this.capturar(id);
    return paquete;
  }

  async verificar(entrada: DefinicionComponente): Promise<ModuloElectricoVerificado> {
    const validacion = DefinicionComponenteSchema.safeParse(entrada);
    if (!validacion.success) throw new ErrorComponente('FORMATO', `Contrato de hoja inválido: ${validacion.error.message}`);
    const def = validacion.data;
    if (def.tipo !== 'hoja-legada') throw new ErrorComponente('PAQUETE_INVALIDO', 'Solo una hoja legada referencia un paquete');
    const snapshot = await this.capturar(def.modulo.id);
    if (snapshot.sha256 !== def.modulo.sha256) throw new ErrorComponente('HASH_DISTINTO', `Hash distinto para el paquete ${def.modulo.id}`);
    verificarContrato(def, snapshot.descriptor);
    if (def.perfilDigital && !snapshot.descriptor.model) throw new ErrorComponente('MODELO_INVALIDO', 'El perfil digital requiere un modelo eléctrico explícito para sus salidas');
    try {
      const modeloCodigo = snapshot.descriptor.model && snapshot.fuente !== undefined ? compilarFuente(snapshot.fuente, snapshot.descriptor.model) : undefined;
      return { ...snapshot.descriptor, modeloCodigo };
    } catch (error) { throw new ErrorComponente('MODELO_INVALIDO', `No se pudo compilar el modelo: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
