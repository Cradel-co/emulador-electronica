import { describe, expect, it } from 'vitest';
import { activateDockTab, defaultDockLayout, DOCK_WINDOWS, moveDockWindow, normalizeDockLayout, resizeDockSplit, setDockWindowOpen, type DockGroup, type DockLayout, type DockNode, type DockSplit, type WindowId } from '../../web/docking-layout.js';
function nodes(root: DockNode): DockNode[] { return [root, ...(root.kind === 'split' ? root.children.flatMap(nodes) : [])]; }
function groups(layout: DockLayout): DockGroup[] { return nodes(layout.root).filter((node): node is DockGroup => node.kind === 'group'); }
function location(layout: DockLayout, view: WindowId): DockGroup { const group = groups(layout).find(g => g.views.includes(view)); if (!group) throw new Error(`sin ubicación: ${view}`); return group; }
function assertComplete(layout: DockLayout) {
  const all = nodes(layout.root);
  expect(new Set(all.map(n => n.id)).size).toBe(all.length);
  expect(groups(layout).flatMap(g => g.views).sort()).toEqual([...DOCK_WINDOWS].sort());
  for (const node of all) {
    if (node.kind === 'group') { expect(node.views.length).toBeGreaterThan(0); expect(node.views).toContain(node.active); }
    else { expect(node.children.length).toBeGreaterThanOrEqual(2); expect(node.sizes.length).toBe(node.children.length); expect(node.sizes.reduce((sum, n) => sum + n, 0)).toBeCloseTo(100); }
  }
}
function freeze(layout: DockLayout) {
  for (const node of nodes(layout.root)) {
    if (node.kind === 'group') Object.freeze(node.views);
    else { Object.freeze(node.children); Object.freeze(node.sizes); }
    Object.freeze(node);
  }
  Object.freeze(layout.open); Object.freeze(layout); return layout;
}

describe('layout docking por defecto y persistencia', () => {
  it('ubica las cinco ventanas y mantiene Explorador cerrado inicialmente', () => {
    const layout = defaultDockLayout(); assertComplete(layout);
    expect(layout.open).toEqual({ explorador: false, componentes: true, circuito: true, codigo: true, consola: true });
    expect(layout.root).toMatchObject({ axis: 'vertical', sizes: [72, 28] });
    for (const id of DOCK_WINDOWS) expect(location(layout, id).id).toBe(`grupo-${id}`);
    expect(defaultDockLayout()).not.toBe(layout);
  });
  it('reconstruye JSON persistido sin compartir objetos con la entrada', () => {
    let layout = moveDockWindow(defaultDockLayout(), 'consola', 'grupo-codigo', 'center');
    layout = setDockWindowOpen(layout, 'codigo', false);
    const raw = JSON.parse(JSON.stringify(layout));
    const normalized = normalizeDockLayout(raw);
    assertComplete(normalized);
    expect(normalized.open).toEqual(layout.open);
    expect(location(normalized, 'consola').views).toEqual(['codigo', 'consola']);
    expect(normalized.root).not.toBe(raw.root);
    raw.open.consola = false;
    expect(normalized.open.consola).toBe(true);
  });
  it.each([null, undefined, [], {}, { version: 2 }, { version: 1, open: {}, root: {} }])('restaura el default ante entrada inválida %j', value => {
    expect(normalizeDockLayout(value)).toEqual(defaultDockLayout());
  });
  it('rechaza duplicaciones de ventanas e ids, falta de ventanas y active inexistente', () => {
    for (const corrupt of [
      (layout: DockLayout) => { location(layout, 'codigo').views.push('circuito'); },
      (layout: DockLayout) => { location(layout, 'codigo').id = 'grupo-circuito'; },
      (layout: DockLayout) => { location(layout, 'codigo').views = []; },
      (layout: DockLayout) => { location(layout, 'codigo').active = 'consola'; },
    ]) {
      const layout = defaultDockLayout(); corrupt(layout);
      expect(normalizeDockLayout(layout)).toEqual(defaultDockLayout());
    }
  });
  it('rechaza un layout coherente pero incompleto y un registro de apertura inválido', () => {
    const incomplete = defaultDockLayout();
    incomplete.root = { kind: 'group', id: 'grupo-unico', views: ['explorador', 'componentes', 'circuito', 'consola'], active: 'circuito' };
    expect(normalizeDockLayout(incomplete)).toEqual(defaultDockLayout());
    const badOpen = { ...defaultDockLayout(), open: { ...defaultDockLayout().open, codigo: 'true' } };
    expect(normalizeDockLayout(badOpen)).toEqual(defaultDockLayout());
  });
  it('rechaza pesos inválidos, payload enorme y árboles demasiado profundos o cíclicos', () => {
    const invalid = defaultDockLayout(); (invalid.root as DockSplit).sizes = [NaN, 28];
    expect(normalizeDockLayout(invalid)).toEqual(defaultDockLayout());
    const huge = defaultDockLayout(); (huge.root as DockSplit).children = Array.from({ length: 10000 }, () => location(huge, 'codigo'));
    expect(normalizeDockLayout(huge)).toEqual(defaultDockLayout());
    let deep: DockNode = defaultDockLayout().root;
    for (let i = 0; i < 20; i++) deep = { kind: 'split', id: `deep-${i}`, axis: 'vertical', sizes: [50, 50], children: [deep, { kind: 'group', id: `extra-${i}`, views: ['codigo'], active: 'codigo' }] };
    expect(normalizeDockLayout({ ...defaultDockLayout(), root: deep })).toEqual(defaultDockLayout());
    const cyclic = defaultDockLayout(); (cyclic.root as DockSplit).children[0] = cyclic.root;
    expect(normalizeDockLayout(cyclic)).toEqual(defaultDockLayout());
  });
});

