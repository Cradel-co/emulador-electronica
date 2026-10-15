import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface MicroPythonSourceFile { path: string; content: string }
export interface MicroPythonSourceManifest { files: MicroPythonSourceFile[]; totalBytes: number }
export class MicroPythonSourceError extends Error {
  constructor(message: string, readonly file?: string) { super(message); }
}

const MAX_FILES = 1000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const GENERATED_FILES = new Set(['boot.py', 'simbridge.py']);

/** Las rutas se conservan: helpers.py y lib/pkg/__init__.py siguen siendo módulos independientes. */
export function esFuenteMicroPython(relative: string): boolean {
  const segments = relative.split('/');
  return !relative.includes('\\') && !relative.includes('\0') && !relative.startsWith('/')
    && !segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.') || segment === '__pycache__')
    && segments[0] !== 'boards' && !GENERATED_FILES.has(relative) && relative.endsWith('.py');
}

/** Valida un snapshot sin IO; nunca concatena programas ni cambia imports. */
export function crearManifiestoMicroPython(input: readonly MicroPythonSourceFile[]): MicroPythonSourceManifest {
  const files: MicroPythonSourceFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of input) {
    if (!esFuenteMicroPython(file.path)) continue;
    if (seen.has(file.path)) throw new MicroPythonSourceError(`Archivo duplicado: ${file.path}`, file.path);
    seen.add(file.path);
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new MicroPythonSourceError(`El archivo ${file.path} supera 1 MiB.`, file.path);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES || files.length >= MAX_FILES) throw new MicroPythonSourceError('El código MicroPython supera el límite de 4 MiB o 1000 archivos.');
    files.push({ path: file.path, content: file.content });
  }
  if (!seen.has('main.py')) throw new MicroPythonSourceError('Falta main.py en la placa seleccionada.', 'main.py');
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), totalBytes };
}

/** Adapta el filesystem de UNA placa. Un error de lectura falla el manifiesto entero. */
export async function leerFuentesMicroPython(projectDir: string): Promise<MicroPythonSourceManifest> {
  const files: MicroPythonSourceFile[] = [];
  const root = path.resolve(projectDir);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new MicroPythonSourceError('La carpeta de código de la placa no existe o no es una carpeta válida.');
  if (await fs.realpath(root) !== root) throw new MicroPythonSourceError('La carpeta de código atraviesa enlaces simbólicos.');
  let totalBytes = 0;
  const walk = async (relative: string): Promise<void> => {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.') || entry.name === '__pycache__' || (!relative && entry.name === 'boards') || GENERATED_FILES.has(child)) continue;
      if (entry.isSymbolicLink()) throw new MicroPythonSourceError(`No se permiten enlaces simbólicos en el código: ${child}`, child);
      if (entry.isDirectory()) { await walk(child); continue; }
      if (!entry.isFile() || !esFuenteMicroPython(child)) continue;
      const stat = await fs.lstat(path.join(root, child));
      if (stat.isSymbolicLink()) throw new MicroPythonSourceError(`No se permiten enlaces simbólicos en el código: ${child}`, child);
      if (stat.size > MAX_FILE_BYTES) throw new MicroPythonSourceError(`El archivo ${child} supera 1 MiB.`, child);
      if (files.length >= MAX_FILES || totalBytes + stat.size > MAX_TOTAL_BYTES) throw new MicroPythonSourceError('El código MicroPython supera el límite de 4 MiB o 1000 archivos.');
      let content: string;
      try { content = await fs.readFile(path.join(root, child), 'utf8'); }
      catch { throw new MicroPythonSourceError(`No se pudo leer ${child}; revisá que siga existiendo.`, child); }
      totalBytes += Buffer.byteLength(content, 'utf8');
      files.push({ path: child, content });
    }
  };
  try { await walk(''); }
  catch (error) {
    if (error instanceof MicroPythonSourceError) throw error;
    throw new MicroPythonSourceError(`No se pudo leer el código MicroPython: ${(error as Error).message}`);
  }
  return crearManifiestoMicroPython(files);
}
