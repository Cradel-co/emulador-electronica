import { createDockview, Orientation, themeDark, type DockviewApi, type SerializedDockview } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import './docking-engine.css';
import { DOCK_WINDOWS, normalizeDockLayout, type DockLayout, type DockNode, type WindowId } from './docking-layout.js';

export const DOCK_TITLES: Record<WindowId, string> = { explorador: 'Explorador', componentes: 'Componentes', circuito: 'Circuito', codigo: 'Código', detalle: 'Detalle', consola: 'Consola' };
type GridNode = SerializedDockview['grid']['root'];
const opposite = (axis: 'horizontal' | 'vertical') => axis === 'horizontal' ? 'vertical' : 'horizontal';
// Los porcentajes son aproximaciones: una segunda normalización no debe recrear todo el motor.
const layoutSignature = (layout: DockLayout) => JSON.stringify(layout, (_key, value: unknown) => typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value);
const orientation = (axis: 'horizontal' | 'vertical') => axis === 'horizontal' ? Orientation.HORIZONTAL : Orientation.VERTICAL;

/** El contrato de la aplicación permanece independiente del formato de la biblioteca. */
export function toDockviewLayout(layout: DockLayout, width = 1000, height = 700): SerializedDockview {
  function visit(node: DockNode, axis: 'horizontal' | 'vertical', w: number, h: number, size: number): GridNode {
    if (node.kind === 'group') {
      const shown = node.views.filter(id => layout.open[id]);
      return { type: 'leaf', size, visible: shown.length > 0, data: { id: node.id, views: [...node.views], activeView: shown.includes(node.active) ? node.active : shown[0] ?? node.active } };
    }
    // Gridview alterna ejes: una rama intermedia evita alterar divisiones consecutivas del mismo eje.
    if (node.axis !== axis) return { type: 'branch', size, data: [visit(node, opposite(axis), w, h, axis === 'horizontal' ? w : h)] };
    const sum = node.sizes.reduce((a, b) => a + b, 0);
    return { type: 'branch', size, data: node.children.map((child, i) => {
      const fraction = node.sizes[i] / sum;
      const cw = axis === 'horizontal' ? w * fraction : w;
      const ch = axis === 'vertical' ? h * fraction : h;
      return visit(child, opposite(axis), cw, ch, axis === 'horizontal' ? cw : ch);
    }) };
  }
  const axis = layout.root.kind === 'split' ? layout.root.axis : 'horizontal';
  const root = visit(layout.root, axis, width, height, axis === 'horizontal' ? height : width);
  return {
    grid: { root: root.type === 'branch' ? root : { type: 'branch', data: [root], size: root.size }, width, height, orientation: orientation(axis) },
    panels: Object.fromEntries(DOCK_WINDOWS.map(id => [id, { id, contentComponent: 'original-dom', tabComponent: 'window-tab', title: DOCK_TITLES[id] }])),
  };
}

/** Conserva identificadores propios cuando una división sigue reuniendo los mismos grupos. */
export function fromDockviewLayout(serialized: SerializedDockview, previous: DockLayout): DockLayout {
  const ids = new Map<string, string>();
  const leaves = (node: DockNode): string[] => node.kind === 'group' ? [node.id] : node.children.flatMap(leaves);
  function signature(node: DockNode): string {
    if (node.kind === 'group') return node.id;
    node.children.forEach(signature);
    const key = leaves(node).sort().join('|');
    ids.set(`${node.axis}:${key}`, node.id); return key;
  }
  signature(previous.root);
  let sequence = 0;
  const seenViews = new Set<string>();
  const seenGroups = new Set<string>();
  const splitIds = new Set(ids.values());
  function visit(raw: GridNode, axis: 'horizontal' | 'vertical'): DockNode {
    if (raw.type === 'leaf' && !Array.isArray(raw.data)) {
      const views = raw.data.views as WindowId[];
      if (!views.length || seenGroups.has(raw.data.id) || !/^[a-zA-Z0-9_-]{1,80}$/.test(raw.data.id)) throw new Error('Grupo inválido');
      seenGroups.add(raw.data.id);
      for (const view of views) {
        if (!DOCK_WINDOWS.includes(view) || seenViews.has(view)) throw new Error('Ventana inválida');
        seenViews.add(view);
      }
      if (raw.data.activeView && !views.includes(raw.data.activeView as WindowId)) throw new Error('Pestaña activa inválida');
      return { kind: 'group', id: raw.data.id, views, active: (raw.data.activeView ?? views[0]) as WindowId };
    }
    if (!Array.isArray(raw.data) || !raw.data.length) throw new Error('Distribución vacía');
    const children = raw.data.map(child => visit(child, opposite(axis)));
    if (children.length === 1) return children[0];
    const key = children.flatMap(leaves).sort().join('|');
    let id = ids.get(`${axis}:${key}`);
    if (!id) {
      do { id = `split-engine-${++sequence}`; } while (splitIds.has(id) || seenGroups.has(id));
      splitIds.add(id);
    }
    return { kind: 'split', id, axis, children, sizes: raw.data.map(child => Math.max(0.001, child.size ?? 1)) };
  }
  try {
    const root = visit(serialized.grid.root, serialized.grid.orientation === Orientation.HORIZONTAL ? 'horizontal' : 'vertical');
    if (seenViews.size !== DOCK_WINDOWS.length) return previous;
    return normalizeDockLayout({ version: 1, open: { ...previous.open }, root });
  } catch { return previous; }
}

