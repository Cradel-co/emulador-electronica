import { promises as fs } from 'node:fs';
import { ArchivoElf } from './elf.js';
import { InfoDwarf } from './dwarf.js';

/**
 * Carga (una vez por compilación) el .elf y su DWARF. Se cachea por ruta + fecha +
 * tamaño: el DWARF de ESPHome tarda ~1,5 s en indexarse y no hace falta repetirlo en
 * cada pedido. Si el DWARF no se puede leer, queda solo la tabla de símbolos.
 */

export interface Simbolos {
  ruta: string;
  elf: ArchivoElf;
  dwarf: InfoDwarf | null;
  /** Por qué no hay DWARF (si no hay). */
  sinDwarf?: string;
}

const cache = new Map<string, { clave: string; simbolos: Promise<Simbolos> }>();

export async function cargarSimbolos(ruta: string): Promise<Simbolos> {
  const st = await fs.stat(ruta);
  const clave = `${st.mtimeMs}:${st.size}`;
  const ya = cache.get(ruta);
  if (ya && ya.clave === clave) return ya.simbolos;
  const simbolos = (async (): Promise<Simbolos> => {
    const elf = new ArchivoElf(await fs.readFile(ruta));
    try {
      const dwarf = new InfoDwarf(elf);
      if (!dwarf.tieneInfo) return { ruta, elf, dwarf: null, sinDwarf: 'el .elf no tiene información de depuración (-g)' };
      return { ruta, elf, dwarf };
    } catch (err) {
      return { ruta, elf, dwarf: null, sinDwarf: `no se pudo leer el DWARF: ${(err as Error).message}` };
    }
  })();
  cache.set(ruta, { clave, simbolos });
  // Solo se guardan los últimos 4 .elf (cada uno puede ocupar decenas de MB en memoria).
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
  simbolos.catch(() => cache.delete(ruta));
  return simbolos;
}
