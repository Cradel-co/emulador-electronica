import { describe, expect, it } from 'vitest';
import { CatalogoComponentes } from '../../../../server/src/componentes/catalogo.js';
import { elaborarComponente } from '../../../../server/src/componentes/elaboracion.js';
import { divisor, resistor, referencia } from '../../../fixtures/server/componentes/divisor.js';
import { DefinicionComponenteSchema } from '../../../../shared/src/componentes/contratos.js';

function caso() {
  const r = resistor(), interior = divisor(r);
  if (interior.tipo !== 'compuesto') throw new Error('fixture');
  const equivalente = { ...structuredClone(interior), id: 'equivalente' };
  const raiz = { ...interior, representaciones: { equivalente: referencia(equivalente), predeterminada: { electrico: 'equivalente' as const, funcional: 'interno' as const } } };
  return { r, raiz, equivalente, catalogo: new CatalogoComponentes([r, equivalente, raiz]) };
}
describe('representaciones por dominio de ejecución', () => {
  it('conserva interior funcional y equivalente eléctrico sin duplicar propietarios', () => {
    const c = caso(), g = elaborarComponente(c.catalogo, referencia(c.raiz));
    const hojas = g.instancias.filter(i => i.tipo === 'hoja-legada');
    expect(hojas.filter(i => i.dominiosActivos?.includes('electrico'))).toHaveLength(2);
    expect(hojas.filter(i => i.dominiosActivos?.includes('funcional'))).toHaveLength(2);
    expect(hojas.find(i => i.ruta.join('/') === 'r1')?.dominiosActivos).toEqual(['funcional']);
    expect(hojas.find(i => i.ruta.join('/') === 'equivalente/r1')?.dominiosActivos).toEqual(['electrico']);
    expect(g.instancias.find(i => i.ruta.join('/') === 'equivalente')?.origenRepresentacion?.ruta).toEqual([]);
    expect(g.redes.some(r => r.origenes.some(o => o.observacion))).toBe(true);
    expect(g.redes.some(r => r.origenes.some(o => o.representacion === 'equivalente'))).toBe(true);
  });
  it('una selección completa explícita sustituye el predeterminado mixto', () => {
    const c = caso(), g = elaborarComponente(c.catalogo, referencia(c.raiz), { representaciones: [{ ruta: [], seleccion: 'interno' }] });
    expect(g.instancias.filter(i => i.tipo === 'hoja-legada')).toHaveLength(2);
    expect(g.instancias.every(i => i.dominiosActivos === undefined)).toBe(true);
  });
  it('requiere ambos dominios, rechaza otros y respeta límites del árbol combinado', () => {
    const c = caso();
    expect(() => elaborarComponente(c.catalogo, referencia(c.raiz), { limites: { instancias: 4 } })).toThrow(/Límite/);
    for (const seleccion of [{ electrico: 'interno' }, { electrico: 'interno', funcional: 'equivalente', radio: 'interno' }]) {
      expect(() => elaborarComponente(c.catalogo, referencia(c.raiz), { representaciones: [{ ruta: [], seleccion }] } as never)).toThrow(/inválida/);
    }
  });
  it('un cable del interior funcional no puede cortocircuitar nodos del equivalente eléctrico', () => {
    const c = caso();
    const entrada = c.raiz.conexiones.find(r => r.id === 'entrada'), salida = c.raiz.conexiones.find(r => r.id === 'salida');
    if (!entrada || !salida) throw new Error('fixture');
    entrada.terminales.push(...salida.terminales);
    c.raiz.conexiones = c.raiz.conexiones.filter(r => r.id !== 'salida');
    const catalogo = new CatalogoComponentes([c.r, c.equivalente, c.raiz]);
    expect(() => elaborarComponente(catalogo, referencia(c.raiz))).toThrow(/observación eléctrica/);
  });
  it.each(['interno', 'equivalente'] as const)('no duplica árboles si ambos dominios eligen %s', seleccion => {
    const c = caso(), g = elaborarComponente(c.catalogo, referencia(c.raiz), { representaciones: [{ ruta: [], seleccion: { electrico: seleccion, funcional: seleccion } }] });
    expect(g.instancias).toHaveLength(3);
    expect(g.instancias.every(i => i.dominiosActivos === undefined)).toBe(true);
  });
  it('la selección inversa asigna efectos eléctricos al interior y funcionales al equivalente', () => {
    const c = caso(), g = elaborarComponente(c.catalogo, referencia(c.raiz), { representaciones: [{ ruta: [], seleccion: { electrico: 'interno', funcional: 'equivalente' } }] });
    expect(g.instancias.find(i => i.ruta.join('/') === 'r1')?.dominiosActivos).toEqual(['electrico']);
    expect(g.instancias.find(i => i.ruta.join('/') === 'equivalente/r1')?.dominiosActivos).toEqual(['funcional']);
  });
  it('evita colisiones con un hijo real llamado equivalente', () => {
    const c = caso(), r1 = c.raiz.instancias.find(i => i.id === 'r1'); if (!r1) throw new Error('fixture'); r1.id = 'equivalente';
    for (const r of c.raiz.conexiones) for (const t of r.terminales) if (t.tipo === 'hijo' && t.instancia === 'r1') t.instancia = 'equivalente';
    const g = elaborarComponente(new CatalogoComponentes([c.r, c.equivalente, c.raiz]), referencia(c.raiz));
    expect(g.instancias.find(i => i.ruta.join('/') === 'equivalente')?.dominiosActivos).toEqual(['funcional']);
    expect(g.instancias.find(i => i.ruta.join('/') === 'equivalente-1')?.origenRepresentacion?.ruta).toEqual([]);
  });
  it('interseca dominios heredados, poda ramas sin efectos y rechaza selecciones bajo ellas', () => {
    const c = caso(), otro = { ...structuredClone(c.r), id: 'resistor-equivalente' };
    const envoltura = DefinicionComponenteSchema.parse({ schemaVersion: 1, tipo: 'compuesto', id: 'resistor-compuesto', version: '1.0.0', nombre: 'Resistor compuesto',
      puertos: c.r.puertos, parametros: c.r.parametros,
      instancias: [{ id: 'pieza', definicion: referencia(c.r), parametros: { ohms: { parametro: 'ohms' } } }],
      conexiones: ['1', '2'].map((p, i) => ({ id: `pin-${i}`, terminales: [{ tipo: 'externo', puerto: p }, { tipo: 'hijo', instancia: 'pieza', puerto: p }] })),
      representaciones: { equivalente: referencia(otro), predeterminada: { electrico: 'equivalente', funcional: 'interno' } },
    });
    const r1 = c.raiz.instancias.find(i => i.id === 'r1'); if (!r1) throw new Error('fixture'); r1.definicion = referencia(envoltura);
    const catalogo = new CatalogoComponentes([c.r, otro, envoltura, c.equivalente, c.raiz]), ref = referencia(c.raiz);
    const g = elaborarComponente(catalogo, ref);
    expect(g.instancias.find(i => i.ruta.join('/') === 'r1/pieza')?.dominiosActivos).toEqual(['funcional']);
    expect(g.instancias.some(i => i.ruta.join('/') === 'r1/equivalente')).toBe(false);
    expect(() => elaborarComponente(catalogo, ref, { representaciones: [{ ruta: ['r1', 'equivalente'], seleccion: 'interno' }] })).toThrow(/inexistente o inactiva/);
  });
});
