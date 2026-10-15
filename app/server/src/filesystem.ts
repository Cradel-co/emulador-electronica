import { promises as fs } from 'node:fs';

/** Consulta compartida de IO sin depender del servicio ni del registro de compiladores. */
export async function exists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true; }
  catch { return false; }
}