describe('movimientos de docking inmutables', () => {
  it.each(['left', 'right', 'top', 'bottom'] as const)('crea división al mover a %s', zone => {
    const original = freeze(defaultDockLayout()); const before = JSON.stringify(original);
    const changed = moveDockWindow(original, 'consola', 'grupo-circuito', zone);
    assertComplete(changed); expect(JSON.stringify(original)).toBe(before);
    const split = nodes(changed.root).find((node): node is DockSplit => node.kind === 'split' && node.children.some(child => child.id === 'grupo-circuito'));
    expect(split?.axis).toBe(zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical');
    expect(split?.children[zone === 'left' || zone === 'top' ? 0 : 1]).toMatchObject({ kind: 'group', views: ['consola'] });
    expect(nodes(changed.root).some(node => node.id === 'split-workspace')).toBe(false);
  });
  it('agrupa pestañas en el centro, colapsa grupos vacíos y activa la movida', () => {
    const changed = moveDockWindow(defaultDockLayout(), 'componentes', 'grupo-codigo', 'center');
    assertComplete(changed);
    expect(location(changed, 'codigo')).toMatchObject({ views: ['codigo', 'componentes'], active: 'componentes' });
    expect(nodes(changed.root).some(node => node.id === 'grupo-componentes' || node.id === 'split-izquierdo')).toBe(false);
    const separated = moveDockWindow(changed, 'componentes', 'grupo-codigo', 'left');
    assertComplete(separated);
    expect(location(separated, 'codigo').views).toEqual(['codigo']);
    expect(location(separated, 'componentes').id).toBe('grupo-componentes');
  });
  it('mueve entre pestañas y separa una pestaña del mismo grupo sin duplicaciones', () => {
    const combined = moveDockWindow(defaultDockLayout(), 'circuito', 'grupo-codigo', 'center');
    const separated = moveDockWindow(combined, 'circuito', 'grupo-codigo', 'bottom');
    assertComplete(separated);
    expect(location(separated, 'codigo').views).toEqual(['codigo']);
    expect(location(separated, 'circuito').views).toEqual(['circuito']);
    expect(location(separated, 'codigo').id).not.toBe(location(separated, 'circuito').id);
  });
  it('genera ids únicos cuando el id original sigue ocupado por otras pestañas', () => {
    let layout = moveDockWindow(defaultDockLayout(), 'codigo', 'grupo-explorador', 'center');
    layout = moveDockWindow(layout, 'explorador', 'grupo-circuito', 'right');
    assertComplete(layout);
    expect(location(layout, 'codigo').id).toBe('grupo-explorador');
    expect(location(layout, 'explorador').id).not.toBe('grupo-explorador');
  });
  it('ignora targets inexistentes y arrastrar una ventana sola sobre sí misma', () => {
    const layout = defaultDockLayout();
    expect(moveDockWindow(layout, 'consola', 'inexistente', 'right')).toBe(layout);
    expect(moveDockWindow(layout, 'consola', 'grupo-consola', 'bottom')).toBe(layout);
    expect(moveDockWindow(layout, 'consola', 'grupo-consola', 'center')).toBe(layout);
  });
  it('conserva completas las ventanas tras una serie larga de movimientos', () => {
    let layout = defaultDockLayout();
    for (let i = 0; i < 30; i++) {
      const view = DOCK_WINDOWS[i % 5]; const target = location(layout, DOCK_WINDOWS[(i + 1) % 5]);
      layout = moveDockWindow(layout, view, target.id, i % 2 ? 'center' : 'left');
      assertComplete(layout);
    }
  });
});

describe('apertura, pestañas y porcentajes', () => {
  it('cerrar no destruye la ubicación; reabrir activa la ventana', () => {
    const initial = moveDockWindow(defaultDockLayout(), 'consola', 'grupo-codigo', 'center');
    const closed = setDockWindowOpen(initial, 'consola', false);
    expect(location(closed, 'consola').id).toBe(location(initial, 'consola').id);
    expect(location(closed, 'codigo').active).toBe('codigo');
    const reopened = setDockWindowOpen(closed, 'consola', true);
    expect(location(reopened, 'consola').active).toBe('consola');
    expect(reopened.open.consola).toBe(true); expect(closed.open.consola).toBe(false);
    assertComplete(reopened);
  });
  it('no elimina grupos cuando todas sus pestañas están cerradas', () => {
    const initial = moveDockWindow(defaultDockLayout(), 'consola', 'grupo-codigo', 'center');
    const closed = setDockWindowOpen(setDockWindowOpen(initial, 'consola', false), 'codigo', false);
    expect(location(closed, 'codigo').views).toEqual(['codigo', 'consola']);
    expect(location(setDockWindowOpen(closed, 'codigo', true), 'codigo').active).toBe('codigo');
    assertComplete(closed);
  });
  it('activa sólo pestañas pertenecientes al grupo', () => {
    const initial = moveDockWindow(defaultDockLayout(), 'consola', 'grupo-codigo', 'center');
    const changed = activateDockTab(initial, 'grupo-codigo', 'codigo');
    expect(location(changed, 'codigo').active).toBe('codigo');
    expect(changed.open).toBe(initial.open);
    expect(activateDockTab(changed, 'grupo-codigo', 'componentes')).toBe(changed);
    expect(activateDockTab(changed, 'missing', 'codigo')).toBe(changed);
  });
  it('redimensiona sólo el split indicado y normaliza la suma', () => {
    const initial = freeze(defaultDockLayout());
    const changed = resizeDockSplit(initial, 'split-superior', [1, 2, 1]);
    expect(nodes(changed.root).find(n => n.id === 'split-superior')).toMatchObject({ sizes: [25, 50, 25] });
    expect((initial.root as DockSplit).sizes).toEqual([72, 28]);
    expect(resizeDockSplit(initial, 'split-superior', [10, 90])).toBe(initial);
    expect(resizeDockSplit(initial, 'split-superior', [0, 50, 50])).toBe(initial);
    expect(resizeDockSplit(initial, 'missing', [50, 50])).toBe(initial);
    assertComplete(changed);
  });
});
