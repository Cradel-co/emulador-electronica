import type { BoardFileTree } from './file-tree.js';
import type { WorkspaceRoute } from './navigation-route.js';

/** Resuelve identificadores ausentes o borrados contra los metadatos disponibles. */
export function resolveWorkspaceSelection(route: WorkspaceRoute, boards: { id: string }[], trees: BoardFileTree[]): { board?: string; file?: string } {
  const board = boards.find(candidate => candidate.id === route.board) ?? boards[0];
  if (!board) return {};
  const files = trees.find(tree => tree.id === board.id)?.files ?? [];
  const file = files.find(candidate => candidate.path === route.file)
    ?? files.find(candidate => /^(main\.(py|yaml|c|cpp)|sketch\.cpp)$/.test(candidate.path))
    ?? files[0];
  return { board: board.id, ...(file ? { file: file.path } : {}) };
}
