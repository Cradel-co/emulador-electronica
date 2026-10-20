import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SimulacionTemporalComponentes } from '../../../../server/src/componentes/temporal.js';
import { analizarGrafoElaboradoDc } from '../../../../server/src/componentes/electrico.js';
import { precalentar } from '../../../../server/src/sim/spice.js';
import { CatalogoComponentes } from '../../../../server/src/componentes/catalogo.js';
import { referencia } from '../../../fixtures/server/componentes/divisor.js';
import { divisoresAlimentados } from '../../../fixtures/server/componentes/divisorElectrico.js';
import type { InstanciaElaborada } from '../../../../server/src/componentes/elaboracion.js';
import type { ContextoModeloTemporal, ModeloTemporalComponente } from '../../../../server/src/componentes/temporal.js';

beforeAll(precalentar, 60_000);
describe('agenda compartida sobre esquemas jerárquicos', () => {
  it('aplica eventos por instancia y agrupa cambios simultáneos en una barrera real', async () => {
    const c = await divisoresAlimentados(undefined, true);
    const vistos: { tiempo: bigint; ruta: string[]; salida: number }[] = [];
    const modelo = (ruta: string[]): ModeloTemporalComponente => ({
      iniciar(ctx) {
        ctx.programarEn(10n, 'cambiar'); ctx.programarEn(10n, 'medir', {}, 'observacion');
      },
      evento(ctx, e) {
        if (e.tipo === 'cambiar') ctx.ponerParametro('ohms', ruta.includes('izquierda') ? 3000 : 4000);
        else vistos.push({ tiempo: ctx.ahoraPs, ruta, salida: ctx.leerTension(ruta.slice(0, -1), 'OUT') });
      },
    });
    const resolver = vi.fn(analizarGrafoElaboradoDc);
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      resolver, crearModelo: i => i.ruta.at(-1) === 'r2' ? modelo(i.ruta) : undefined,
    });
    await s.avanzarHasta(9n);
    expect(resolver).toHaveBeenCalledTimes(1);
    const antes = s.resultado;
    expect(antes?.instantePs).toBe(0n);
    await s.avanzarHasta(10n);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(vistos).toHaveLength(2);
    const r = s.resultado?.dc;
    if (!r?.resuelto) throw new Error('sin resultado');
    const vin = r.tensiones.find(t => t.puerto === 'V')?.voltios;
    if (typeof vin !== 'number') throw new Error('sin VIN');
    expect(vistos.find(v => v.ruta.includes('izquierda'))?.salida).toBeCloseTo(vin * 3 / 4, 8);
    expect(vistos.find(v => v.ruta.includes('derecha'))?.salida).toBeCloseTo(vin * 4 / 5, 8);
    expect(r.elementos.filter(e => e.tipo === 'R')).toHaveLength(4);
    expect(s.ahoraPs).toBe(10n);
  });
  it('bloquea observaciones hasta que el solver asíncrono termine y descarta respuestas tras stop', async () => {
    const c = await divisoresAlimentados();
    let liberar: () => void = () => {};
    const espera = new Promise<void>(r => { liberar = r; });
    let lecturas = 0;
    const resolver = vi.fn(async (...args: Parameters<typeof analizarGrafoElaboradoDc>) => { await espera; return analizarGrafoElaboradoDc(...args); });
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      resolver, crearModelo: i => i.ruta.at(-1) === 'r2' ? {
        iniciar(ctx) { ctx.programarEn(0n, 'leer', {}, 'observacion'); },
        evento() { lecturas++; },
      } : undefined,
    });
    const avance = s.avanzarHasta(10n);
    expect(lecturas).toBe(0); expect(s.resultado).toBeNull();
    s.detener(); liberar(); await avance;
    expect(lecturas).toBe(0); expect(s.resultado).toBeNull(); expect(s.estado).toBe('detenida');
  });
  it('no ejecuta modelos temporales en los compuestos ni comparte estado entre corridas', async () => {
    const c = await divisoresAlimentados();
    let creados = 0;
    const opciones = { crearModelo: () => {
      creados++; let contador = 0;
      return { iniciar(ctx) { ctx.programarEn(2n, 'pulso'); }, evento(ctx) { contador++; ctx.ponerParametro('ohms', 1000 + contador); } } satisfies ModeloTemporalComponente;
    } };
    // Solo hojas resistor: la fuente no admite el parámetro ohms.
    const crearModelo = (i: InstanciaElaborada) => i.definicion.id === 'resistor' ? opciones.crearModelo() : undefined;
    const a = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, { crearModelo });
    const b = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, { crearModelo });
    await a.avanzarHasta(2n); await b.avanzarHasta(2n);
    expect(creados).toBe(8); expect(a.resultado?.dc.tensiones).toEqual(b.resultado?.dc.tensiones);
    a.detener(); a.reiniciar(); await a.avanzarHasta(2n);
    expect(creados).toBe(12); expect(a.resultado?.dc.tensiones).toEqual(b.resultado?.dc.tensiones);
  });
  it.each(['fallido', 'vacio', 'no-finito'] as const)('una barrera %s retira medidas y no publica observaciones', async caso => {
    const c = await divisoresAlimentados(); let lecturas = 0;
    const resolver: typeof analizarGrafoElaboradoDc = async (...args) => {
      const base = await analizarGrafoElaboradoDc(...args);
      if (caso === 'fallido') return { ...base, resuelto: false, tensiones: null, elementos: [],
        diagnosticos: [{ mensaje: 'fallo conservado', severidad: 'peligro', pin: -1, origenes: [] }] };
      if (!base.resuelto) throw new Error('fixture sin resolver');
      return caso === 'vacio' ? { ...base, elementos: [] } : { ...base, tensiones: [...base.tensiones, { ruta: [], puerto: 'x', voltios: NaN }] };
    };
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      resolver, crearModelo: i => i.ruta.at(-1) === 'r2' ? {
        iniciar(ctx) { ctx.programarEn(0n, 'leer', {}, 'observacion'); }, evento() { lecturas++; },
      } : undefined,
    });
    await expect(s.avanzarHasta(1n)).rejects.toThrow(/sin resolver/);
    expect(s.estado).toBe('fallida'); expect(s.resultado).toBeNull(); expect(lecturas).toBe(0); expect(s.pendientes).toBe(0);
    expect(s.ultimoFallo?.dc?.resuelto).toBe(false);
    expect(s.ultimoFallo?.dc?.diagnosticos.length).toBeGreaterThan(0);
    if (caso === 'fallido') expect(s.ultimoFallo?.dc?.diagnosticos[0]?.mensaje).toBe('fallo conservado');
  });
  it('cancela eventos desde callbacks posteriores y caduca contextos retenidos', async () => {
    const c = await divisoresAlimentados(); let guardado: ContextoModeloTemporal | undefined, cancelado = false;
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.ruta.join('/') === 'izquierda/r2' ? (() => {
        let token: ReturnType<ContextoModeloTemporal['programarEn']>;
        return { iniciar(ctx) { guardado = ctx; token = ctx.programarEn(5n, 'cancelar'); ctx.programarEn(2n, 'antes'); },
          evento(ctx) { cancelado = ctx.cancelar(token); } };
      })() : undefined,
    });
    expect(() => guardado?.ponerParametro('ohms', 3000)).toThrow(/vencido/);
    await s.avanzarHasta(5n); expect(cancelado).toBe(true);
    expect(s.grafoActual.instancias.find(i => i.ruta.join('/') === 'izquierda/r2')?.parametros.ohms).toBe(1000);
  });
  it('pausa sin avanzar y protege las copias de resultados y grafo', async () => {
    const c = await divisoresAlimentados();
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes);
    s.pausar(); await s.avanzarHasta(5n); expect(s.ahoraPs).toBe(0n); expect(s.resultado).toBeNull();
    s.reanudar(); await s.avanzarHasta(5n);
    const r = s.resultado; if (!r) throw new Error('sin medidas');
    r.dc.tensiones.splice(0); s.grafoActual.instancias.splice(0);
    expect(s.resultado?.dc.tensiones.length).toBeGreaterThan(0); expect(s.grafoActual.instancias.length).toBeGreaterThan(0);
    await expect(s.avanzarHasta(4n)).rejects.toThrow(/pasado/);
    expect(s.resultado).not.toBeNull();
  });
  it('limita barreras costosas y conserva diagnóstico sin medidas residuales', async () => {
    const c = await divisoresAlimentados();
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      maxBarrerasPorAvance: 1, crearModelo: i => i.ruta.join('/') === 'izquierda/r2' ? {
        iniciar(ctx) { ctx.programarEn(1n, 'cambiar'); }, evento(ctx) { ctx.ponerParametro('ohms', 3000); },
      } : undefined,
    });
    await expect(s.avanzarHasta(1n)).rejects.toThrow(/Presupuesto de barreras/);
    expect(s.resultado).toBeNull(); expect(s.estado).toBe('fallida');
  });
  it('una observación no puede modificar el circuito después de cerrar la fase de modelo', async () => {
    const c = await divisoresAlimentados();
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.ruta.join('/') === 'izquierda/r2' ? {
        iniciar(ctx) { ctx.programarEn(0n, 'cambiar', {}, 'observacion'); }, evento(ctx) { ctx.ponerParametro('ohms', 3000); },
      } : undefined,
    });
    await expect(s.avanzarHasta(1n)).rejects.toThrow(/observación/); expect(s.resultado).toBeNull();
  });

  it('respeta la representación activa y cancela una copia sin cancelar la otra', async () => {
    const c = await divisoresAlimentados();
    const r = c.definiciones.find(d => d.id === 'resistor'), d = c.definiciones.find(d => d.id === 'divisor');
    if (!r || !d || d.tipo !== 'compuesto' || c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const envoltura = { schemaVersion: 1 as const, tipo: 'compuesto' as const, id: 'resistor-temporal', version: '1.0.0', nombre: 'Resistor seleccionable',
      puertos: r.puertos, parametros: r.parametros,
      representaciones: { equivalente: referencia(r), predeterminada: 'interno' as const },
      instancias: [{ id: 'fisico', definicion: referencia(r), parametros: { ohms: { parametro: 'ohms' } } }],
      conexiones: r.puertos.map((p, i) => ({ id: `red-${i}`, terminales: [
        { tipo: 'externo' as const, puerto: p.id }, { tipo: 'hijo' as const, instancia: 'fisico', puerto: p.id },
      ] })),
    };
    d.instancias.forEach(i => { i.definicion = referencia(envoltura); });
    c.raiz.instancias.filter(i => i.id !== 'fuente').forEach(i => { i.definicion = referencia(d); });
    const catalogo = new CatalogoComponentes([...c.definiciones, envoltura]), eventos: string[][] = [], creados: string[][] = [];
    const s = new SimulacionTemporalComponentes(catalogo, referencia(c.raiz), c.paquetes, {
      representaciones: [{ ruta: ['izquierda', 'r2'], seleccion: 'equivalente' }],
      crearModelo: i => {
        creados.push(i.ruta);
        return i.ruta.includes('r2') ? { iniciar(ctx) { ctx.programarEn(5n, 'cambiar'); }, evento(ctx) { eventos.push([...ctx.ruta]); ctx.ponerParametro('ohms', 3000); } } : undefined;
      },
    });
    expect(creados).toHaveLength(5);
    expect(creados).toContainEqual(['izquierda', 'r2']);
    expect(creados).not.toContainEqual(['izquierda', 'r2', 'fisico']);
    expect(() => s.programar({ ruta: ['izquierda', 'r2', 'fisico'], instantePs: 5n, fase: 'modelo', tipo: 'x' })).toThrow(/activa/);
    s.cancelarSubarbol(['derecha']); await s.avanzarHasta(5n);
    expect(eventos).toEqual([['izquierda', 'r2']]);
    expect(s.grafoActual.instancias.find(i => i.ruta.join('/') === 'derecha/r2/fisico')?.parametros.ohms).toBe(2000);
    expect(s.resultado?.dc.elementos.filter(e => e.tipo === 'R')).toHaveLength(4);
  });
  it('una generación cancelada no modifica parámetros tras un await', async () => {
    const c = await divisoresAlimentados(); let liberar: () => void = () => {};
    const espera = new Promise<void>(r => { liberar = r; });
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.ruta.join('/') === 'izquierda/r2' ? {
        iniciar(ctx) { ctx.programarEn(0n, 'cambiar'); },
        async evento(ctx) { await espera; ctx.ponerParametro('ohms', 3000); },
      } : undefined,
    });
    const avance = s.avanzarHasta(1n);
    s.cancelarSubarbol(['izquierda']); liberar(); await avance;
    expect(s.grafoActual.instancias.find(i => i.ruta.join('/') === 'izquierda/r2')?.parametros.ohms).toBe(1000);
    expect(s.resultado?.dc.resuelto).toBe(true);
  });

  it('conserva la ruta del modelo que falla y retira resultados anteriores', async () => {
    const c = await divisoresAlimentados();
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.ruta.join('/') === 'izquierda/r2' ? {
        iniciar(ctx) { ctx.programarEn(2n, 'fallar'); }, evento() { throw new Error('fallo del adaptador'); },
      } : undefined,
    });
    await s.avanzarHasta(1n); expect(s.resultado).not.toBeNull();
    await expect(s.avanzarHasta(2n)).rejects.toThrow(/fallo del adaptador/);
    expect(s.ultimoFallo).toMatchObject({ instantePs: 2n, ruta: ['izquierda', 'r2'], mensaje: 'fallo del adaptador' });
    expect(s.resultado).toBeNull(); expect(s.estado).toBe('fallida');
  });

  it('cancelar la raíz después de observar no reabre una fase eléctrica ya cerrada', async () => {
    const c = await divisoresAlimentados();
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.ruta.join('/') === 'izquierda/r2' ? {
        iniciar(ctx) { ctx.programarEn(0n, 'leer', {}, 'observacion'); }, evento() {},
      } : undefined,
    });
    await s.avanzarHasta(0n);
    expect(() => s.cancelarSubarbol([])).not.toThrow(); expect(s.resultado?.instantePs).toBe(0n);
    expect(s.pendientes).toBe(0);
  });

});
