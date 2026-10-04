import { describe, expect, it } from 'vitest';
import { fromDockviewLayout, toDockviewLayout } from '../../web/docking-engine.js';
import { defaultDockLayout, moveDockWindow, normalizeDockLayout, setDockWindowOpen, type DockLayout, type DockNode } from '../../web/docking-layout.js';

const roundtrip = (layout: DockLayout) => fromDockviewLayout(toDockviewLayout(layout, 1600, 950), layout);
function expectEquivalent(actual: DockLayout, expected: DockLayout) {
  expect(actual.open).toEqual(expected.open);
  function visit(a: DockNode, b: DockNode) {
    expect(a.kind).toBe(b.kind);
    expect(a.id).toBe(b.id);
    if (a.kind === 'group' && b.kind === 'group') expect(a).toEqual(b);
    if (a.kind === 'split' && b.kind === 'split') {
      expect(a.axis).toBe(b.axis);
      expect(a.children).toHaveLength(b.children.length);
      a.sizes.forEach((size, i) => expect(size).toBeCloseTo(b.sizes[i], 10));
      a.children.forEach((child, i) => visit(child, b.children[i]));
    }
  }
  visit(actual.root, expected.root);
}

describe('adaptador del motor de ventanas', () => {
  it('conserva árbol, proporciones y posiciones de ventanas cerradas', () => {
    const layout = normalizeDockLayout(defaultDockLayout());
    expectEquivalent(roundtrip(layout), layout);
  });

  it('conserva pestañas agrupadas y una pestaña cerrada dentro de un grupo abierto', () => {
    let layout = moveDockWindow(defaultDockLayout(), 'componentes', 'grupo-circuito', 'center');
    layout = setDockWindowOpen(layout, 'componentes', false);
    expectEquivalent(roundtrip(normalizeDockLayout(layout)), normalizeDockLayout(layout));
  });

  it('conserva divisiones consecutivas del mismo eje', () => {
    let layout = moveDockWindow(defaultDockLayout(), 'consola', 'grupo-codigo', 'right');
    layout = normalizeDockLayout(layout);
    expectEquivalent(roundtrip(layout), layout);
  });

  it('conserva un único grupo aunque todas las ventanas estén cerradas', () => {
    let layout = defaultDockLayout();
    for (const id of ['explorador', 'componentes', 'codigo', 'consola'] as const) {
      layout = moveDockWindow(layout, id, 'grupo-circuito', 'center');
    }
    for (const id of Object.keys(layout.open) as (keyof typeof layout.open)[]) layout = setDockWindowOpen(layout, id, false);
    layout = normalizeDockLayout(layout);
    expectEquivalent(roundtrip(layout), layout);
  });

  it('mantiene la distribución anterior cuando el motor entrega datos ilegibles', () => {
    const layout = defaultDockLayout();
    expect(fromDockviewLayout({} as ReturnType<typeof toDockviewLayout>, layout)).toBe(layout);
  });

  it.each(['duplicada', 'desconocida', 'faltante'] as const)('rechaza una ventana %s sin reemplazar el estado del proyecto', caso => {
    const layout = moveDockWindow(defaultDockLayout(), 'componentes', 'grupo-circuito', 'center');
    const serial = toDockviewLayout(layout);
    function corrupt(node: typeof serial.grid.root): boolean {
      if (Array.isArray(node.data)) return node.data.some(corrupt);
      if (node.data.views.includes('circuito')) {
        if (caso === 'duplicada') node.data.views.push('codigo');
        if (caso === 'desconocida') node.data.views.push('desconocida');
        if (caso === 'faltante') node.data.views = ['circuito'];
        return true;
      }
      return false;
    }
    expect(corrupt(serial.grid.root)).toBe(true);
    expect(fromDockviewLayout(serial, layout)).toBe(layout);
  });
});
