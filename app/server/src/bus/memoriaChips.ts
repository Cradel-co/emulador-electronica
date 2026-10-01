import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Memoria no volátil de los chips (lo que guarda una EEPROM, la hora de un reloj con pila):
 * un archivo por chip en `projects/<proyecto>/.chips/<id>.json`. Es parte del proyecto como la
 * placa física: si se apaga y se vuelve a prender, sigue ahí. Borrar la carpeta = chip nuevo.
 */

const archivo = (dirProyecto: string, id: string): string =>
  path.join(dirProyecto, '.chips', `${id.replace(/[^\w.-]/g, '_')}.json`);

export async function leerMemoria(dirProyecto: string, id: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(archivo(dirProyecto, id), 'utf8')) as unknown;
  } catch {
    return undefined; // nunca guardó nada: un chip recién salido de fábrica
  }
}

export async function guardarMemoria(dirProyecto: string, id: string, datos: unknown): Promise<void> {
  const f = archivo(dirProyecto, id);
  await fs.mkdir(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(datos));
  await fs.rename(tmp, f); // atómico: un corte a mitad no deja el archivo roto
}

export async function borrarMemoria(dirProyecto: string, id?: string): Promise<void> {
  if (id) await fs.rm(archivo(dirProyecto, id), { force: true });
  else await fs.rm(path.join(dirProyecto, '.chips'), { recursive: true, force: true });
}
