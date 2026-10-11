import { describe, expect, it } from 'vitest';
import { type ObservacionElectrica, type Project } from '@emu/shared';
import { historialVacio, registrarObservacion, segmentosSerie, LIMITE_MUESTRAS } from '../../web/monitoreo.js';
const modulos: Project['modules'] = [{ id: 'mic', type: 'sonometro-sen0232', x: 0, y: 0, props: { dbA: 80 } }];
function observacion(corrida = 1): ObservacionElectrica {
  return { contexto: { proyecto: 'a', corrida, placas: [], revision: 'r', topologia: '' },
    nivelesPorPlaca: {}, leds: [], fuentes: [], placa: null, placas: {}, energizado: true, mediciones: [], modulos: {}, sonidos: [],
    estado: 'valida', resuelto: true, tensiones: { 'mic.OUT': 2.6, 'mic.GND': 1 } };
}
describe('historial de monitoreo', () => {
  it('separa el nivel del voltaje relativo a GND, con reloj y procedencia', () => {
    const h = registrarObservacion(historialVacio('a', 100), 'a', modulos, observacion(), 200);
    expect(h.muestras[0]?.valores['mic.salida']).toBeCloseTo(1.6);
    expect(h.muestras[0]?.valores['mic.nivel']).toBe(80);
    expect(h.muestras[0]?.tiempoMs).toBe(100);
    expect(h.series.map(s => s.unidad)).toEqual(['dBA', 'V']);
  });
  it('conserva estímulos fuera de rango sin recortarlos en el historial', () => {
    const h = registrarObservacion(historialVacio('a'), 'a', [{ id: 'mic', type: 'sonometro-sen0232', x: 0, y: 0, props: { dbA: 150 } }], observacion(), 1);
    expect(h.muestras[0]?.valores['mic.nivel']).toBe(150);
  });
  it.each(['invalida', 'sin-gnd', 'no-finita', 'otro-proyecto'])('deja huecos ante %s, sin reutilizar la última lectura', caso => {
    const h = registrarObservacion(historialVacio('a'), 'a', modulos, observacion(), 1);
    const o = observacion();
    if (caso === 'invalida') o.resuelto = false;
    if (caso === 'sin-gnd') delete o.tensiones['mic.GND'];
    if (caso === 'no-finita') o.tensiones['mic.OUT'] = NaN;
    if (caso === 'otro-proyecto') o.contexto.proyecto = 'otro';
    const siguiente = registrarObservacion(h, 'a', modulos, o, 2);
    expect(siguiente.muestras.at(-1)?.valores['mic.salida']).toBeNull();
    const final = registrarObservacion(siguiente, 'a', modulos, observacion(), 3);
    expect(segmentosSerie(final.muestras, 'mic.salida').map(s => s.length)).toEqual([1, 1]);
  });
  it('una resta que desborda tampoco se publica como tensión válida', () => {
    const o = observacion(); o.tensiones = { 'mic.OUT': 1e308, 'mic.GND': -1e308 };
    const h = registrarObservacion(historialVacio('a'), 'a', modulos, o, 1);
    expect(h.muestras[0]?.valores['mic.salida']).toBeNull();
  });
  it('una corrida o proyecto nuevo no retiene muestras anteriores', () => {
    const h = registrarObservacion(historialVacio('a'), 'a', modulos, observacion(), 1);
    expect(registrarObservacion(h, 'a', modulos, observacion(2), 2).muestras).toHaveLength(1);
    expect(registrarObservacion(h, 'b', modulos, null, 2).muestras).toHaveLength(1);
  });
  it('acota la memoria y cuenta los descartes', () => {
    let h = historialVacio('a');
    for (let t = 1; t <= LIMITE_MUESTRAS + 5; t++) h = registrarObservacion(h, 'a', modulos, observacion(), t);
    expect(h.muestras).toHaveLength(LIMITE_MUESTRAS); expect(h.descartadas).toBe(5);
    expect(h.muestras[0]?.tiempoMs).toBe(6);
  });
  it('no acepta tiempos que retroceden ni valores no finitos', () => {
    const h = registrarObservacion(historialVacio('a'), 'a', modulos, observacion(), 10);
    expect(registrarObservacion(h, 'a', modulos, observacion(), 9)).toBe(h);
    expect(registrarObservacion(h, 'a', modulos, observacion(), NaN)).toBe(h);
  });
});
