/** Contrato de navegación propio: la biblioteca no es el modelo del espacio de trabajo. */
export interface WorkspaceRoute {
  project: string | null;
  board?: string;
  file?: string;
  leccion?: string;
  aprender?: { leccion?: string; paso?: string };
}

export class WorkspaceRouteError extends Error {
  constructor(message = 'La dirección del proyecto no es válida.') {
    super(message);
    this.name = 'WorkspaceRouteError';
  }
}

function segment(value: string): boolean {
  return !!value && value !== '.' && value !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

export function normalizeWorkspaceRoute(route: WorkspaceRoute): WorkspaceRoute {
  if (route.project === null) {
    if (!route.aprender) return { project: null };
    if (route.aprender.leccion !== undefined && !segment(route.aprender.leccion)) throw new WorkspaceRouteError('El identificador de la lección no es válido.');
    if (route.aprender.paso !== undefined && !segment(route.aprender.paso)) throw new WorkspaceRouteError('El identificador del paso no es válido.');
    return {
      project: null,
      aprender: {
        ...(route.aprender.leccion === undefined ? {} : { leccion: route.aprender.leccion }),
        ...(route.aprender.paso === undefined ? {} : { paso: route.aprender.paso }),
      },
    };
  }
  if (!segment(route.project)) throw new WorkspaceRouteError('El nombre del proyecto en la dirección no es válido.');
  if (route.board !== undefined && !segment(route.board)) throw new WorkspaceRouteError('La placa en la dirección no es válida.');
  if (route.file !== undefined && !route.file.split('/').every(segment)) throw new WorkspaceRouteError('La ruta del archivo en la dirección no es válida.');
  if (route.leccion !== undefined && !segment(route.leccion)) throw new WorkspaceRouteError('El identificador de la lección no es válido.');
  return {
    project: route.project,
    ...(route.board === undefined ? {} : { board: route.board }),
    ...(route.file === undefined ? {} : { file: route.file }),
    ...(route.leccion === undefined ? {} : { leccion: route.leccion }),
  };
}

/** Dirección interna del historial hash, sin depender de window ni de TanStack. */
export function workspaceRoutePath(route: WorkspaceRoute): string {
  const normalized = normalizeWorkspaceRoute(route);
  if (normalized.project === null) {
    if (!normalized.aprender) return '/';
    const pathname = normalized.aprender.leccion ? `/aprender/${encodeURIComponent(normalized.aprender.leccion)}` : '/aprender';
    return normalized.aprender.paso ? `${pathname}?paso=${encodeURIComponent(normalized.aprender.paso)}` : pathname;
  }
  const search = new URLSearchParams();
  if (normalized.board !== undefined) search.set('board', normalized.board);
  if (normalized.file !== undefined) search.set('file', normalized.file);
  if (normalized.leccion !== undefined) search.set('leccion', normalized.leccion);
  const query = search.toString();
  return `/projects/${encodeURIComponent(normalized.project)}${query ? `?${query}` : ''}`;
}

/** Conserva enlaces antiguos #proyecto y rechaza escapes dañados sin URIError. */
export function parseWorkspaceRoute(pathOrHash: string): WorkspaceRoute {
  const path = pathOrHash.startsWith('#') ? pathOrHash.slice(1) : pathOrHash;
  if (!path || path === '/') return { project: null };
  try {
    // URLSearchParams tolera porcentajes inválidos; el contrato los valida antes.
    decodeURIComponent(path.replace(/\+/g, ' '));
    if (!path.startsWith('/')) return normalizeWorkspaceRoute({ project: decodeURIComponent(path) });
    const separator = path.indexOf('?');
    const pathname = separator === -1 ? path : path.slice(0, separator);
    const query = separator === -1 ? '' : path.slice(separator + 1);
    if (pathname === '/aprender') {
      const search = new URLSearchParams(query);
      if (search.getAll('paso').length > 1) throw new WorkspaceRouteError();
      return normalizeWorkspaceRoute({ project: null, aprender: search.has('paso') ? { paso: search.get('paso') as string } : {} });
    }
    const leccionMatch = /^\/aprender\/([^/]+)\/?$/.exec(pathname);
    if (leccionMatch?.[1]) {
      const search = new URLSearchParams(query);
      if (search.getAll('paso').length > 1) throw new WorkspaceRouteError();
      return normalizeWorkspaceRoute({
        project: null,
        aprender: {
          leccion: decodeURIComponent(leccionMatch[1]),
          ...(search.has('paso') ? { paso: search.get('paso') as string } : {}),
        },
      });
    }
    const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
    if (!match?.[1] || path.includes('#')) throw new WorkspaceRouteError('La página solicitada no existe.');
    const search = new URLSearchParams(query);
    if (search.getAll('board').length > 1 || search.getAll('file').length > 1 || search.getAll('leccion').length > 1) throw new WorkspaceRouteError();
    return normalizeWorkspaceRoute({
      project: decodeURIComponent(match[1]),
      ...(search.has('board') ? { board: search.get('board') as string } : {}),
      ...(search.has('file') ? { file: search.get('file') as string } : {}),
      ...(search.has('leccion') ? { leccion: search.get('leccion') as string } : {}),
    });
  } catch (error) {
    if (error instanceof WorkspaceRouteError) throw error;
    throw new WorkspaceRouteError('La dirección contiene caracteres mal codificados.');
  }
}

export function sameWorkspaceRoute(left: WorkspaceRoute, right: WorkspaceRoute): boolean {
  return left.project === right.project && left.board === right.board && left.file === right.file && left.leccion === right.leccion
    && Boolean(left.aprender) === Boolean(right.aprender)
    && left.aprender?.leccion === right.aprender?.leccion && left.aprender?.paso === right.aprender?.paso;
}
