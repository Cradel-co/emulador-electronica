/** Contrato de navegación propio: la biblioteca no es el modelo del espacio de trabajo. */
export interface WorkspaceRoute {
  project: string | null;
  page?: 'aprender';
  learning?: 'temas' | 'rutas';
  slug?: string;
  board?: string;
  file?: string;
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
    if (route.page !== 'aprender') return { project: null };
    if (route.slug !== undefined && (!route.learning || !segment(route.slug))) throw new WorkspaceRouteError();
    return { project: null, page: 'aprender', ...(route.learning ? { learning: route.learning } : {}), ...(route.slug ? { slug: route.slug } : {}) };
  }
  if (!segment(route.project)) throw new WorkspaceRouteError('El nombre del proyecto en la dirección no es válido.');
  if (route.board !== undefined && !segment(route.board)) throw new WorkspaceRouteError('La placa en la dirección no es válida.');
  if (route.file !== undefined && !route.file.split('/').every(segment)) throw new WorkspaceRouteError('La ruta del archivo en la dirección no es válida.');
  return {
    project: route.project,
    ...(route.board === undefined ? {} : { board: route.board }),
    ...(route.file === undefined ? {} : { file: route.file }),
  };
}

/** Dirección interna del historial hash, sin depender de window ni de TanStack. */
export function workspaceRoutePath(route: WorkspaceRoute): string {
  const normalized = normalizeWorkspaceRoute(route);
  if (normalized.project === null) {
    if (normalized.page !== 'aprender') return '/';
    return `/aprender${normalized.learning ? `/${normalized.learning}` : ''}${normalized.slug ? `/${encodeURIComponent(normalized.slug)}` : ''}`;
  }
  const search = new URLSearchParams();
  if (normalized.board !== undefined) search.set('board', normalized.board);
  if (normalized.file !== undefined) search.set('file', normalized.file);
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
    if (path.includes('#')) throw new WorkspaceRouteError();
    if (pathname === '/aprender' || pathname === '/aprender/') return { project: null, page: 'aprender' };
    const learning = /^\/aprender\/(temas|rutas)(?:\/([^/]+))?\/?$/.exec(pathname);
    if (learning) return normalizeWorkspaceRoute({ project: null, page: 'aprender', learning: learning[1] as 'temas' | 'rutas', ...(learning[2] ? { slug: decodeURIComponent(learning[2]) } : {}) });
    const query = separator === -1 ? '' : path.slice(separator + 1);
    const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
    if (!match?.[1] || path.includes('#')) throw new WorkspaceRouteError('La página solicitada no existe.');
    const search = new URLSearchParams(query);
    if (search.getAll('board').length > 1 || search.getAll('file').length > 1) throw new WorkspaceRouteError();
    return normalizeWorkspaceRoute({
      project: decodeURIComponent(match[1]),
      ...(search.has('board') ? { board: search.get('board') as string } : {}),
      ...(search.has('file') ? { file: search.get('file') as string } : {}),
    });
  } catch (error) {
    if (error instanceof WorkspaceRouteError) throw error;
    throw new WorkspaceRouteError('La dirección contiene caracteres mal codificados.');
  }
}

export function sameWorkspaceRoute(left: WorkspaceRoute, right: WorkspaceRoute): boolean {
  return left.project === right.project && left.page === right.page && left.learning === right.learning && left.slug === right.slug && left.board === right.board && left.file === right.file;
}
