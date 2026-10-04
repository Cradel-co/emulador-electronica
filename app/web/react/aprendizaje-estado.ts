import type { WorkspaceRoute } from '../navigation-route.js';
import { observable } from './estado.js';

/** La navegación aplica el contexto; React solo lo representa. */
export const aprendizaje = observable<{ route: WorkspaceRoute }>({ route: { project: null } });
