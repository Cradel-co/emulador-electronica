import { test, expect } from '@playwright/test';
import { abrirProyectoNuevo, modulo } from './helpers.js';

/**
 * El canvas refresca los niveles de pin sin rearmar el dibujo (issue #13). Dos cosas que hay
 * que probar juntas, porque por separado se pueden aprobar sin que nada funcione: que el LED
 * efectivamente se prenda y apague, y que hacerlo no cree ni destruya nodos.
 */

/** Deja al alcance el WebSocket que abre la app, para inyectarle eventos como si vinieran del server. */
async function tomarWebSocket(page: any) {
  await page.addInitScript(() => {
    const Orig = window.WebSocket;
    (window as any).WebSocket = class extends Orig {
      constructor(...a: any[]) { super(...(a as [string])); (window as any).__ws = this; }
    };
  });
}

/** Cuenta las mutaciones del lienzo mientras corre `accion`. */
async function mutacionesDurante(page: any, accion: (p: any) => Promise<void>) {
  await page.evaluate(() => {
    const w = window as any;
    w.__mut = { agregados: 0, quitados: 0, atributos: 0 };
    w.__obs = new MutationObserver((lista) => {
      for (const m of lista) {
        if (m.type === 'attributes') w.__mut.atributos++;
        w.__mut.agregados += m.addedNodes.length;
        w.__mut.quitados += m.removedNodes.length;
      }
    });
    w.__obs.observe(document.getElementById('lienzo')!, { childList: true, subtree: true, attributes: true });
  });
  await accion(page);
  return page.evaluate(() => { (window as any).__obs.disconnect(); return (window as any).__mut; });
}

const pulso = (page: any, pin: number, level: number) => page.evaluate(
  ([pin, level]: number[]) => new Promise<void>((listo) => {
    (window as any).__ws.onmessage({ data: JSON.stringify({ type: 'pin.out', pin, level }) });
    requestAnimationFrame(() => requestAnimationFrame(() => listo()));
  }), [pin, level],
);

/** ¿Están visibles las partes del LED marcadas `data-si="on"`? */
const ledPrendido = (page: any, id: string) => modulo(page, id)
  .locator('[data-si="on"]').first().evaluate((el: Element) => el.getAttribute('display') !== 'none');

test('un cambio de nivel de pin prende el LED y no crea ni destruye nodos', async ({ page, request }) => {
  await tomarWebSocket(page);
  await abrirProyectoNuevo(page, request);
  // El circuito de prueba del ESP32-S3: botón en GPIO6, LED en GPIO7 con su resistencia.
  await expect(modulo(page, 'led1')).toBeVisible();
  await page.waitForTimeout(800); // que termine de encuadrar y lleguen los avisos

  expect(await ledPrendido(page, 'led1')).toBe(false);

  const prender = await mutacionesDurante(page, (p) => pulso(p, 7, 1));
  expect(await ledPrendido(page, 'led1')).toBe(true);
  expect(prender.agregados, 'prender un LED no debe crear nodos').toBe(0);
  expect(prender.quitados, 'prender un LED no debe destruir nodos').toBe(0);
  expect(prender.atributos, 'pero sí debe tocar algún atributo, o no se vería').toBeGreaterThan(0);

  const apagar = await mutacionesDurante(page, (p) => pulso(p, 7, 0));
  expect(await ledPrendido(page, 'led1')).toBe(false);
  expect(apagar.agregados).toBe(0);
  expect(apagar.quitados).toBe(0);
  expect(apagar.atributos).toBeGreaterThan(0);
});

test('el costo de un pin.out no crece con el tamaño del circuito', async ({ page, request }) => {
  test.setTimeout(180_000);
  await tomarWebSocket(page);
  const name = `render-${Date.now().toString(36)}`;
  await request.post('/api/projects', { data: { name, language: 'esphome' } });
  // 100 LEDs con su resistencia: 201 módulos y 200 cables.
  const modules: any[] = [{ id: 'board', type: 'esp32-s3-devkitc-1', x: 0, y: 0, props: { usb: true } }];
  const wires: any[] = [];
  for (let i = 0; i < 100; i++) {
    const x = 300 + (i % 20) * 120;
    const y = 200 + Math.floor(i / 20) * 140;
    modules.push({ id: `led${i}`, type: 'led', x, y, props: { color: 'red' } });
    modules.push({ id: `r${i}`, type: 'resistor', x: x + 60, y, props: { ohms: 220 } });
    wires.push({ from: `r${i}.1`, to: `led${i}.IN` }, { from: `led${i}.GND`, to: 'board.GND' });
  }
  await request.put(`/api/projects/${name}/diagram`, { data: { modules, wires } });
  await page.goto(`/#${name}`);
  await expect(modulo(page, 'led99')).toBeAttached();
  await page.waitForTimeout(1200);

  const nodos = await page.evaluate(() => document.querySelectorAll('#lienzo *').length);
  expect(nodos).toBeGreaterThan(4000); // circuito grande de verdad

  const PULSOS = 40;
  const mut = await mutacionesDurante(page, async (p) => {
    for (let i = 0; i < PULSOS; i++) await pulso(p, 7, i % 2);
  });
  // Antes de #13 esto rearmaba el SVG entero: ~6.293 nodos por pulso con este circuito.
  expect(mut.agregados, `${PULSOS} pulsos no deben crear ni un nodo`).toBe(0);
  expect(mut.quitados).toBe(0);
  console.log(`   ${nodos} nodos en el SVG, ${PULSOS} pulsos: 0 nodos creados, ${mut.atributos} atributos tocados`);
});
