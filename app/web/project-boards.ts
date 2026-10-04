export interface ProjectBoard { id: string; board: string; language: string }
/** Adapta proyectos legacy sin duplicar la placa principal cuando ya existe boards. */
export function placasDelProyecto(project: { board?: string | null; language?: string | null; boards?: ProjectBoard[] } | null): ProjectBoard[] {
  if (!project) return [];
  if (Array.isArray(project.boards)) return project.boards;
  return project.board ? [{ id: 'board', board: project.board, language: project.language ?? 'micropython' }] : [];
}
