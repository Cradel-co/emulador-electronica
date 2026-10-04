import { createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { normalizeWorkspaceRoute, parseWorkspaceRoute, sameWorkspaceRoute, workspaceRoutePath } from './navigation-route.js';
import type { WorkspaceRoute } from './navigation-route.js';

export type { WorkspaceRoute } from './navigation-route.js';

export interface WorkspaceNavigationOptions {
  apply: (route: WorkspaceRoute) => Promise<WorkspaceRoute>;
  canLeave: () => Promise<boolean>;
  onError: (error: unknown) => void;
  /** Punto de inyección para pruebas y otros entornos; no forma parte del dominio. */
  history?: ReturnType<typeof createHashHistory>;
}

export interface WorkspaceNavigation {
  readonly current: WorkspaceRoute;
  start(): Promise<void>;
  navigate(route: WorkspaceRoute, options?: { replace?: boolean }): Promise<void>;
  /** Sincroniza una selección ya aplicada, sin cargar otra vez el editor. */
  replace(route: WorkspaceRoute): void;
  destroy(): void;
}

/**
 * Adaptador sin RouterProvider: TanStack administra rutas e historial, mientras
 * el editor, el circuito y las islas React conservan sus nodos y su estado.
 */
export function createWorkspaceNavigation(options: WorkspaceNavigationOptions): WorkspaceNavigation {
  const history = options.history ?? createHashHistory();
  let current: WorkspaceRoute = { project: null };
  let suppress = false;
  let started = false;
  let destroyed = false;
  let revision = 0;
  let navigationRevision = 0;
  let pending: { route: WorkspaceRoute; revision: number } | null = null;
  let draining: Promise<void> | null = null;
  let guard: Promise<boolean> = Promise.resolve(true);
  let unsubscribe = () => {};
  let unblock = () => {};

  function readLocation(): WorkspaceRoute {
    try { return parseWorkspaceRoute(history.location.href); }
    catch (error) {
      options.onError(error);
      return { project: null };
    }
  }

  // Normalizar antes de construir el router impide que un hash mal formado
  // alcance los decodificadores internos y conserva enlaces anteriores.
  const initial = readLocation();
  if (history.location.href !== workspaceRoutePath(initial)) {
    history.replace(workspaceRoutePath(initial), undefined, { ignoreBlocker: true });
    history.flush();
  }

  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: '/' });
  const learn = createRoute({ getParentRoute: () => root, path: '/aprender' });
  const learnTopics = createRoute({ getParentRoute: () => root, path: '/aprender/temas' });
  const learnPaths = createRoute({ getParentRoute: () => root, path: '/aprender/rutas' });
  const learnTopic = createRoute({ getParentRoute: () => root, path: '/aprender/temas/$slug' });
  const learnPath = createRoute({ getParentRoute: () => root, path: '/aprender/rutas/$slug' });
  const project = createRoute({
    getParentRoute: () => root,
    path: '/projects/$project',
    validateSearch: (search: Record<string, unknown>): { board?: string; file?: string } => ({
      ...(typeof search.board === 'string' ? { board: search.board } : {}),
      ...(typeof search.file === 'string' ? { file: search.file } : {}),
    }),
  });
  const router = createRouter({
    routeTree: root.addChildren([home, learn, learnTopics, learnPaths, learnTopic, learnPath, project]),
    history,
    isServer: false,
    origin: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
    // Los identificadores numéricos también son strings del dominio.
    parseSearch: search => Object.fromEntries(new URLSearchParams(search)),
    stringifySearch: search => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(search)) if (typeof value === 'string') query.set(key, value);
      return query.size ? `?${query}` : '';
    },
    defaultPendingMinMs: 0,
  });

  function sync(route: WorkspaceRoute): void {
    current = normalizeWorkspaceRoute(route);
    const path = workspaceRoutePath(current);
    if (history.location.href === path || destroyed) return;
    suppress = true;
    try {
      history.replace(path, undefined, { ignoreBlocker: true });
      history.flush();
    } finally { suppress = false; }
    void router.load().catch(options.onError);
  }

  function canLeave(): Promise<boolean> {
    // No se guardan dos versiones del editor en paralelo.
    guard = guard.catch(() => false).then(async () => {
      if (destroyed) return false;
      try { return await options.canLeave(); }
      catch (error) { options.onError(error); return false; }
    });
    return guard;
  }

  function requestApply(route: WorkspaceRoute): Promise<void> {
    pending = { route, revision: ++revision };
    if (!draining) {
      draining = (async () => {
        while (pending && !destroyed) {
          const job = pending;
          pending = null;
          try {
            const resolved = await options.apply(job.route);
            if (!destroyed && job.revision === revision) sync(resolved);
          } catch (error) {
            options.onError(error);
            if (!destroyed && job.revision === revision) sync(current);
          }
        }
      })().finally(() => {
        draining = null;
        // Una notificación puede llegar entre el último await y este finally.
        if (pending && !destroyed) return requestApply(pending.route);
      });
    }
    return draining;
  }

  async function historyChanged(): Promise<void> {
    if (destroyed || suppress) return;
    const route = readLocation();
    // También valida enlaces escritos a mano antes de TanStack.load().
    const canonical = workspaceRoutePath(route);
    if (history.location.href !== canonical) {
      suppress = true;
      try { history.replace(canonical, undefined, { ignoreBlocker: true }); history.flush(); }
      finally { suppress = false; }
    }
    // El historial suscrito debe cargar el router para resolver navigate().
    const load = router.load();
    const apply = requestApply(route);
    await Promise.all([load, apply]);
  }

  return {
    get current() { return { ...current }; },
    async start() {
      if (started || destroyed) return;
      started = true;
      unblock = history.block({
        blockerFn: async () => !(await canLeave()),
        enableBeforeUnload: false,
      });
      unsubscribe = history.subscribe(() => { void historyChanged().catch(options.onError); });
      await historyChanged();
    },
    async navigate(route, navigationOptions = {}) {
      if (destroyed) return;
      const normalized = normalizeWorkspaceRoute(route);
      if (sameWorkspaceRoute(normalized, current)) return;
      const request = ++navigationRevision;
      if (!(await canLeave()) || destroyed || request !== navigationRevision) return;
      // El guardado ya terminó. El blocker del historial cubre Atrás/Adelante.
      if (normalized.project === null) {
        if (normalized.page === 'aprender' && normalized.learning && normalized.slug) {
          await router.navigate({ to: normalized.learning === 'temas' ? '/aprender/temas/$slug' : '/aprender/rutas/$slug', params: { slug: normalized.slug }, replace: navigationOptions.replace, ignoreBlocker: true });
        } else {
          await router.navigate({ to: normalized.page !== 'aprender' ? '/' : normalized.learning === 'temas' ? '/aprender/temas' : normalized.learning === 'rutas' ? '/aprender/rutas' : '/aprender', replace: navigationOptions.replace, ignoreBlocker: true });
        }
      } else {
        await router.navigate({
          to: '/projects/$project',
          params: { project: normalized.project },
          search: { board: normalized.board, file: normalized.file },
          replace: navigationOptions.replace,
          ignoreBlocker: true,
        });
      }
      if (draining) await draining;
    },
    replace(route) {
      if (destroyed) return;
      // Una selección interna durante apply no invalida su carga actual.
      sync(route);
    },
    destroy() {
      destroyed = true;
      revision++;
      navigationRevision++;
      pending = null;
      unsubscribe();
      unblock();
      if (!options.history) history.destroy();
    },
  };
}
