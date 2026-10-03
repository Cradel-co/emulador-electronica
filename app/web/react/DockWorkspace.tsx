import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { acciones, estado } from './puente.js';
import { useEstado } from './estado.js';
import type { DockLayout, DockNode, WindowId } from '../docking-layout.js';

const TITLES: Record<WindowId, string> = { explorador: 'Explorador', componentes: 'Componentes', circuito: 'Circuito', codigo: 'Código', consola: 'Consola' };
type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center';
type Drop = { group: string; zone: Zone; rect: DOMRect };
type Drag = { view: WindowId; x: number; y: number; drop: Drop | null };

function visible(node: DockNode, layout: DockLayout): boolean {
  return node.kind === 'group' ? node.views.some(id => layout.open[id]) : node.children.some(child => visible(child, layout));
}
function dropAt(x: number, y: number): Drop | null {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-dock-group]');
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const nx = (x - rect.left) / rect.width;
  const ny = (y - rect.top) / rect.height;
  const zone: Zone = nx < .25 ? 'left' : nx > .75 ? 'right' : ny < .25 ? 'top' : ny > .75 ? 'bottom' : 'center';
  return { group: element.dataset.dockGroup ?? '', zone, rect };
}

/** Los slots cambian de lugar; los nodos originales del editor y la simulación se conservan. */
export function DockWorkspace() {
  const layout = useEstado(() => estado().distribucion as DockLayout);
  const root = useRef<HTMLDivElement>(null);
  const nodes = useRef<Map<WindowId, HTMLElement> | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pending = useRef<{ view: WindowId; x: number; y: number; pointer: number } | null>(null);
  const resize = useRef<{ split: string; axis: string; first: number; second: number; sizes: number[]; coordinate: number; length: number; weight: number } | null>(null);
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!nodes.current) {
    nodes.current = new Map();
    for (const id of Object.keys(TITLES) as WindowId[]) {
      const element = document.getElementById(`ventana-${id}`);
      if (element) nodes.current.set(id, element);
    }
  }
  useLayoutEffect(() => {
    for (const [id, element] of nodes.current ?? []) {
      const slot = root.current?.querySelector<HTMLElement>(`[data-dock-slot="${id}"]`);
      if (slot && element.parentElement !== slot) slot.appendChild(element);
      element.hidden = !layout.open[id];
    }
    if (focus?.isConnected && !focus.closest('[hidden]') && document.activeElement !== focus) focus.focus({ preventScroll: true });
    window.dispatchEvent(new Event('resize'));
  }, [layout]);
  const cancel = () => {
    dragRef.current = null; pending.current = null; resize.current = null;
    setDrag(null); document.body.classList.remove('dock-dragging');
  };
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pending.current || dragRef.current || resize.current) { e.preventDefault(); e.stopPropagation(); }
      cancel();
    };
    const blur = () => cancel();
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', blur); };
  }, []);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-window-drag]');
    if (!handle) return;
    e.preventDefault();
    pending.current = { view: handle.dataset.windowDrag as WindowId, x: e.clientX, y: e.clientY, pointer: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (resize.current) {
      const r = resize.current;
      const coordinate = r.axis === 'horizontal' ? e.clientX : e.clientY;
      const sum = r.sizes[r.first] + r.sizes[r.second];
      const delta = (coordinate - r.coordinate) / r.length * r.weight;
      const minimum = Math.min(sum / 3, 110 / r.length * r.weight);
      const first = Math.min(sum - minimum, Math.max(minimum, r.sizes[r.first] + delta));
      const sizes = [...r.sizes]; sizes[r.first] = first; sizes[r.second] = sum - first;
      acciones().redimensionarDistribucion(r.split, sizes);
      return;
    }
    const p = pending.current;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
    const next = { view: p.view, x: e.clientX, y: e.clientY, drop: dropAt(e.clientX, e.clientY) };
    dragRef.current = next; setDrag(next);
    document.body.classList.add('dock-dragging');
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (current?.drop) acciones().moverVentana(current.view, current.drop.group, current.drop.zone);
    cancel();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const render = (node: DockNode): ReactNode => {
    if (node.kind === 'group') {
      const shown = node.views.filter(id => layout.open[id]);
      const active = shown.includes(node.active) ? node.active : shown[0];
      return <section key={node.id} className="dock-group" data-dock-group={node.id} hidden={!shown.length}>
        {shown.length > 1 && <div className="dock-tabs" role="tablist" aria-label="Ventanas agrupadas">
          {shown.map(id => <button key={id} role="tab" aria-selected={active === id} aria-controls={`slot-${id}`} onClick={() => acciones().activarVentana(node.id, id)}>{TITLES[id]}</button>)}
        </div>}
        {node.views.map(id => <div key={id} id={`slot-${id}`} className="dock-slot" data-dock-slot={id} hidden={!layout.open[id] || active !== id} />)}
      </section>;
    }
    const shown = node.children.map((child, i) => visible(child, layout) ? i : -1).filter(i => i >= 0);
    return <div key={node.id} className={`dock-split ${node.axis}`} data-dock-split-node={node.id} hidden={!shown.length}>
      {node.children.map((child, index) => {
        const position = shown.indexOf(index);
        const previous = position > 0 ? shown[position - 1] : -1;
        return <div key={child.id} className="dock-branch" hidden={position < 0} style={{ flexGrow: node.sizes[index] ?? 1 }}>
          {previous >= 0 && <div className="dock-separator" role="separator" aria-label="Redimensionar ventanas" aria-orientation={node.axis === 'horizontal' ? 'vertical' : 'horizontal'}
            data-dock-split={node.id} data-resize={node.id === 'split-superior' && index === 1 ? 'izq' : undefined} tabIndex={0}
            onKeyDown={e => {
              const increase = node.axis === 'horizontal' ? e.key === 'ArrowRight' : e.key === 'ArrowDown';
              const decrease = node.axis === 'horizontal' ? e.key === 'ArrowLeft' : e.key === 'ArrowUp';
              if (!increase && !decrease) return;
              e.preventDefault();
              const sizes = [...node.sizes]; const step = sizes.reduce((a, b) => a + b, 0) * .03 * (increase ? 1 : -1);
              if (sizes[previous] + step > .05 && sizes[index] - step > .05) {
                sizes[previous] += step; sizes[index] -= step; acciones().redimensionarDistribucion(node.id, sizes);
              }
            }}
            onPointerDown={e => {
              e.preventDefault(); e.stopPropagation();
              const box = e.currentTarget.closest('[data-dock-split-node]')?.getBoundingClientRect();
              if (!box) return;
              resize.current = { split: node.id, axis: node.axis, first: previous, second: index, sizes: [...node.sizes], coordinate: node.axis === 'horizontal' ? e.clientX : e.clientY, length: node.axis === 'horizontal' ? box.width : box.height, weight: shown.reduce((sum, i) => sum + node.sizes[i], 0) };
              root.current?.setPointerCapture(e.pointerId);
            }} />}
          {render(child)}
        </div>;
      })}
    </div>;
  };
  const preview = drag?.drop;
  const rect = preview?.rect;
  const style = rect && preview ? {
    left: rect.left + (preview.zone === 'right' ? rect.width / 2 : 0),
    top: rect.top + (preview.zone === 'bottom' ? rect.height / 2 : 0),
    width: preview.zone === 'left' || preview.zone === 'right' ? rect.width / 2 : rect.width,
    height: preview.zone === 'top' || preview.zone === 'bottom' ? rect.height / 2 : rect.height,
  } : undefined;
  return <div ref={root} className="dock-workspace" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}>
    {render(layout.root)}
    {!Object.values(layout.open).some(Boolean) && <p className="dock-empty">Abrí una ventana desde los iconos laterales o desde el menú Ver.</p>}
    {preview && <div className="dock-preview" data-dock-zone={preview.zone} style={style} />}
    {drag && <div className="dock-ghost" style={{ left: drag.x + 16, top: drag.y + 16 }}>{TITLES[drag.view]}</div>}
  </div>;
}
