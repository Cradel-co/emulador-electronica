import { useLayoutEffect, useRef } from 'react';
import { acciones, estado } from './puente.js';
import { useEstado } from './estado.js';
import { DOCK_WINDOWS, setDockWindowOpen, type DockLayout, type WindowId } from '../docking-layout.js';
import { createDockingEngine, type DockingEngine } from '../docking-engine.js';

/** Isla de integración: el motor queda encapsulado y los paneles originales conservan su identidad. */
export function DockWorkspace() {
  const layout = useEstado(() => estado().distribucion as DockLayout);
  const root = useRef<HTMLDivElement>(null);
  const engine = useRef<DockingEngine | null>(null);
  useLayoutEffect(() => {
    if (!root.current) return;
    const nodes = new Map<WindowId, HTMLElement>();
    for (const id of DOCK_WINDOWS) {
      const node = document.getElementById(`ventana-${id}`);
      if (node) nodes.set(id, node);
    }
    engine.current = createDockingEngine(root.current, estado().distribucion as DockLayout, {
      nodes,
      onLayout: next => acciones().aplicarDistribucion(next),
      onClose: id => acciones().aplicarDistribucion(setDockWindowOpen(estado().distribucion as DockLayout, id, false)),
    });
    return () => { engine.current?.dispose(); engine.current = null; };
  }, []);
  useLayoutEffect(() => engine.current?.setLayout(layout), [layout]);
  return <div ref={root} className="dock-workspace dockview-adapter" />;
}