export interface DockingEngine { setLayout(layout: DockLayout): void; dispose(): void }
export interface DockingEngineOptions {
  nodes: ReadonlyMap<WindowId, HTMLElement>;
  onLayout(layout: DockLayout): void;
  onClose(id: WindowId): void;
}

/** Adaptador reutilizable: Dockview gestiona gestos y geometría; la aplicación conserva sus nodos. */
export function createDockingEngine(host: HTMLElement, initial: DockLayout, options: DockingEngineOptions): DockingEngine {
  let current = initial;
  let signature = '';
  let applying = false;
  let disposed = false;
  let queued = false;
  const parking = document.createDocumentFragment();
  const disposables: { dispose(): void }[] = [];
  const api: DockviewApi = createDockview(host, {
    theme: themeDark, dndStrategy: 'pointer', disableFloatingGroups: true, defaultRenderer: 'always',
    createComponent({ id }) {
      const element = document.createElement('div');
      element.className = 'dock-original-content'; element.dataset.dockSlot = id;
      const node = options.nodes.get(id as WindowId);
      return { element, init() { if (node) element.appendChild(node); }, dispose() { if (node && element.contains(node)) parking.appendChild(node); } };
    },
    createTabComponent({ id }) {
      const view = id as WindowId;
      const element = document.createElement('div');
      element.className = 'dock-window-tab';
      element.dataset.windowDrag = view;
      element.hidden = !current.open[view];
      const grip = document.createElement('span');
      grip.className = 'window-grip'; grip.textContent = '⠿'; grip.dataset.windowDrag = view;
      grip.setAttribute('aria-label', `Mover ventana ${DOCK_TITLES[view]}`); grip.setAttribute('role', 'button');
      const title = document.createElement('span'); title.textContent = DOCK_TITLES[view];
      const close = document.createElement('button'); close.type = 'button'; close.className = 'dock-tab-close'; close.textContent = '×';
      close.setAttribute('aria-label', `Ocultar ${DOCK_TITLES[view]}`);
      close.addEventListener('pointerdown', event => event.stopPropagation());
      close.addEventListener('click', event => { event.stopPropagation(); options.onClose(view); });
      element.append(grip, title, close);
      let tab: HTMLElement | null = null;
      const stopAtTab = (event: PointerEvent) => event.stopPropagation();
      return { element, init(params) {
        // Evita que el mismo gesto también arme el arrastre del encabezado del grupo.
        queueMicrotask(() => {
          if (disposed || !element.isConnected) return;
          tab = element.closest<HTMLElement>('.dv-tab');
          if (tab) tab.dataset.windowDrag = view;
          tab?.addEventListener('pointerdown', stopAtTab);
        });
        element.addEventListener('pointerdown', event => {
          if (event.target instanceof Element && event.target.closest('[data-window-drag]')) return;
          event.stopPropagation();
          if (!(event.target instanceof Element) || !event.target.closest('.dock-tab-close')) params.api.setActive();
        });
      }, dispose() { tab?.removeEventListener('pointerdown', stopAtTab); } };
    },
    dropPositionResolver: { resolve({ x, y, width, height, zones }) {
      const position = x < width * .25 ? 'left' : x > width * .75 ? 'right' : y < height * .25 ? 'top' : y > height * .75 ? 'bottom' : 'center';
      return zones.has(position) ? { position } : null;
    } },
  });
  let pointer: number | null = null;
  const start = (event: PointerEvent) => {
    if (event.target instanceof Element && !event.target.closest('.dock-tab-close') && event.target.closest('[data-window-drag]')) pointer = event.pointerId;
  };
  const finish = () => { pointer = null; delete host.dataset.dockDragging; };
  const cancel = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || pointer === null) return;
    event.preventDefault(); event.stopPropagation();
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: pointer }));
    finish();
  };
  host.addEventListener('pointerdown', start, true);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  window.addEventListener('keydown', cancel, true);
  disposables.push({ dispose() {
    host.removeEventListener('pointerdown', start, true);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    window.removeEventListener('keydown', cancel, true);
  } });
  // Toda la pestaña permite arrastrar; la cruz conserva su acción de cierre.
  disposables.push(api.onWillDragPanel(event => {
    if (!(event.nativeEvent.target instanceof Element) || event.nativeEvent.target.closest('.dock-tab-close') || !event.nativeEvent.target.closest('[data-window-drag]')) event.nativeEvent.preventDefault();
    else host.dataset.dockDragging = event.panel.id;
  }));
  disposables.push(api.onWillDragGroup(event => event.nativeEvent.preventDefault()));
  function decorate() {
    const wasApplying = applying; applying = true;
    try {
      for (const group of api.groups) {
        group.element.dataset.dockGroup = group.id;
        const shown = group.panels.filter(panel => current.open[panel.id as WindowId]);
        if (group.api.isVisible !== (shown.length > 0)) group.api.setVisible(shown.length > 0);
        if (shown.length && !current.open[group.activePanel?.id as WindowId]) shown[0].api.setActive();
      }
    } finally { applying = wasApplying; }
    for (const sash of host.querySelectorAll<HTMLElement>('.dv-sash')) {
      sash.setAttribute('role', 'separator');
      sash.setAttribute('aria-label', 'Redimensionar ventanas');
      sash.setAttribute('aria-orientation', sash.classList.contains('vertical') ? 'vertical' : 'horizontal');
    }
  }
  function emit() {
    if (applying || disposed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (applying || disposed) return;
      decorate();
      const updated = fromDockviewLayout(api.toJSON(), current);
      const nextSignature = layoutSignature(updated);
      if (nextSignature === signature) return;
      current = updated; signature = nextSignature;
      options.onLayout(current);
    });
  }
  disposables.push(api.onDidLayoutChange(emit));
  disposables.push(api.onDidActivePanelChange(emit));
  const observer = new ResizeObserver(() => {
    if (!disposed && (api.width !== host.clientWidth || api.height !== host.clientHeight)) api.layout(host.clientWidth, host.clientHeight);
  });
  observer.observe(host);
  function setLayout(layout: DockLayout) {
    const next = layoutSignature(layout);
    if (signature === next) return;
    current = layout; signature = next; applying = true;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      for (const [id, node] of options.nodes) { parking.appendChild(node); node.hidden = !layout.open[id]; }
      api.fromJSON(toDockviewLayout(layout, Math.max(1, host.clientWidth), Math.max(1, host.clientHeight)));
      decorate();
      if (focus?.isConnected && !focus.closest('[hidden]')) focus.focus({ preventScroll: true });
    } finally { applying = false; }
    window.dispatchEvent(new Event('resize'));
  }
  setLayout(initial);
  return { setLayout, dispose() {
    disposed = true; observer.disconnect(); disposables.forEach(item => item.dispose());
    for (const node of options.nodes.values()) parking.appendChild(node);
    api.dispose();
    // Al desmontar la isla, los nodos originales vuelven al documento sin desmontar su contenido.
    for (const node of options.nodes.values()) { node.hidden = true; host.parentElement?.appendChild(node); }
  } };
}
