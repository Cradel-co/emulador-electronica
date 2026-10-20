import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { SimulacionTemporalComponentes, type ModeloTemporalComponente } from '../../../../server/src/componentes/temporal.js';
import { CatalogoComponentes } from '../../../../server/src/componentes/catalogo.js';
import { referencia } from '../../../fixtures/server/componentes/divisor.js';
import { circuitoDigital } from '../../../fixtures/server/componentes/digital.js';
import { precalentar } from '../../../../server/src/sim/spice.js';
const temporales: string[] = [];
afterEach(async () => { for (const dir of temporales.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
beforeAll(precalentar, 60_000);

describe('señales, alimentación y reset entre componentes jerárquicos', () => {
  it('resuelve una salida resistiva y entrega a la otra instancia el nivel leído del circuito', async () => {
    const c = await circuitoDigital(); temporales.push(c.dir);
    const cambios: unknown[] = [];
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { if (ctx.ruta[0] === 'a') ctx.escribirDigital('Q', 1); }, evento() {},
        entradaDigital(ctx, cambio) { if (ctx.ruta[0] === 'b' && cambio.puerto === 'I') cambios.push(cambio.actual); },
      } satisfies ModeloTemporalComponente : undefined,
    });
    await s.avanzarHasta(3n);
    expect(cambios).toEqual([0, 1]);
    const r = s.resultado?.dc; if (!r?.resuelto) throw new Error('sin medidas');
    const v = (ruta: string[], puerto: string) => r.tensiones.find(t => JSON.stringify(t.ruta) === JSON.stringify(ruta) && t.puerto === puerto)?.voltios ?? NaN;
    expect(v(['a'], 'Q')).toBeCloseTo(v(['a'], 'VCC') * 10000 / 10050, 7);
    expect(s.estadosDigitales?.find(e => e.ruta.join('/') === 'b/chip')?.entradas.I).toBe(1);
    expect(r.elementos.filter(e => e.local === 'salida' && e.ruta.at(-1) === 'chip')).toHaveLength(1);
  });
  it.each(['alimentacion', 'reset'] as const)('cancela la generación por %s, libera la salida y reinicia solo esa copia', async motivo => {
    const c = await circuitoDigital(); temporales.push(c.dir);
    const inicios: string[] = [], ticks: string[] = [];
    const afectada = motivo === 'alimentacion' ? 'a' : 'b';
    const control = motivo === 'alimentacion' ? 'fuente-a' : 'reset-b';
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { inicios.push(ctx.ruta[0] ?? ''); ctx.escribirDigital('Q', 1); ctx.programarEn(ctx.ahoraPs + 14n, 'tick'); },
        evento(ctx) { ticks.push(ctx.ruta[0] ?? ''); },
      } : i.ruta[0] === control ? {
        iniciar(ctx) { ctx.programarEn(10n, 'off'); ctx.programarEn(20n, 'on'); },
        evento(ctx, e) { ctx.ponerParametro('voltage', e.tipo === 'off' ? 0 : 3.3); },
      } : undefined,
    });
    await s.avanzarHasta(12n);
    expect(s.estadosDigitales?.find(e => e.ruta[0] === afectada)?.estado).toBe(motivo === 'alimentacion' ? 'apagado' : 'reset');
    expect(s.grafoActual.instancias.find(i => i.ruta.join('/') === `${afectada}/chip`)?.parametros.nivel).toBe('Z');
    await s.avanzarHasta(25n);
    expect(inicios.filter(r => r === afectada)).toHaveLength(2);
    expect(inicios.filter(r => r !== afectada)).toHaveLength(1);
    expect(ticks).toEqual([afectada === 'a' ? 'b' : 'a']);
    expect(s.estadosDigitales?.every(e => e.estado === 'activo')).toBe(true);
  });
  it('un corte anterior en la misma fase cancela el timer que vence en ese instante', async () => {
    const c = await circuitoDigital(); temporales.push(c.dir); const ticks: string[] = [];
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.ruta[0] === 'fuente-a' ? {
        iniciar(ctx) { ctx.programarEn(10n, 'off'); }, evento(ctx) { ctx.ponerParametro('voltage', 0); },
      } : i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { ctx.programarEn(10n, 'tick'); }, evento(ctx) { ticks.push(ctx.ruta[0] ?? ''); },
      } : undefined,
    });
    await s.avanzarHasta(11n);
    expect(ticks).toEqual(['b']);
    expect(s.estadosDigitales?.find(e => e.ruta[0] === 'a')?.estado).toBe('apagado');
  });
  it('impide saltarse el control de drive y suplantar notificaciones internas', async () => {
    const c = await circuitoDigital(); temporales.push(c.dir);
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { ctx.ponerParametro('nivel', '1'); }, evento() {},
      } : undefined,
    });
    expect(() => s.programar({ ruta: ['a', 'chip'], instantePs: 1n, fase: 'modelo', tipo: '$digital:inicio' })).toThrow();
    await expect(s.avanzarHasta(1n)).rejects.toThrow(/escribirDigital/);
    expect(s.resultado).toBeNull();
  });

  it('una entrada abierta queda indeterminada aunque el solver use fugas para converger', async () => {
    const c = await circuitoDigital(); temporales.push(c.dir);
    if (c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const red = c.raiz.conexiones.find(r => r.id === 'senal'); if (!red) throw new Error('fixture');
    red.terminales = red.terminales.filter(t => !(t.tipo === 'hijo' && t.instancia === 'b' && t.puerto === 'I'));
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes);
    await s.avanzarHasta(2n);
    expect(s.estadosDigitales?.find(e => e.ruta[0] === 'b')?.entradas.I).toBe('X');
  });

  it('una resistencia que termina en otra isla no convierte el ruido numérico en un cero válido', async () => {
    const c = await circuitoDigital(); temporales.push(c.dir);
    if (c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const red = c.raiz.conexiones.find(r => r.id === 'senal');
    const carga = c.definiciones.find(d => d.id === 'carga'); if (!red || !carga) throw new Error('fixture');
    red.terminales = red.terminales.filter(t => !(t.tipo === 'hijo' && t.instancia === 'b' && t.puerto === 'I'));
    c.raiz.instancias.push({ id: 'isla', definicion: referencia(carga), parametros: {} });
    c.raiz.conexiones.push({ id: 'isla', terminales: [{ tipo: 'hijo', instancia: 'b', puerto: 'I' }, { tipo: 'hijo', instancia: 'isla', puerto: '1' }] });
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes);
    await s.avanzarHasta(2n);
    expect(s.estadosDigitales?.find(e => e.ruta[0] === 'b')?.entradas.I).toBe('X');
  });

  it('dos salidas enfrentadas producen tensión intermedia y nivel indeterminado', async () => {
    const c = await circuitoDigital(); temporales.push(c.dir);
    if (c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const red = c.raiz.conexiones.find(r => r.id === 'senal'); if (!red) throw new Error('fixture');
    red.terminales.push({ tipo: 'hijo', instancia: 'b', puerto: 'Q' });
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes, {
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { ctx.escribirDigital('Q', ctx.ruta[0] === 'a' ? 1 : 0); }, evento() {},
      } : undefined,
    });
    await s.avanzarHasta(3n);
    expect(s.estadosDigitales?.find(e => e.ruta[0] === 'b')?.entradas.I).toBe('X');
    expect(s.resultado?.dc.elementos.filter(e => e.local === 'salida' && e.ruta.at(-1) === 'chip')).toHaveLength(2);
  });
  it('un perfil digital no se acepta con un paquete que carece de modelo explícito', async () => {
    const c = await circuitoDigital(); temporales.push(c.dir);
    if (c.digital.tipo !== 'hoja-legada') throw new Error('fixture');
    const archivo = `${c.dir}/digital-prueba/module.json`;
    const descriptor = JSON.parse(await fs.readFile(archivo, 'utf8')) as Record<string, unknown>;
    delete descriptor.model; await fs.writeFile(archivo, JSON.stringify(descriptor));
    c.digital.modulo.sha256 = (await c.paquetes.inspeccionar('digital-prueba')).sha256;
    await expect(c.paquetes.verificar(c.digital)).rejects.toMatchObject({ codigo: 'MODELO_INVALIDO' });
  });

});
