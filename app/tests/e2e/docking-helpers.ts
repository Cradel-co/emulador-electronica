import { expect, type Locator, type Page } from '@playwright/test';

export type DockZone = 'left' | 'right' | 'top' | 'bottom' | 'center';
const titles: Record<string, string> = {
  explorador: 'Explorador', componentes: 'Componentes', circuito: 'Circuito', codigo: 'Código', detalle: 'Detalle', consola: 'Consola',
};

export function grupoVentana(page: Page, id: string): Locator {
  // Las pestañas conservan su grupo aunque el motor desconecte el panel inactivo.
  return page.locator('#dock-layout [data-dock-group]').filter({
    has: page.getByRole('tab', { name: titles[id], exact: true, includeHidden: true }),
  });
}

export function previewDock(page: Page, zone?: DockZone): Locator {
  const position = zone ? `.dv-drop-target-${zone}` : '';
  return page.locator(`.dv-drop-target-anchor${position}:visible, .dv-drop-target-selection${position}:visible`);
}

export function agarreVentana(page: Page, title: string): Locator {
  return page.getByRole('button', { name: `Mover ventana ${title}`, exact: true }).filter({ visible: true });
}

/** Arrastra con eventos de puntero reales, sin invocar la API del motor. */
export async function arrastrarVentana(page: Page, title: string, targetId: string, zone: DockZone) {
  const handle = page.getByRole('tab', { name: title, exact: true }).locator('.dock-window-tab > span').nth(1);
  // El área de contenido evita activar la reordenación de pestañas al apuntar arriba.
  const target = grupoVentana(page, targetId).locator('.dv-content-container');
  await expect(handle).toBeVisible();
  await expect(target).toBeVisible();
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  const x = to!.x + to!.width * (zone === 'left' ? 0.12 : zone === 'right' ? 0.88 : 0.5);
  const y = to!.y + to!.height * (zone === 'top' ? 0.12 : zone === 'bottom' ? 0.88 : 0.5);
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(x, y, { steps: 8 });
    await expect(previewDock(page, zone).first()).toBeVisible();
  } finally {
    await page.mouse.up();
  }
  await expect(previewDock(page)).toHaveCount(0);
}
