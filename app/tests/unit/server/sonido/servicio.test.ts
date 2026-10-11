import { expect, it } from 'vitest';
import { ProjectSchema } from '@emu/shared';
import { ServicioEntradaSonido, aplicarEntradaSonido } from '../../../../server/src/sonido/servicio.js';
it('aplica una entrada temporal sin cambiar propiedades guardadas y vuelve a manual al cerrar', () => {
  const p = ProjectSchema.parse({ name: 'p', board: null, language: null, modules: [{ id: 'mic', type: 'sonometro-sen0232', x: 0, y: 0, props: { dbA: 50 } }], wires: [], sim: { wifiSsid: 'x', wifiPassword: '' } });
  const s = new ServicioEntradaSonido(() => {});
  const lease = s.abrir('p', 'mic');
  s.actualizar('p', 'mic', lease.id, { secuencia: 1, dbfs: -20, referencia: { dbfs: -20, nivel: 80 } });
  expect(aplicarEntradaSonido(p, s.leer('p')).modules[0]?.props.dbA).toBe(80);
  expect(p.modules[0]?.props.dbA).toBe(50);
  s.cerrar('p', 'mic', lease.id);
  expect(aplicarEntradaSonido(p, s.leer('p')).modules[0]?.props.dbA).toBe(50);
});
it('rechaza otro propietario, mensajes repetidos y sesiones vencidas; el estado público no filtra tokens', () => {
  let reloj = 0, cambios = 0;
  const s = new ServicioEntradaSonido(() => { cambios++; }, () => reloj);
  const a = s.abrir('p', 'mic');
  expect(() => s.abrir('otro', 'm')).toThrow();
  expect(() => s.actualizar('p', 'mic', 'ajeno', { secuencia: 1, dbfs: -20, referencia: { dbfs: -20, nivel: 80 } })).toThrow();
  s.actualizar('p', 'mic', a.id, { secuencia: 1, dbfs: -20, referencia: { dbfs: -20, nivel: 80 } });
  expect(JSON.stringify(s.estado('p', 'mic'))).not.toContain(a.id);
  expect(() => s.actualizar('p', 'mic', a.id, { secuencia: 1, dbfs: -20, referencia: { dbfs: -20, nivel: 80 } })).toThrow();
  reloj = 7000; s.vencer();
  expect(s.leer('p')).toEqual({}); expect(cambios).toBe(2);
  expect(() => s.actualizar('p', 'mic', a.id, { secuencia: 2, dbfs: -20, referencia: { dbfs: -20, nivel: 80 } })).toThrow();
});
it('silencio y niveles fuera del rango del sensor llegan al modelo sin recorte previo', () => {
  const s = new ServicioEntradaSonido(() => {}), a = s.abrir('p', 'mic');
  s.actualizar('p', 'mic', a.id, { secuencia: 1, dbfs: -10, referencia: { dbfs: -100, nivel: 100 } });
  expect(s.leer('p').mic?.nivelEstimado).toBe(190);
  s.actualizar('p', 'mic', a.id, { secuencia: 2, dbfs: null, referencia: { dbfs: -100, nivel: 100 } });
  expect(s.leer('p').mic).toMatchObject({ nivelEstimado: 0, dbfs: null });
});
