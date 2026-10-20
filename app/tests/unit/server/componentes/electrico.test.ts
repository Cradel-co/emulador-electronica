import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analizarGrafoDc } from '../../../../server/src/componentes/electrico.js';
import { analizarCircuito } from '../../../../server/src/sim/analisis.js';
import { loadCatalog } from '../../../../server/src/catalog.js';
import { precalentar } from '../../../../server/src/sim/spice.js';
import { divisoresAlimentados } from '../../../fixtures/server/componentes/divisorElectrico.js';
import type { Project } from '../../../../shared/src/project.js';
import { ROOT } from '../../../../server/src/paths.js';
import { PaquetesComponentes } from '../../../../server/src/componentes/paquetes.js';
import { CatalogoComponentes } from '../../../../server/src/componentes/catalogo.js';
import { referencia } from '../../../fixtures/server/componentes/divisor.js';

beforeAll(precalentar, 60_000);
const temporales: string[] = [];
afterEach(async () => { for (const dir of temporales.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function paqueteConModelo(fuente: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grafo-electrico-')); temporales.push(dir);
  for (const id of ['resistor', 'fuente-regulable']) await fs.cp(path.join(ROOT, 'modules', id), path.join(dir, id), { recursive: true });
  await fs.writeFile(path.join(dir, 'resistor/model.ts'), fuente);
  return new PaquetesComponentes({ modulos: dir, chips: path.join(ROOT, 'chips') });
}
const plano: Project = {
  schemaVersion: 1, name: 'divisor-plano', board: null, language: null,
  sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false },
  modules: [
    { id: 'f', type: 'fuente-regulable', x: 0, y: 0, props: { voltage: 5, currentLimitMa: 1000 } },
    ...['a', 'b', 'c', 'd'].map(id => ({ id, type: 'resistor', x: 0, y: 0, props: { ohms: id === 'd' ? 2000 : 1000 } })),
  ],
  wires: [
    { from: 'f.V', to: 'a.1' }, { from: 'f.V', to: 'c.1' },
    { from: 'a.2', to: 'b.1' }, { from: 'c.2', to: 'd.1' },
    { from: 'b.2', to: 'f.GND' }, { from: 'd.2', to: 'f.GND' },
  ],
};

describe('grafo jerárquico conectado al motor eléctrico real', () => {
  it.each([false, true])('mide divisores y coincide con el plano; envoltura=%s', async envolver => {
    const c = await divisoresAlimentados(undefined, envolver);
    const r = await analizarGrafoDc(c.catalogo, c.referencia, c.paquetes);
    expect(r.resuelto, JSON.stringify(r.diagnosticos)).toBe(true);
    if (!r.resuelto) throw new Error('no resuelto');
    const prefijo = envolver ? ['caja'] : [];
    const v = (ruta: string[], puerto: string): number => {
      const valor = r.tensiones.find(t => JSON.stringify(t.ruta) === JSON.stringify(ruta) && t.puerto === puerto)?.voltios;
      if (typeof valor !== 'number') throw new Error(`Sin medida: ${JSON.stringify([ruta, puerto])}`);
      return valor;
    };
    const izq = v([...prefijo, 'izquierda'], 'OUT'), der = v([...prefijo, 'derecha'], 'OUT');
    const vin = v([...prefijo, 'fuente'], 'V');
    // La fuente CV/CC existente usa un recorte por diodos (netlist.ts): unos mV de offset.
    // La ley independiente del divisor usa VIN medido; no se fuerza una fuente ideal nueva.
    expect(Math.abs(vin - 5)).toBeLessThan(0.01);
    expect(Math.abs(izq - 2.5)).toBeLessThan(0.005);
    expect(Math.abs(der - 10 / 3)).toBeLessThan(0.005);
    expect(izq).toBeCloseTo(vin / 2, 8);
    expect(der).toBeCloseTo(vin * 2 / 3, 8);
    const cat = await loadCatalog();
    const p = await analizarCircuito(plano, tipo => cat.find(m => m.type === tipo));
    expect(p.resuelto).toBe(true);
    expect(izq).toBeCloseTo(p.tensiones['a.2'] ?? NaN, 8);
    expect(der).toBeCloseTo(p.tensiones['c.2'] ?? NaN, 8);
    const corrientes = r.elementos.filter(e => e.local === 'r');
    expect(corrientes).toHaveLength(4);
    expect(corrientes.find(e => JSON.stringify(e.ruta) === JSON.stringify([...prefijo, 'izquierda', 'r2']))?.i).toBeCloseTo(vin / 2000, 10);
    expect(corrientes.find(e => JSON.stringify(e.ruta) === JSON.stringify([...prefijo, 'derecha', 'r2']))?.i).toBeCloseTo(vin / 3000, 10);
    expect(r.grafo.redes).toHaveLength(4);
  });
  it('un único modelo de divisor sustituye sus dos hojas internas sin duplicar efectos', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'divisor-equivalente-')); temporales.push(dir);
    for (const id of ['resistor', 'fuente-regulable']) await fs.cp(path.join(ROOT, 'modules', id), path.join(dir, id), { recursive: true });
    const destino = path.join(dir, 'divisor-equivalente'); await fs.mkdir(destino);
    await fs.writeFile(path.join(destino, 'module.json'), JSON.stringify({
      type: 'divisor-equivalente', name: 'Equivalente del divisor', category: 'Pruebas', width: 80, height: 40,
      pins: ['VIN', 'OUT', 'GND'].map((name, x) => ({ name, x: x * 20, y: 0, kind: 'other' })),
      controls: [], props: { inferior: { type: 'number', default: 1000, min: 1, max: 10_000_000, label: 'Inferior' } },
      svg: 'module.svg', model: 'model.ts',
    }));
    await fs.writeFile(path.join(destino, 'module.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await fs.writeFile(path.join(destino, 'model.ts'), `
      import type { ModeloModulo } from '@emu/shared';
      export default { circuito(ctx) {
        ctx.resistencia(ctx.pin('VIN'), ctx.pin('OUT'), 1000, 'superior');
        ctx.resistencia(ctx.pin('OUT'), ctx.pin('GND'), Number(ctx.props.inferior), 'inferior');
      } } satisfies ModeloModulo;
    `);
    const paquetes = new PaquetesComponentes({ modulos: dir, chips: path.join(ROOT, 'chips') });
    const c = await divisoresAlimentados(paquetes);
    const d = c.definiciones.find(d => d.id === 'divisor');
    if (!d || d.tipo !== 'compuesto' || c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const equivalente = { schemaVersion: 1 as const, id: 'divisor-equivalente', version: '1.0.0', nombre: 'Equivalente',
      tipo: 'hoja-legada' as const, puertos: d.puertos, parametros: d.parametros,
      modulo: { id: 'divisor-equivalente', sha256: (await paquetes.inspeccionar('divisor-equivalente')).sha256 } };
    d.representaciones = { equivalente: referencia(equivalente), predeterminada: 'interno' };
    c.raiz.instancias.filter(i => i.id !== 'fuente').forEach(i => { i.definicion = referencia(d); });
    const catalogo = new CatalogoComponentes([...c.definiciones, equivalente]);
    const base = await analizarGrafoDc(catalogo, referencia(c.raiz), paquetes);
    expect(base.resuelto).toBe(true); if (!base.resuelto) throw new Error('no resuelto');
    for (const rutas of [[['izquierda']], [['izquierda'], ['derecha']]]) {
      const resultado = await analizarGrafoDc(catalogo, referencia(c.raiz), paquetes, {
        representaciones: rutas.map(ruta => ({ ruta, seleccion: 'equivalente' })),
      });
      expect(resultado.resuelto).toBe(true); if (!resultado.resuelto) throw new Error('no resuelto');
      expect(resultado.elementos).toHaveLength(base.elementos.length);
      expect(resultado.elementos.filter(e => e.tipo === 'R')).toHaveLength(4);
      expect(resultado.elementos.filter(e => e.ruta[0] === 'fuente')).toEqual(base.elementos.filter(e => e.ruta[0] === 'fuente'));
      expect(resultado.elementos.reduce((s, e) => s + e.p, 0)).toBeCloseTo(base.elementos.reduce((s, e) => s + e.p, 0), 10);
      expect(resultado.tensiones.filter(t => t.puerto === 'OUT')).toEqual(base.tensiones.filter(t => t.puerto === 'OUT'));
      for (const ruta of rutas) expect(resultado.grafo.instancias.some(i => i.ruta.length > 1 && i.ruta[0] === ruta[0])).toBe(false);
    }
    // La alternativa elegida no puede degradarse silenciosamente al esquema interno.
    await fs.appendFile(path.join(destino, 'model.ts'), '\n// modificación del paquete');
    await expect(analizarGrafoDc(catalogo, referencia(c.raiz), paquetes, {
      representaciones: [{ ruta: ['izquierda'], seleccion: 'equivalente' }],
    })).rejects.toMatchObject({ codigo: 'HASH_DISTINTO', ruta: ['izquierda'] });
  });
  it('elige hojas equivalentes por instancia sin duplicar carga, corriente ni potencia', async () => {
    const c = await divisoresAlimentados();
    const r = c.definiciones.find(d => d.id === 'resistor');
    const d = c.definiciones.find(d => d.id === 'divisor');
    if (!r || !d || d.tipo !== 'compuesto' || c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const envoltura = {
      schemaVersion: 1 as const, id: 'resistor-seleccionable', version: '1.0.0', nombre: 'Resistor con esquema interno',
      tipo: 'compuesto' as const, puertos: r.puertos, parametros: r.parametros,
      representaciones: { equivalente: referencia(r), predeterminada: 'interno' as const },
      instancias: [{ id: 'fisico', definicion: referencia(r), parametros: { ohms: { parametro: 'ohms' } } }],
      conexiones: r.puertos.map((p, i) => ({ id: `red-${i}`, terminales: [
        { tipo: 'externo' as const, puerto: p.id }, { tipo: 'hijo' as const, instancia: 'fisico', puerto: p.id },
      ] })),
    };
    d.instancias.forEach(i => { i.definicion = referencia(envoltura); });
    c.raiz.instancias.filter(i => i.id !== 'fuente').forEach(i => { i.definicion = referencia(d); });
    const catalogo = new CatalogoComponentes([...c.definiciones, envoltura]);
    const interno = await analizarGrafoDc(catalogo, referencia(c.raiz), c.paquetes);
    const mixto = await analizarGrafoDc(catalogo, referencia(c.raiz), c.paquetes, { representaciones: [
      { ruta: ['izquierda', 'r1'], seleccion: 'equivalente' },
      { ruta: ['derecha', 'r2'], seleccion: 'equivalente' },
    ] });
    expect(interno.resuelto).toBe(true); expect(mixto.resuelto).toBe(true);
    if (!interno.resuelto || !mixto.resuelto) throw new Error('no resuelto');
    expect(mixto.elementos).toHaveLength(interno.elementos.length);
    expect(mixto.elementos.filter(e => e.tipo === 'R')).toHaveLength(4);
    // Comparar también la alimentación: duplicar ambos resistores conservaría VOUT.
    const medidas = (resultado: typeof interno) => resultado.elementos.map(e => [e.tipo, e.local, e.va, e.vb, e.i, e.p]);
    expect(medidas(mixto)).toEqual(medidas(interno));
    expect(mixto.tensiones.filter(t => t.puerto === 'OUT')).toEqual(interno.tensiones.filter(t => t.puerto === 'OUT'));
    expect(mixto.grafo.instancias.some(i => JSON.stringify(i.ruta) === JSON.stringify(['izquierda', 'r1', 'fisico']))).toBe(false);
  });
  it('sin resolver: retira todas las medidas y conserva el diagnóstico aunque el motor devuelva datos', async () => {
    const c = await divisoresAlimentados();
    const cat = await loadCatalog();
    const base = await analizarCircuito(plano, tipo => cat.find(m => m.type === tipo));
    const fallo = vi.fn<typeof analizarCircuito>().mockResolvedValue({ ...base, resuelto: false, avisos: [{ severidad: 'peligro', pin: -1, mensaje: 'fallo de humo sin expectativas' }] });
    const r = await analizarGrafoDc(c.catalogo, c.referencia, c.paquetes, {}, fallo);
    expect(r.resuelto).toBe(false);
    expect(r.tensiones).toBeNull();
    expect(r.elementos).toEqual([]);
    expect(r.diagnosticos).toEqual(expect.arrayContaining([expect.objectContaining({ mensaje: 'fallo de humo sin expectativas' })]));
  });
  it('un error real del modelo llega como fallo con su ruta; nunca usa el resistor por flags', async () => {
    const paquetes = await paqueteConModelo('export default { circuito() { throw new Error("fallo controlado del resistor"); } };');
    const c = await divisoresAlimentados(paquetes);
    const r = await analizarGrafoDc(c.catalogo, c.referencia, paquetes);
    expect(r.resuelto).toBe(false);
    expect(r.tensiones).toBeNull();
    expect(r.elementos).toEqual([]);
    const d = r.diagnosticos.find(a => a.mensaje.includes('fallo controlado del resistor'));
    expect(d?.origenes).toEqual(expect.arrayContaining([expect.objectContaining({ ruta: ['derecha', 'r1'] })]));
    const repetido = await analizarGrafoDc(c.catalogo, c.referencia, paquetes);
    expect(r.diagnosticos.map(d => d.mensaje)).toEqual(repetido.diagnosticos.map(d => d.mensaje));
    expect(d?.mensaje).not.toMatch(/h-[a-f0-9]{32}/);
  });
  it('aísla variables del modelo por hoja y por corrida', async () => {
    const paquetes = await paqueteConModelo(`
      import type { ModeloModulo } from '@emu/shared';
      let llamadas = 0;
      export default {
        circuito(ctx) { llamadas++; ctx.resistencia(ctx.pin('1'), ctx.pin('2'), Number(ctx.props.ohms) * llamadas, 'r'); }
      } satisfies ModeloModulo;
    `);
    const c = await divisoresAlimentados(paquetes);
    const primero = await analizarGrafoDc(c.catalogo, c.referencia, paquetes);
    const segundo = await analizarGrafoDc(c.catalogo, c.referencia, paquetes);
    expect(primero.resuelto).toBe(true);
    expect(segundo.resuelto).toBe(true);
    if (!primero.resuelto || !segundo.resuelto) throw new Error('no resuelto');
    for (const r of [primero, segundo]) {
      for (const e of r.elementos.filter(e => e.local === 'r')) {
        const esperado = JSON.stringify(e.ruta) === JSON.stringify(['derecha', 'r2']) ? 2000 : 1000;
        expect((e.va - e.vb) / e.i).toBeCloseTo(esperado, 7);
      }
    }
    expect(primero.tensiones).toEqual(segundo.tensiones);
  });
  it('un hash de paquete incorrecto impide invocar al solver y conserva la ruta', async () => {
    const c = await divisoresAlimentados();
    const fuente = c.definiciones.find(d => d.id === 'fuente');
    if (!fuente || fuente.tipo !== 'hoja-legada' || c.raiz.tipo !== 'compuesto') throw new Error('fixture incorrecto');
    fuente.modulo.sha256 = 'f'.repeat(64);
    const hijo = c.raiz.instancias.find(i => i.id === 'fuente');
    if (!hijo) throw new Error('fixture incorrecto');
    hijo.definicion = referencia(fuente);
    const solver = vi.fn<typeof analizarCircuito>();
    await expect(analizarGrafoDc(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes, {}, solver)).rejects.toMatchObject({ codigo: 'HASH_DISTINTO', ruta: ['fuente'] });
    expect(solver).not.toHaveBeenCalled();
  });
  it.each(['vacio', 'no-finito'] as const)('no acredita un éxito aparente %s', async caso => {
    const c = await divisoresAlimentados(), cat = await loadCatalog();
    const base = await analizarCircuito(plano, tipo => cat.find(m => m.type === tipo));
    const fake = vi.fn<typeof analizarCircuito>().mockResolvedValue({ ...base, resuelto: true, elementos: caso === 'vacio' ? [] : base.elementos, tensiones: caso === 'vacio' ? {} : { imposible: NaN } });
    const r = await analizarGrafoDc(c.catalogo, c.referencia, c.paquetes, {}, fake);
    expect(r.resuelto).toBe(false);
    expect(r.tensiones).toBeNull();
    expect(r.elementos).toEqual([]);
    expect(r.diagnosticos.some(d => d.severidad === 'peligro')).toBe(true);
  });
});
