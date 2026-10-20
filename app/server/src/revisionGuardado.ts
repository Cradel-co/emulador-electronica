import { createHash } from 'node:crypto';
import type { Project } from '@emu/shared';
import { ProjectError } from './projectStore.js';

export const revisionContenido = (dominio: string, contenido: unknown): string =>
  `"${createHash('sha256').update(JSON.stringify({ dominio, contenido })).digest('hex')}"`;
export const revisionProyecto = (p: Project): string => revisionContenido(`proyecto:${p.name}`, p);
export const revisionDiagrama = (p: Project): string => revisionContenido(`diagrama:${p.name}`, {
  modules: p.modules, wires: p.wires, board: p.board, language: p.language, boards: p.boards,
});

export class ConflictoRevision extends ProjectError {
  readonly code = 'REVISION_CONFLICT';
  constructor(readonly revisionActual: string) {
    super('El contenido cambió desde que lo cargaste. Tus cambios se conservan; resolvé el conflicto antes de guardar.', 412);
  }
}

/** La UI exige revisión. REST histórico sin x-cliente conserva escrituras incondicionales. */
export function comprobarRevision(headers: Record<string, string | string[] | undefined>, actual: string): void {
  const esperada = headers['if-match'];
  if (esperada === undefined) {
    if (headers['x-cliente'] !== undefined) throw new ProjectError('Cargá la revisión del recurso antes de guardar.', 428);
    return;
  }
  if (typeof esperada !== 'string' || !/^"[a-f0-9]{64}"$/.test(esperada)) throw new ProjectError('If-Match debe contener una revisión fuerte del recurso.', 400);
  if (esperada !== actual) throw new ConflictoRevision(actual);
}
