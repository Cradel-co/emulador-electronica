import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Reemplaza un archivo completo. No promete durabilidad ante un corte de energía. */
export async function escribirAtomico(destino: string, contenido: string, exclusivo = false): Promise<void> {
  const temporal = path.join(path.dirname(destino), `.emu-${randomUUID()}.tmp`);
  const anterior = await fs.stat(destino).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  try {
    await fs.writeFile(temporal, contenido, { encoding: 'utf8', flag: 'wx', mode: anterior?.mode ?? 0o666 });
    if (anterior) await fs.chmod(temporal, anterior.mode);
    if (exclusivo) await fs.link(temporal, destino);
    else await fs.rename(temporal, destino);
  } finally {
    await fs.rm(temporal, { force: true });
  }
}
