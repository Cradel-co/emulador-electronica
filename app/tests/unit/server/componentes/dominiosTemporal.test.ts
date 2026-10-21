import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { CatalogoComponentes } from '../../../../server/src/componentes/catalogo.js';
import { SimulacionTemporalComponentes } from '../../../../server/src/componentes/temporal.js';
import { analizarGrafoDc } from '../../../../server/src/componentes/electrico.js';
import { precalentar } from '../../../../server/src/sim/spice.js';
import { circuitoIrq } from '../../../fixtures/server/componentes/irq.js';
import { divisoresAlimentados } from '../../../fixtures/server/componentes/divisorElectrico.js';
import { referencia, hijo } from '../../../fixtures/server/componentes/divisor.js';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
beforeAll(precalentar, 60_000);
const mixto = { electrico: 'equivalente', funcional: 'interno' } as const;

async function digitalMixto() {
  const c = await circuitoIrq(); dirs.push(c.dir);
  const bloque = c.definiciones.find(d => d.id === 'bloque');
  if (!bloque || c.raiz.tipo !== 'compuesto') throw new Error('fixture');
  c.envoltura.representaciones = { equivalente: referencia(bloque), predeterminada: 'interno' };
  for (const i of c.raiz.instancias) if (i.id === 'a' || i.id === 'b') i.definicion = referencia(c.envoltura);
  const red = c.raiz.conexiones.find(r => r.id === 'irq'); if (!red) throw new Error('fixture'); red.terminales[0] = hijo('b', 'IRQ_OUT');
  return { ...c, catalogo: new CatalogoComponentes(c.definiciones), referencia: referencia(c.raiz) };
}
describe('propiedad eléctrica y funcional sobre el solver y la agenda', () => {
  it.each([mixto, { electrico: 'interno', funcional: 'equivalente' } as const])('observa entradas del dueño eléctrico y emite IRQ solo desde el funcional: %j', async seleccion => {
    const c = await digitalMixto(), creados: string[] = [], entradas: unknown[] = [], irqs: unknown[] = [];
    const funcional = seleccion.funcional === 'interno' ? 'b/interior/chip' : 'b/equivalente/chip';
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      representaciones: [{ ruta: ['b'], seleccion }],
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { creados.push(ctx.ruta.join('/')); if (ctx.ruta[0] === 'a') { ctx.escribirDigital('Q', 0); ctx.programarEn(5n, 'alto'); } },
        evento(ctx) { ctx.escribirDigital('Q', 1); },
        entradaDigital(ctx, cambio) {
          if (ctx.ruta[0] !== 'b' || cambio.puerto !== 'I') return;
          entradas.push(cambio.actual); ctx.escribirIrq('IRQ_OUT', cambio.actual);
        },
        entradaIrq(ctx, cambio) { if (ctx.ruta[0] === 'a') irqs.push([cambio.actual, cambio.origen?.ruta.join('/')]); },
      } : undefined,
    });
    await s.avanzarHasta(9n);
    expect(creados).toEqual(['a/interior/chip', funcional]);
    expect(entradas).toEqual([0, 1]); expect(irqs).toEqual([[0, funcional], [1, funcional]]);
    const r = s.resultado?.dc; if (!r?.resuelto) throw new Error('sin resolver');
    expect(r.elementos.filter(e => e.local === 'salida' && e.ruta.at(-1) === 'chip')).toHaveLength(1);
    const lectura = r.tensiones.find(t => t.ruta.join('/') === funcional && t.puerto === 'I');
    expect(lectura?.referenciada).toBe(true); expect(lectura?.voltios).toBeGreaterThan(3);
  });
  it.each(['reset', 'alimentacion'] as const)('cancela y recupera el modelo funcional separado ante %s', async motivo => {
    const c = await digitalMixto(), inicios: string[] = [], ticks: string[] = [];
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      representaciones: [{ ruta: ['b'], seleccion: mixto }],
      crearModelo: i => i.ruta[0] === (motivo === 'reset' ? 'reset-b' : 'fuente-b') ? {
        iniciar(ctx) { ctx.programarEn(10n, 'off'); ctx.programarEn(20n, 'on'); },
        evento(ctx, e) { ctx.ponerParametro('voltage', e.tipo === 'off' ? 0 : 3.3); },
      } : i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { inicios.push(ctx.ruta.join('/')); ctx.programarEn(ctx.ahoraPs + 14n, 'tick'); },
        evento(ctx) { ticks.push(ctx.ruta.join('/')); },
      } : undefined,
    });
    await s.avanzarHasta(25n);
    expect(inicios).toEqual(['a/interior/chip', 'b/interior/chip', 'b/interior/chip']);
    expect(ticks).toEqual(['a/interior/chip']); expect(s.resultado?.dc.resuelto).toBe(true);
  });
  it.each(['drive', 'parametro'] as const)('impide escrituras eléctricas ajenas desde una hoja funcional: %s', async tipo => {
    const c = await digitalMixto();
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      representaciones: [{ ruta: ['b'], seleccion: mixto }],
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { if (ctx.ruta[0] === 'b') ctx.programarEn(4n, 'ilegal'); }, evento(ctx) { if (tipo === 'drive') ctx.escribirDigital('Q', 1); else ctx.ponerParametro('ron', 100); },
      } : undefined,
    });
    await expect(s.avanzarHasta(5n)).rejects.toThrow(/acoplamiento explícito/);
    expect(s.resultado).toBeNull(); expect(s.estado).toBe('fallida');
  });
  it('no inventa tensiones de nodos internos sin correspondencia en la representación eléctrica', async () => {
    const c = await digitalMixto(), bloque = c.definiciones.find(d => d.id === 'bloque');
    if (!bloque || bloque.tipo !== 'compuesto' || c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const aislado = { ...structuredClone(bloque), id: 'observacion-aislada',
      conexiones: bloque.conexiones.filter(r => !r.terminales.some(t => t.tipo === 'externo' && t.puerto === 'I')) },
      interior = c.envoltura.instancias[0]; if (!interior) throw new Error('fixture'); interior.definicion = referencia(aislado);
    c.definiciones.push(aislado);
    for (const i of c.raiz.instancias) if (i.id === 'a' || i.id === 'b') i.definicion = referencia(c.envoltura);
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes, {
      representaciones: [{ ruta: ['b'], seleccion: mixto }],
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { ctx.programarEn(3n, 'leer'); }, evento(ctx) { if (ctx.ruta[0] === 'b') expect(ctx.leerDigital('I')).toBe('X'); },
      } : undefined,
    });
    await s.avanzarHasta(4n);
    const r = s.resultado?.dc; if (!r?.resuelto) throw new Error('sin medidas');
    expect(r.tensiones.find(t => t.ruta.join('/') === 'b/interior/chip' && t.puerto === 'I')).toMatchObject({ voltios: null, referenciada: false });
    expect(r.tensiones.find(t => t.ruta.join('/') === 'b' && t.puerto === 'I')?.voltios).toBeTypeOf('number');
  });
  it('el cableado IRQ de una alternativa solo eléctrica no une redes funcionales activas', async () => {
    const c = await digitalMixto(), bloque = c.definiciones.find(d => d.id === 'bloque');
    if (!bloque || bloque.tipo !== 'compuesto' || c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const equivalente = { ...structuredClone(bloque), id: 'equivalente-con-irq-unida' };
    const entrada = equivalente.conexiones.find(r => r.terminales.some(t => t.tipo === 'externo' && t.puerto === 'IRQ_IN')),
      salida = equivalente.conexiones.find(r => r.terminales.some(t => t.tipo === 'externo' && t.puerto === 'IRQ_OUT'));
    if (!entrada || !salida || !c.envoltura.representaciones) throw new Error('fixture');
    entrada.terminales.push(...salida.terminales); equivalente.conexiones = equivalente.conexiones.filter(r => r !== salida);
    c.definiciones.push(equivalente); c.envoltura.representaciones.equivalente = referencia(equivalente);
    for (const i of c.raiz.instancias) if (i.id === 'a' || i.id === 'b') i.definicion = referencia(c.envoltura);
    c.raiz.conexiones = c.raiz.conexiones.filter(r => r.id !== 'irq');
    c.raiz.conexiones.push({ id: 'irq-a', terminales: [hijo('a', 'IRQ_OUT'), hijo('b', 'IRQ_IN')] }, { id: 'irq-b', terminales: [hijo('b', 'IRQ_OUT'), hijo('a', 'IRQ_IN')] });
    const vistos: unknown[] = [];
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes, {
      representaciones: [{ ruta: ['b'], seleccion: mixto }],
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { ctx.escribirIrq('IRQ_OUT', ctx.ruta[0] === 'a' ? 0 : 1); }, evento() {},
        entradaIrq(ctx, cambio) { vistos.push([ctx.ruta[0], cambio.actual, cambio.origen?.ruta[0]]); },
      } : undefined,
    });
    await s.avanzarHasta(4n);
    expect(vistos).toHaveLength(2); expect(vistos).toEqual(expect.arrayContaining([['a', 1, 'b'], ['b', 0, 'a']]));
  });
  it('los divisores anidados conservan cuatro resistencias, tensiones y corrientes sin estampado doble', async () => {
    const c = await divisoresAlimentados(undefined, true);
    const d = c.definiciones.find(d => d.id === 'divisor'), dos = c.definiciones.find(d => d.id === 'doble');
    if (!d || d.tipo !== 'compuesto' || !dos || dos.tipo !== 'compuesto' || c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const equivalente = { ...structuredClone(d), id: 'divisor-equivalente' };
    d.representaciones = { equivalente: referencia(equivalente), predeterminada: 'interno' };
    for (const i of dos.instancias) if (i.id === 'izquierda' || i.id === 'derecha') i.definicion = referencia(d);
    for (const i of c.raiz.instancias) i.definicion = referencia(dos);
    const catalogo = new CatalogoComponentes([...c.definiciones, equivalente]);
    const ref = referencia(c.raiz), antes = await analizarGrafoDc(catalogo, ref, c.paquetes);
    const despues = await analizarGrafoDc(catalogo, ref, c.paquetes, { representaciones: [{ ruta: ['caja', 'izquierda'], seleccion: mixto }] });
    if (!antes.resuelto || !despues.resuelto) throw new Error('divisores sin resolver');
    expect(despues.elementos.filter(e => e.local === 'r')).toHaveLength(4);
    expect(despues.elementos.filter(e => e.local === 'r').map(e => e.i).sort()).toEqual(antes.elementos.filter(e => e.local === 'r').map(e => e.i).sort());
    for (const ruta of [['caja', 'izquierda'], ['caja', 'derecha']]) {
      const v = (r: typeof antes) => r.tensiones.find(t => t.ruta.join('/') === ruta.join('/') && t.puerto === 'OUT')?.voltios;
      expect(v(despues)).toBeCloseTo(v(antes) ?? NaN, 8);
    }
  });
});
