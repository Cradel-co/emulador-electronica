import { describe, expect, it } from 'vitest';
import { CatalogoComponentes } from '../../../../server/src/componentes/catalogo.js';
import { elaborarComponente } from '../../../../server/src/componentes/elaboracion.js';
import { divisor, resistor, referencia } from '../../../fixtures/server/componentes/divisor.js';
function caso() {
  const r = resistor(), d = divisor(r);
  const equivalente = { ...d, id: 'equivalente' };
  const seleccionable = { ...d, representaciones: { equivalente: referencia(equivalente), predeterminada: 'interno' as 'interno' | 'equivalente' } };
  return { r, equivalente, seleccionable, catalogo: new CatalogoComponentes([r, equivalente, seleccionable]) };
}
describe('selección exclusiva de representaciones', () => {
  it('sustituye el árbol completo y conserva la identidad pública y la decisión', () => {
    const c = caso();
    const g = elaborarComponente(c.catalogo, referencia(c.seleccionable), { representaciones: [{ ruta: [], seleccion: 'equivalente' }] });
    expect(g.instancias).toHaveLength(3);
    expect(g.instancias[0]).toMatchObject({ definicion: referencia(c.equivalente), representacion: { seleccion: 'equivalente', componente: referencia(c.seleccionable) } });
    expect(g.instancias.filter(i => i.tipo === 'hoja-legada')).toHaveLength(2);
  });
  it('no ignora rutas inexistentes, duplicadas ni selecciones desconocidas', () => {
    const c = caso();
    for (const representaciones of [
      [{ ruta: ['ausente'], seleccion: 'interno' }],
      [{ ruta: [], seleccion: 'interno' }, { ruta: [], seleccion: 'equivalente' }],
      [{ ruta: [], seleccion: 'ambos' }],
    ]) expect(() => elaborarComponente(c.catalogo, referencia(c.seleccionable), { representaciones } as never)).toThrow();
  });
  it('rechaza interfaces incompatibles aun cuando el equivalente esté inactivo', () => {
    const c = caso(), primero = c.equivalente.puertos[0];
    if (!primero) throw new Error('fixture');
    c.equivalente.puertos = [...c.equivalente.puertos, { ...primero, id: 'EXTRA' }];
    c.seleccionable.representaciones.equivalente = referencia(c.equivalente);
    expect(() => new CatalogoComponentes([c.r, c.equivalente, c.seleccionable])).toThrow(/interfaz/i);
  });
  it('usa el valor predeterminado y consultar el esquema no cambia la ejecución', () => {
    const c = caso(); c.seleccionable.representaciones.predeterminada = 'equivalente';
    const catalogo = new CatalogoComponentes([c.r, c.equivalente, c.seleccionable]);
    const ref = referencia(c.seleccionable), antes = elaborarComponente(catalogo, ref);
    const vista = catalogo.resolver(ref);
    if (vista.tipo === 'compuesto') vista.instancias.splice(0);
    expect(elaborarComponente(catalogo, ref)).toEqual(antes);
    expect(antes.instancias[0]?.representacion?.seleccion).toBe('equivalente');
  });
  it('rechaza selecciones bajo una rama inactiva y en hojas sin alternativas', () => {
    const c = caso();
    expect(() => elaborarComponente(c.catalogo, referencia(c.r), { representaciones: [{ ruta: [], seleccion: 'interno' }] })).toThrow(/no ofrece/);
    expect(() => elaborarComponente(c.catalogo, referencia(c.seleccionable), { representaciones: [
      { ruta: ['fantasma'], seleccion: 'equivalente' },
    ] })).toThrow(/inexistente o inactiva/);
  });
  it('comprueba hashes y dependencias de alternativas inactivas', () => {
    const c = caso();
    c.seleccionable.representaciones.equivalente.sha256 = 'f'.repeat(64);
    expect(() => new CatalogoComponentes([c.r, c.equivalente, c.seleccionable])).toThrow(/Hash distinto/);
    expect(() => new CatalogoComponentes([c.r, c.seleccionable])).toThrow(/ausente/);
  });
  it('rechaza ciclos que pasan por una alternativa inactiva', () => {
    const c = caso();
    c.seleccionable.representaciones.equivalente = { ...referencia(c.seleccionable), sha256: 'f'.repeat(64) };
    expect(() => new CatalogoComponentes([c.r, c.seleccionable])).toThrow(/Ciclo/);
  });
  it('exige los mismos contratos de parámetros incluso si los puertos coinciden', () => {
    const c = caso(); c.equivalente.parametros = {};
    c.seleccionable.representaciones.equivalente = referencia(c.equivalente);
    expect(() => new CatalogoComponentes([c.r, c.equivalente, c.seleccionable])).toThrow(/Interfaz/);
  });

  it('rechaza una segunda selección en la misma ruta, sin rechazar alternativas en hijos', () => {
    const c = caso();
    const segundo = { ...c.equivalente, representaciones: { equivalente: referencia(c.equivalente), predeterminada: 'interno' as const }, id: 'segundo' };
    c.seleccionable.representaciones.equivalente = referencia(segundo);
    expect(() => new CatalogoComponentes([c.r, c.equivalente, segundo, c.seleccionable])).toThrow(/misma ruta/);
  });
  it('rechaza límites y campos extra de las opciones de selección', () => {
    const c = caso();
    for (const representaciones of [
      [{ ruta: [], seleccion: 'interno', expandido: true }],
      [{ ruta: Array.from({ length: 17 }, () => 'hijo'), seleccion: 'interno' }],
      [{ ruta: ['no.valido'], seleccion: 'interno' }],
      Array.from({ length: 2001 }, () => ({ ruta: [], seleccion: 'interno' })),
    ]) expect(() => elaborarComponente(c.catalogo, referencia(c.seleccionable), { representaciones } as never)).toThrow(/inválida/);
  });

});
