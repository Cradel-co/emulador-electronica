import { expect, it } from 'vitest';
import { crearInforme, informeHtml, formatearMedidaInforme, defaultProject, firmaDiagramaElectrico, type ObservacionElectrica } from '@emu/shared';
const proyecto = () => ({ ...defaultProject('informe', 'esphome'), modules: [{ id: 'r', type: 'resistor', x: 10, y: 20, rotation: 90, props: { ohms: 220, etiqueta: '<script>alert(1)</script>' } }], wires: [{ from: 'board.3V3', to: 'r.A' }] });
function lectura(): ObservacionElectrica {
  return { contexto: { proyecto: 'informe', placas: ['board'], corrida: 3, revision: 'fisica', topologia: firmaDiagramaElectrico(proyecto()) }, estado: 'valida', resuelto: true,
    nivelesPorPlaca: { board: { 7: 0 } }, leds: [], fuentes: [], placa: null, placas: {}, energizado: false,
    tensiones: { 'r.A': 0 }, mediciones: [{ modulo: 'r', moduloNombre: 'Resistencia', elemento: 'R', tipo: 'resistor', tensionV: 0, corrienteMa: -2, potenciaMw: 4, resistenciaOhm: 220 }], modulos: {}, sonidos: [] };
}
it('conserva circuito, signos y cero válido; separa unidades y excluye credenciales', () => {
  const p = proyecto(); p.sim.wifiPassword = 'clave-privada';
  const i = crearInforme(p, lectura(), 'persistida', [], '2026-10-09T00:00:00Z');
  expect(i.circuito.modules).toEqual(p.modules); expect(i.circuito.wires).toEqual(p.wires);
  expect(i.observacion.mediciones[0]).toMatchObject({ tensionV: 0, corrienteMa: -2, validez: 'valida' });
  expect(i.unidades).toEqual({ tension: 'V', corriente: 'mA', potencia: 'mW', resistencia: 'ohm' });
  expect(JSON.stringify(i)).not.toContain('clave-privada'); expect(i.catalogo[0]?.disponible).toBe(false);
  p.modules[0]?.props && (p.modules[0].props.ohms = 470); expect(i.circuito.modules[0]?.props.ohms).toBe(220);
});
it('retira medidas fallidas, obsoletas o de otra topología sin inventar ceros', () => {
  for (const l of [{ ...lectura(), estado: 'no-resuelta' as const }, { ...lectura(), estado: 'obsoleta' as const }, { ...lectura(), resuelto: false }, { ...lectura(), contexto: { ...lectura().contexto, proyecto: 'otro' } }, { ...lectura(), contexto: { ...lectura().contexto, topologia: 'otra' } }]) {
    const i = crearInforme(proyecto(), l, 'r', [], 'fecha');
    expect(i.observacion.resuelto).toBe(false); expect(i.observacion.mediciones).toEqual([]); expect(i.observacion.tensiones).toEqual({});
  }
});
it('no serializa números no finitos como medidas válidas', () => {
  const l = lectura(); const m = l.mediciones[0]; if (!m) throw new Error('fixture');
  m.tensionV = NaN; m.resistenciaOhm = Infinity; l.tensiones['r.A'] = Infinity;
  const i = crearInforme(proyecto(), l, 'r', [], 'fecha');
  expect(i.observacion.mediciones[0]).toMatchObject({ tensionV: null, resistenciaOhm: null, validez: 'desconocida' });
  expect(i.observacion.tensiones['r.A']).toBeNull(); expect(JSON.stringify(i)).not.toContain('NaN');
});
it('mantiene niveles y placas distintos aunque compartan GPIO', () => {
  const p = proyecto(); p.boards = [{ id: 'board', board: 'esp32-s3-devkitc-1', language: 'esphome' }, { id: 'aux', board: 'esp32-s3-devkitc-1', language: 'esphome' }];
  const l = lectura(); l.contexto.placas = ['board', 'aux']; l.nivelesPorPlaca.aux = { 7: 1 };
  const i = crearInforme(p, l, 'r', [], 'fecha');
  expect(i.circuito.placas).toHaveLength(2); expect(i.observacion.nivelesPorPlaca).toEqual({ board: { 7: 0 }, aux: { 7: 1 } });
});
it('HTML incluye circuito, unidades y escape sin código ejecutable ajeno', () => {
  const html = informeHtml(crearInforme(proyecto(), lectura(), 'r', [], 'fecha'));
  expect(html).toContain('Corriente (mA)'); expect(html).toContain('board.3V3'); expect(html).toContain('r.A');
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<script src=');
});

it('la presentación conserva ceros, signos y magnitudes pequeñas sin inventar precisión', () => {
  expect(formatearMedidaInforme(null)).toBe('Desconocida');
  expect(formatearMedidaInforme(0)).toBe('0');
  expect(formatearMedidaInforme(2.31851815371e-12)).toBe('2.31852e-12');
  expect(formatearMedidaInforme(-0.101936080865)).toBe('-0.101936');
});
