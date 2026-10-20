import { describe, expect, it } from 'vitest';
import { CatalogoComponentes, huellaDefinicion } from '../../../../server/src/componentes/catalogo.js';
import { elaborarComponente } from '../../../../server/src/componentes/elaboracion.js';
import { DefinicionComponenteSchema, type DefinicionComponente } from '../../../../shared/src/componentes/contratos.js';
import { divisor, doble, externo, hijo, puerto, referencia, resistor } from '../../../fixtures/server/componentes/divisor.js';

function caso() {
  const r = resistor(), d = divisor(r), dos = doble(d);
  return { r, d, dos, catalogo: new CatalogoComponentes([r, d, dos]) };
}
function compuesto(id: string, puertos = [puerto('IN'), puerto('OUT')]): DefinicionComponente {
  return DefinicionComponenteSchema.parse({ schemaVersion: 1, id, version: '1.0.0', nombre: id, tipo: 'compuesto', puertos, instancias: [], conexiones: [] });
}

describe('catálogo por versión y contenido', () => {
  it('hashea JSON normalizado de forma independiente del orden de claves', () => {
    const r = resistor();
    expect(huellaDefinicion(Object.fromEntries(Object.entries(r).reverse()))).toBe(huellaDefinicion(r));
    expect(huellaDefinicion({ ...r, nombre: 'Otro nombre' })).not.toBe(huellaDefinicion(r));
    const sinUnidad = { ...r, parametros: { ohms: { tipo: 'numero', default: 1000 } } };
    expect(huellaDefinicion({ ...sinUnidad, parametros: { ohms: { tipo: 'numero', default: 1000, unidad: undefined } } }))
      .toBe(huellaDefinicion(sinUnidad));
  });
  it('rechaza versión ausente, hash distinto y dos contenidos para la misma versión', () => {
    const { r, catalogo } = caso();
    expect(() => catalogo.resolver({ ...referencia(r), version: '2.0.0' })).toThrow(/ausente/i);
    expect(() => catalogo.resolver({ ...referencia(r), sha256: 'b'.repeat(64) })).toThrow(/hash/i);
    expect(() => new CatalogoComponentes([r, { ...r, nombre: 'Otro' }])).toThrow(/versión/i);
  });
  it('no permite modificar el catálogo a través del original ni del resultado de resolver', () => {
    const r = resistor(), ref = referencia(r), cat = new CatalogoComponentes([r]);
    r.nombre = 'Mutado';
    cat.resolver(ref).nombre = 'Mutado por resolver';
    expect(cat.resolver(ref).nombre).toBe('Resistor ideal');
  });
  it('rechaza dependencia ausente y hash incorrecto en un hijo', () => {
    const { r, d } = caso();
    expect(() => new CatalogoComponentes([d])).toThrow(/ausente/i);
    if (d.tipo !== 'compuesto') throw new Error('fixture incorrecto');
    const primero = d.instancias[0];
    if (!primero) throw new Error('fixture vacío');
    primero.definicion.sha256 = 'b'.repeat(64);
    expect(() => new CatalogoComponentes([r, d])).toThrow(/hash/i);
  });
  it('detecta ciclos por identidad, sin confundir la reutilización de definiciones', () => {
    const a = compuesto('a'), b = compuesto('b');
    if (a.tipo !== 'compuesto' || b.tipo !== 'compuesto') throw new Error('fixture incorrecto');
    a.instancias.push({ id: 'b', definicion: referencia(b), parametros: {} });
    b.instancias.push({ id: 'a', definicion: referencia(a), parametros: {} });
    expect(() => new CatalogoComponentes([a, b])).toThrow(/ciclo/i);
    expect(() => caso()).not.toThrow();
  });
});

