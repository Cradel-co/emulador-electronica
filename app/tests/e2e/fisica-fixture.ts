import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { ProjectSchema, type ModuleDef } from '@emu/shared';
import { analizarCircuito, type DireccionPin } from '../../server/src/sim/analisis.js';
import { conPlaca } from '../../server/src/diagramOps.js';
import { estadoAlimentacion } from '../../server/src/estadoAlimentacion.js';

/** Declara las salidas del firmware; las corrientes y tensiones las calcula el motor real. */
export async function firmwareFixture(page: Page, request: APIRequestContext, inicial: 0 | 1 = 1) {
  let nivel = inicial;
  let proyecto = '';
  let enviar: ((mensaje: object) => void) | undefined;
  const catalogo: (ModuleDef & { modeloCodigo?: string })[] = (await (await request.get('/api/modules')).json()).modules;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const servidor = ws.connectToServer();
    enviar = (mensaje) => ws.send(JSON.stringify(mensaje));
    ws.onMessage((mensaje) => servidor.send(mensaje));
    servidor.onMessage((mensaje) => ws.send(mensaje));
  });
  await page.route(/\/api\/projects\/[^/]+\/pins$/, async (route) => {
    proyecto = new URL(route.request().url()).pathname.split('/')[3] ?? '';
    const respuesta = await route.fetch();
    const json = await respuesta.json();
    const datos = await (await request.get(`/api/projects/${proyecto}`)).json();
    const resultado = await analizarCircuito(conPlaca(ProjectSchema.parse(datos.project)),
      (tipo) => catalogo.find((m) => m.type === tipo), {
        nivelesReales: true, niveles: new Map([[7, nivel]]),
        direcciones: new Map<number, DireccionPin>([[6, { salida: false, pull: 'down' }], [7, { salida: true }]]),
      });
    expect(resultado.resuelto).toBe(true);
    json.electrico = { ...json.electrico, ...resultado,
      placa: estadoAlimentacion(resultado.alimentacion, resultado.resuelto),
      modulos: Object.fromEntries(Object.entries(resultado.modulos).map(([id, m]) => [id, m.ui ?? {}])),
      mediciones: resultado.elementos.map((e) => ({ modulo: e.dueno, moduloNombre: e.dueno,
        elemento: e.local, tipo: e.tipo, tensionV: e.va - e.vb, corrienteMa: e.i * 1000,
        potenciaMw: e.p * 1000, resistenciaOhm: e.ohms ?? null })),
      placas: Object.fromEntries(Object.entries(resultado.alimentacionesPorPlaca ?? {})
        .map(([id, a]) => [id, estadoAlimentacion(a, resultado.resuelto)])),
    };
    json.warnings = [...json.warnings.filter((w: { kind: string }) => !['peligro-electrico', 'advertencia-electrica'].includes(w.kind)),
      ...resultado.avisos.map((a) => ({ kind: `${a.severidad === 'peligro' ? 'peligro' : 'advertencia'}-electrico`, pin: a.pin, message: a.mensaje, refs: a.refs }))];
    await route.fulfill({ response: respuesta, json });
  });
  return {
    async ponerNivel(valor: 0 | 1) {
      nivel = valor;
      await expect.poll(() => Boolean(enviar && proyecto)).toBe(true);
      enviar?.({ type: 'pin.out', pin: 7, level: valor, boardId: 'board', project: proyecto });
      enviar?.({ type: 'project.changed', project: proyecto, what: 'electrico', origin: 'fixture' });
    },
  };
}

export const ledPrendido = (page: Page, id: string) => page.locator(`.modulo[data-id="${id}"]`)
  .locator('[data-si="on"]').first().evaluate((el) => el.getAttribute('display') !== 'none');
