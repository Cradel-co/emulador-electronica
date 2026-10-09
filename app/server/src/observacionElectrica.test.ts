import { expect, it } from 'vitest';
import { ProjectSchema, type ObservacionElectrica } from '@emu/shared';
import { finalizarObservacion, revisionElectrica } from './observacionElectrica.js';
import { VigenciaElectrica } from './vigenciaElectrica.js';

const lectura: ObservacionElectrica = {
  contexto: { proyecto: 'prueba', placas: ['board', 'aux'], corrida: 1, revision: 'r', topologia: 'fixture' },
  estado: 'valida', resuelto: true, nivelesPorPlaca: { board: { 7: 1 }, aux: { 7: 0 } },
  leds: [{ id: 'led', mA: 8, mAFijo: 8, estado: 'ok' }], fuentes: [], placa: null, placas: {},
  energizado: true, tensiones: { 'led.IN': 2 }, mediciones: [], modulos: { led: { on: true } }, sonidos: [],
};

it('una recarga durante la consulta retira niveles y medidas sin convertirlos en cero', async () => {
  const vigencia = new VigenciaElectrica();
  const vigente = vigencia.capturar();
  const r = finalizarObservacion(lectura, async () => {
    await vigencia.cambiar(async () => undefined);
    return vigente();
  });
  expect(await r).toMatchObject({ estado: 'obsoleta', resuelto: false, contexto: lectura.contexto,
    nivelesPorPlaca: {}, leds: [], tensiones: {}, modulos: {}, energizado: false });
  expect(lectura.tensiones['led.IN']).toBe(2);
});

it('un cambio de corrida invalida incluso si vuelve al mismo nombre de proyecto', async () => {
  let corrida = 1;
  const vigente = new VigenciaElectrica().capturar(() => corrida === 1);
  corrida = 2;
  expect((await finalizarObservacion(lectura, async () => vigente())).estado).toBe('obsoleta');
});

it('un fallo resuelto como inválido no deja sobrevivir la última medida', async () => {
  expect(await finalizarObservacion({ ...lectura, resuelto: false }, async () => true))
    .toMatchObject({ estado: 'no-resuelta', resuelto: false, leds: [], tensiones: {}, placas: {}, placa: null });
});

it('una lectura válida de cero voltios se conserva y no se confunde con ausencia de dato', async () => {
  const cero = { ...lectura, tensiones: { 'led.IN': 0 } };
  expect(await finalizarObservacion(cero, async () => true)).toBe(cero);
});

it('un cambio de energía o control invalida la consulta aunque se vuelva al valor anterior', () => {
  const vigencia = new VigenciaElectrica();
  const vigente = vigencia.capturar();
  vigencia.invalidar();
  vigencia.invalidar();
  expect(vigente()).toBe(false);
  expect(vigencia.capturar()()).toBe(true);
});

it('la huella cambia al agregar módulos y modificar propiedades', () => {
  const p = ProjectSchema.parse({ name: 'prueba', board: null, language: null, modules: [], wires: [],
    sim: { wifiSsid: 'x', wifiPassword: '' } });
  const base = revisionElectrica(p);
  expect(revisionElectrica(structuredClone(p))).toBe(base);
  p.modules.push({ id: 'r', type: 'resistor', x: 0, y: 0, props: { ohms: 220 } });
  const conR = revisionElectrica(p);
  expect(conR).not.toBe(base);
  const r = p.modules[0];
  if (!r) throw new Error('Falta la resistencia de la prueba');
  r.props.ohms = 100;
  expect(revisionElectrica(p)).not.toBe(conR);
  const antesDeMover = revisionElectrica(p);
  r.x = 200;
  r.rotation = 90;
  expect(revisionElectrica(p)).toBe(antesDeMover);
  p.wires.push({ from: 'r.1', to: 'r.2' });
  expect(revisionElectrica(p)).not.toBe(antesDeMover);
});
