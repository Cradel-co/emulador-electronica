import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { escribirAtomico } from './escrituraAtomica.js';
import { descargarAcotado } from './descargaAcotada.js';

const huella = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const leerOpcional = async (archivo: string): Promise<Buffer | null> => fs.readFile(archivo).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
export const LIMITE_FIRMWARE = 16 * 1024 * 1024;

/** TOFU: conserva la primera referencia; no autentica el origen ni acepta caché sin referencia. */
export async function obtenerFirmware(target: string, url: string, onLine: (line: string) => void, fetcher: typeof fetch = fetch): Promise<string> {
  const nombre = path.basename(target);
  const referencia = await leerOpcional(target + '.sha256');
  const esperada = referencia?.toString('utf8').trim().match(/^([a-f0-9]{64})  (.+)$/);
  if (referencia && (!esperada || esperada[2] !== nombre)) throw new Error(`Huella de firmware inválida: ${target}.sha256`);
  const existente = await leerOpcional(target);
  if (existente) {
    if (!esperada) throw new Error(`Firmware histórico sin huella: ${target}. Retirá el archivo de caché para descargarlo y fijar una nueva referencia.`);
    if (huella(existente) !== esperada[1]) throw new Error(`Falló la integridad del firmware: ${target}. No se usará ni se reemplazará su huella.`);
    return target;
  }
  onLine(`Descargando firmware ${nombre} (máximo 16 MiB)...`);
  const bytes = await descargarAcotado(url, LIMITE_FIRMWARE, 120_000, fetcher);
  if (!bytes.byteLength) throw new Error('El firmware descargado está vacío.');
  const hash = huella(bytes);
  if (esperada && hash !== esperada[1]) throw new Error('Falló la integridad del firmware descargado respecto de la referencia conservada.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Publicar primero la referencia: un fallo posterior deja una referencia reutilizable, no un binario sin verificar.
  if (!referencia) await escribirAtomico(target + '.sha256', `${hash}  ${nombre}\n`);
  await escribirAtomico(target, bytes);
  onLine(`SHA-256 del firmware: ${hash}`);
  return target;
}