describe('elaboración independiente del ESP32 y del solver', () => {
  it('expande dos divisores con parámetros e identidades independientes (J01/J02)', () => {
    const { dos, catalogo } = caso();
    const grafo = elaborarComponente(catalogo, referencia(dos));
    expect(grafo.instancias).toHaveLength(7);
    const izquierda = grafo.instancias.find(i => JSON.stringify(i.ruta) === JSON.stringify(['izquierda', 'r2']));
    const derecha = grafo.instancias.find(i => JSON.stringify(i.ruta) === JSON.stringify(['derecha', 'r2']));
    expect(izquierda?.parametros.ohms).toBe(1000);
    expect(derecha?.parametros.ohms).toBe(2000);
    if (!izquierda || !derecha) throw new Error('faltan resistores');
    izquierda.parametros.ohms = 500;
    expect(derecha.parametros.ohms).toBe(2000);
    expect(elaborarComponente(catalogo, referencia(dos)).instancias).not.toEqual(grafo.instancias);
  });
  it('produce exactamente las redes del plano y mantiene GND aislados (J01/J04)', () => {
    const { dos, catalogo } = caso();
    const g = elaborarComponente(catalogo, referencia(dos));
    const redesHojas = g.redes.map(n => n.terminales.filter(t => t.ruta.length === 2).map(t => `${t.ruta.join('/')}:${t.puerto}`).sort()).filter(n => n.length);
    expect(redesHojas.sort()).toEqual([
      ['derecha/r1:1'], ['derecha/r1:2', 'derecha/r2:1'], ['derecha/r2:2'],
      ['izquierda/r1:1'], ['izquierda/r1:2', 'izquierda/r2:1'], ['izquierda/r2:2'],
    ].sort());
    expect(g.redes).toHaveLength(6);
    expect(g.redes.flatMap(n => n.origenes)).toContainEqual({ ruta: ['derecha'], conexion: 'tierra' });
  });
  it('anida una tercera hoja sin perder la ruta de origen (J03)', () => {
    const { r, d, dos } = caso();
    const raiz = compuesto('envoltura', []);
    if (raiz.tipo !== 'compuesto') throw new Error('fixture incorrecto');
    raiz.instancias.push({ id: 'caja', definicion: referencia(dos), parametros: {} });
    const g = elaborarComponente(new CatalogoComponentes([r, d, dos, raiz]), referencia(raiz));
    expect(g.instancias).toHaveLength(8);
    expect(g.redes.flatMap(n => n.terminales)).toContainEqual(expect.objectContaining({ ruta: ['caja', 'derecha', 'r2'], puerto: '1' }));
  });
  it('es determinista frente al orden de carga del catálogo', () => {
    const { r, d, dos } = caso();
    expect(elaborarComponente(new CatalogoComponentes([r, d, dos]), referencia(dos)))
      .toEqual(elaborarComponente(new CatalogoComponentes([dos, d, r]), referencia(dos)));
  });
  it.each<Record<string, string | number>>([{ desconocido: 1 }, { inferior: 0 }, { inferior: '1000' }, { inferior: NaN }])('rechaza parámetros inválidos: %j', parametros => {
    const { d, catalogo } = caso();
    expect(() => elaborarComponente(catalogo, referencia(d), { parametros })).toThrow(/parámetro/i);
  });
  it('rechaza un binding a parámetro del padre inexistente', () => {
    const { r, d } = caso();
    if (d.tipo !== 'compuesto' || !d.instancias[0]) throw new Error('fixture incorrecto');
    d.instancias[0].parametros.ohms = { parametro: 'ausente' };
    expect(() => elaborarComponente(new CatalogoComponentes([r, d]), referencia(d))).toThrow(/parámetro/i);
  });
  it('rechaza unidades distintas o ausentes en un vínculo numérico', () => {
    const { r, d } = caso();
    for (const unidad of ['V', undefined]) {
      const variante = DefinicionComponenteSchema.parse({ ...d, parametros: { inferior: { tipo: 'numero', default: 1000, unidad } } });
      expect(() => elaborarComponente(new CatalogoComponentes([r, variante]), referencia(variante))).toThrow(/unidad incompatible/i);
    }
  });
  it('rechaza puertos de hijo inexistentes con su ruta', () => {
    const { r, d } = caso();
    if (d.tipo !== 'compuesto' || !d.conexiones[0]) throw new Error('fixture incorrecto');
    d.conexiones[0].terminales = [externo('VIN'), hijo('r1', 'ausente')];
    try { elaborarComponente(new CatalogoComponentes([r, d]), referencia(d)); throw new Error('aceptó un puerto inválido'); }
    catch (error) { expect(error).toMatchObject({ codigo: 'PUERTO_AUSENTE', ruta: ['r1'] }); }
  });
  it.each(['dominio', 'ancho'] as const)('rechaza %s incompatible', campo => {
    const d = compuesto('incompatible');
    if (d.tipo !== 'compuesto' || !d.puertos[1]) throw new Error('fixture incorrecto');
    d.puertos[1] = { ...d.puertos[1], dominio: 'logico', direccion: 'entrada', ancho: campo === 'ancho' ? 2 : 1 };
    if (campo === 'ancho' && d.puertos[0]) d.puertos[0] = { ...d.puertos[0], dominio: 'logico', direccion: 'salida' };
    d.conexiones.push({ id: 'red', terminales: [externo('IN'), externo('OUT')] });
    expect(() => elaborarComponente(new CatalogoComponentes([d]), referencia(d))).toThrow(new RegExp(campo, 'i'));
  });
  it.each(['instancias', 'terminales', 'conexiones', 'profundidad', 'redes'] as const)('aplica presupuesto global de %s', limite => {
    const { dos, catalogo } = caso();
    expect(() => elaborarComponente(catalogo, referencia(dos), { limites: { [limite]: 1 } })).toThrow(/límite/i);
  });
  it('rechaza presupuesto inválido antes de elaborar', () => {
    const { dos, catalogo } = caso();
    expect(() => elaborarComponente(catalogo, referencia(dos), { limites: { instancias: Infinity } })).toThrow(/límite/i);
  });
  it('preserva booleanos falsos y textos y valida valores permitidos', () => {
    const r = resistor();
    const def = DefinicionComponenteSchema.parse({ ...r, parametros: { activo: { tipo: 'booleano', default: true }, modo: { tipo: 'texto', default: 'ideal', valores: ['ideal', 'medido'] } } });
    const catalogo = new CatalogoComponentes([def]);
    expect(elaborarComponente(catalogo, referencia(def), { parametros: { activo: false, modo: 'medido' } }).instancias[0]?.parametros).toEqual({ activo: false, modo: 'medido' });
    expect(() => elaborarComponente(catalogo, referencia(def), { parametros: { modo: 'otro' } })).toThrow(/parámetro/i);
    expect(() => elaborarComponente(catalogo, referencia(def), { parametros: { activo: 'false' } })).toThrow(/parámetro/i);
  });
  it('une tierras únicamente cuando existe una conexión entre ellas', () => {
    const { r, d, dos } = caso();
    if (dos.tipo !== 'compuesto') throw new Error('fixture incorrecto');
    dos.conexiones.push({ id: 'gnd-comun', terminales: [hijo('izquierda', 'GND'), hijo('derecha', 'GND')] });
    const g = elaborarComponente(new CatalogoComponentes([r, d, dos]), referencia(dos));
    expect(g.redes).toHaveLength(5);
    expect(g.redes.find(n => n.origenes.some(o => o.conexion === 'gnd-comun'))?.terminales)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ ruta: ['izquierda', 'r2'], puerto: '2' }),
        expect.objectContaining({ ruta: ['derecha', 'r2'], puerto: '2' }),
      ]));
  });
  it('admite lazos eléctricos sin confundirlos con ciclos entre definiciones', () => {
    const { r, d } = caso();
    const caja = compuesto('cortocircuitado', []);
    if (caja.tipo !== 'compuesto') throw new Error('fixture incorrecto');
    caja.instancias.push({ id: 'divisor', definicion: referencia(d), parametros: {} });
    caja.conexiones.push({ id: 'retorno', terminales: [hijo('divisor', 'VIN'), hijo('divisor', 'GND')] });
    expect(elaborarComponente(new CatalogoComponentes([r, d, caja]), referencia(caja)).redes).toHaveLength(2);
    // Elaborar conectividad no acredita que una fuente conectada a ese corto pueda resolver.
  });
  it('cuenta drivers de hojas y no inventa salidas en fronteras de compuestos', () => {
    const salida = DefinicionComponenteSchema.parse({ ...resistor(), id: 'salida', parametros: {}, puertos: [{ id: 'OUT', dominio: 'logico', direccion: 'salida', ancho: 1 }] });
    const caja = compuesto('caja-logica', []);
    if (caja.tipo !== 'compuesto') throw new Error('fixture incorrecto');
    caja.instancias.push({ id: 'a', definicion: referencia(salida), parametros: {} }, { id: 'b', definicion: referencia(salida), parametros: {} });
    caja.conexiones.push({ id: 'contencion', terminales: [hijo('a', 'OUT'), hijo('b', 'OUT')] });
    expect(() => elaborarComponente(new CatalogoComponentes([salida, caja]), referencia(caja))).toThrow(/múltiples salidas/i);
    const una = DefinicionComponenteSchema.parse({ ...caja, id: 'una-salida', puertos: [{ id: 'OUT', dominio: 'logico', direccion: 'salida', ancho: 1 }], instancias: [caja.instancias[0]], conexiones: [{ id: 'frontera', terminales: [externo('OUT'), hijo('a', 'OUT')] }] });
    expect(elaborarComponente(new CatalogoComponentes([salida, una]), referencia(una)).redes).toHaveLength(1);
  });
  it('valida el hash raíz y acepta defaults de instancia sin compartir objetos', () => {
    const { dos, catalogo } = caso();
    expect(() => elaborarComponente(catalogo, { ...referencia(dos), sha256: 'c'.repeat(64) })).toThrow(/hash/i);
    const a = elaborarComponente(catalogo, referencia(dos)), b = elaborarComponente(catalogo, referencia(dos));
    expect(a).toEqual(b);
    expect(a.instancias[0]).not.toBe(b.instancias[0]);
    expect(a.redes[0]).not.toBe(b.redes[0]);
  });
});
