export type ToolWindowId = 'explorador' | 'componentes';
export type ToolDock = 'izq' | 'der';
export type ToolWindowLayout = Record<ToolWindowId, { open: boolean; dock: ToolDock }>;

/** Solo admite las posiciones conocidas; una preferencia dañada vuelve al diseño inicial. */
export function toolWindowLayout(value: unknown): ToolWindowLayout {
  const result: ToolWindowLayout = {
    explorador: { open: false, dock: 'izq' },
    componentes: { open: true, dock: 'izq' },
  };
  if (!value || typeof value !== 'object') return result;
  for (const id of ['explorador', 'componentes'] as const) {
    const item = (value as Record<string, unknown>)[id];
    if (!item || typeof item !== 'object') continue;
    const pref = item as Record<string, unknown>;
    if (typeof pref.open === 'boolean') result[id].open = pref.open;
    if (pref.dock === 'izq' || pref.dock === 'der') result[id].dock = pref.dock;
  }
  return result;
}
