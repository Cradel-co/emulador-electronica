export type WindowId = 'explorador' | 'componentes' | 'circuito' | 'codigo' | 'detalle' | 'consola';
export type DockZone = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type DockGroup = { kind: 'group'; id: string; views: WindowId[]; active: WindowId };
export type DockSplit = { kind: 'split'; id: string; axis: 'horizontal' | 'vertical'; children: DockNode[]; sizes: number[] };
export type DockNode = DockGroup | DockSplit;
export interface DockLayout { version: 1; root: DockNode; open: Record<WindowId, boolean> }
export const DOCK_WINDOWS: readonly WindowId[] = ['explorador', 'componentes', 'circuito', 'codigo', 'detalle', 'consola'];
const isWindow = (value: unknown): value is WindowId => typeof value === 'string' && DOCK_WINDOWS.includes(value as WindowId);
const group = (view: WindowId): DockGroup => ({ kind: 'group', id: `grupo-${view}`, views: [view], active: view });

export function defaultDockLayout(): DockLayout {
  return { version: 1, open: { explorador: true, componentes: true, circuito: true, codigo: true, detalle: true, consola: true }, root: {
    kind: 'split', id: 'split-workspace', axis: 'vertical', sizes: [72, 28], children: [
      { kind: 'split', id: 'split-superior', axis: 'horizontal', sizes: [28, 44, 28], children: [
        { kind: 'split', id: 'split-izquierdo', axis: 'vertical', sizes: [50, 50], children: [group('explorador'), group('componentes')] },
        group('circuito'), { kind: 'split', id: 'split-derecho', axis: 'vertical', sizes: [65, 35], children: [group('codigo'), group('detalle')] },
      ] }, group('consola'),
    ],
  } };
}
function weights(sizes: number[]): number[] {
  const sum = sizes.reduce((total, n) => total + n, 0);
  return sizes.map(n => n * 100 / sum);
}
/** Sólo acepta el modelo completo: un archivo corrupto no puede perder ni duplicar herramientas. */
export function normalizeDockLayout(value: unknown): DockLayout {
  const ids = new Set<string>();
  const views = new Set<WindowId>();
  let count = 0;
  function parseNode(raw: unknown, depth: number): DockNode {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 12 || ++count > 24) throw new Error('nodo inválido');
    const node = raw as Record<string, unknown>;
    if (typeof node.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(node.id) || ids.has(node.id)) throw new Error('id inválido');
    ids.add(node.id);
    if (node.kind === 'group') {
      if (!Array.isArray(node.views) || node.views.length < 1 || node.views.length > DOCK_WINDOWS.length || !isWindow(node.active) || !node.views.includes(node.active)) throw new Error('grupo inválido');
      const items = node.views.map(item => {
        if (!isWindow(item) || views.has(item)) throw new Error('ventana duplicada');
        views.add(item); return item;
      });
      return { kind: 'group', id: node.id, views: items, active: node.active };
    }
    if (node.kind !== 'split' || (node.axis !== 'horizontal' && node.axis !== 'vertical') || !Array.isArray(node.children) || node.children.length < 2 || node.children.length > DOCK_WINDOWS.length || !Array.isArray(node.sizes) || node.sizes.length !== node.children.length) throw new Error('división inválida');
    const sizes = node.sizes.map(n => {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 1e-6 || n > 1e6) throw new Error('tamaño inválido');
      return n;
    });
    return { kind: 'split', id: node.id, axis: node.axis, children: node.children.map(child => parseNode(child, depth + 1)), sizes: weights(sizes) };
  }
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('layout inválido');
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 1 || !candidate.open || typeof candidate.open !== 'object' || Array.isArray(candidate.open)) throw new Error('versión inválida');
    const rawOpen = candidate.open as Record<string, unknown>;
    const legacy = rawOpen.detalle === undefined;
    if (DOCK_WINDOWS.some(id => !(legacy && id === 'detalle') && typeof rawOpen[id] !== 'boolean')) throw new Error('apertura inválida');
    let root = parseNode(candidate.root, 0);
    // Los diseños guardados antes de separar Detalle conservan grupos, tamaños y pestañas.
    if (legacy && !views.has('detalle') && views.size === DOCK_WINDOWS.length - 1) {
      const codigo = findGroup(root, node => node.views.includes('codigo'));
      if (!codigo) throw new Error('falta Código');
      const detalleId = uniqueId(root, 'grupo-detalle');
      const splitId = uniqueId(root, 'split-detalle');
      root = updateNode(root, codigo.id, node => ({ kind: 'split', id: splitId, axis: 'vertical', sizes: [65, 35], children: [node, { kind: 'group', id: detalleId, views: ['detalle'], active: 'detalle' }] }));
      views.add('detalle');
    }
    if (views.size !== DOCK_WINDOWS.length) throw new Error('layout incompleto');
    return { version: 1, root, open: { explorador: rawOpen.explorador as boolean, componentes: rawOpen.componentes as boolean, circuito: rawOpen.circuito as boolean, codigo: rawOpen.codigo as boolean, detalle: legacy ? false : rawOpen.detalle as boolean, consola: rawOpen.consola as boolean } };
  } catch { return defaultDockLayout(); }
}
function findGroup(node: DockNode, predicate: (group: DockGroup) => boolean): DockGroup | null {
  if (node.kind === 'group') return predicate(node) ? node : null;
  for (const child of node.children) { const found = findGroup(child, predicate); if (found) return found; }
  return null;
}
function updateNode(node: DockNode, id: string, update: (node: DockNode) => DockNode): DockNode {
  if (node.id === id) return update(node);
  if (node.kind === 'group') return node;
  const children = node.children.map(child => updateNode(child, id, update));
  return children.some((child, index) => child !== node.children[index]) ? { ...node, children } : node;
}
function removeView(node: DockNode, view: WindowId, open: Record<WindowId, boolean>): DockNode | null {
  if (node.kind === 'group') {
    if (!node.views.includes(view)) return node;
    const views = node.views.filter(item => item !== view);
    if (!views.length) return null;
    const active = node.active === view ? views.find(item => open[item]) ?? views[0] : node.active;
    return { ...node, views, active };
  }
  const pairs = node.children.map((child, index) => ({ child: removeView(child, view, open), size: node.sizes[index] })).filter((pair): pair is { child: DockNode; size: number } => pair.child !== null);
  if (!pairs.length) return null;
  if (pairs.length === 1) return pairs[0].child;
  return { ...node, children: pairs.map(pair => pair.child), sizes: weights(pairs.map(pair => pair.size)) };
}
function uniqueId(root: DockNode, base: string): string {
  const ids = new Set<string>();
  function collect(node: DockNode) { ids.add(node.id); if (node.kind === 'split') node.children.forEach(collect); }
  collect(root);
  let id = base, n = 2;
  while (ids.has(id)) id = `${base}-${n++}`;
  return id;
}
/** Una operación devuelve otro árbol; el layout anterior conserva referencias y datos intactos. */
export function moveDockWindow(layout: DockLayout, view: WindowId, targetGroupId: string, zone: DockZone): DockLayout {
  if (!isWindow(view) || !['left', 'right', 'top', 'bottom', 'center'].includes(zone)) return layout;
  const source = findGroup(layout.root, node => node.views.includes(view));
  const target = findGroup(layout.root, node => node.id === targetGroupId);
  if (!source || !target) return layout;
  if (source.id === target.id && (zone === 'center' || source.views.length === 1)) return activateDockTab(layout, source.id, view);
  const root = removeView(layout.root, view, layout.open);
  if (!root) return layout;
  const newGroupId = uniqueId(root, `grupo-${view}`);
  const splitId = uniqueId(root, `split-${view}-${zone}`);
  const moved: DockGroup = { kind: 'group', id: newGroupId, views: [view], active: view };
  const updated = updateNode(root, targetGroupId, node => {
    if (node.kind !== 'group') return node;
    if (zone === 'center') return { ...node, views: [...node.views, view], active: view };
    const before = zone === 'left' || zone === 'top';
    return { kind: 'split', id: splitId, axis: zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical', sizes: [50, 50], children: before ? [moved, node] : [node, moved] };
  });
  return { ...layout, root: updated };
}
export function setDockWindowOpen(layout: DockLayout, id: WindowId, open: boolean): DockLayout {
  if (!isWindow(id) || typeof open !== 'boolean') return layout;
  const location = findGroup(layout.root, node => node.views.includes(id));
  if (!location) return layout;
  const root = updateNode(layout.root, location.id, node => {
    if (node.kind !== 'group') return node;
    const active = open ? id : node.active === id ? node.views.find(view => view !== id && layout.open[view]) ?? id : node.active;
    return active === node.active ? node : { ...node, active };
  });
  return { ...layout, root, open: { ...layout.open, [id]: open } };
}
export function activateDockTab(layout: DockLayout, groupId: string, id: WindowId): DockLayout {
  const location = findGroup(layout.root, node => node.id === groupId && node.views.includes(id));
  if (!location || location.active === id) return layout;
  return { ...layout, root: updateNode(layout.root, groupId, node => node.kind === 'group' ? { ...node, active: id } : node) };
}
export function resizeDockSplit(layout: DockLayout, splitId: string, sizes: number[]): DockLayout {
  if (!Array.isArray(sizes) || sizes.some(n => !Number.isFinite(n) || n < 1e-6 || n > 1e6)) return layout;
  const root = updateNode(layout.root, splitId, node => node.kind === 'split' && node.children.length === sizes.length ? { ...node, sizes: weights(sizes) } : node);
  return root === layout.root ? layout : { ...layout, root };
}
