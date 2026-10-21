import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { SimulacionTemporalComponentes } from '../../../../server/src/componentes/temporal.js';
import { circuitoIrq } from '../../../fixtures/server/componentes/irq.js';
import { precalentar } from '../../../../server/src/sim/spice.js';
import { CatalogoComponentes } from '../../../../server/src/componentes/catalogo.js';
import { referencia, hijo } from '../../../fixtures/server/componentes/divisor.js';
import type { ContextoModeloTemporal } from '../../../../server/src/componentes/temporal.js';
import { ControladorInterrupciones } from '../../../../shared/src/componentes/interrupciones.js';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
beforeAll(precalentar, 60_000);

describe('enrutamiento IRQ entre esquemáticos jerárquicos', () => {
  it('convierte una entrada física en un pendiente y enruta su IRQ hasta el otro compuesto', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    if (c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const red = c.raiz.conexiones.find(r => r.id === 'irq'); if (!red) throw new Error('fixture'); red.terminales[0] = hijo('b', 'IRQ_OUT');
    const vistos: unknown[] = [];
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes, {
      retardoIrqPs: 2n,
      crearModelo: i => {
        if (i.definicion.id !== 'digital-prueba') return undefined;
        const irq = new ControladorInterrupciones([{ id: 'I', modo: 'ascendente', habilitada: true }]);
        return {
          iniciar(ctx) {
            if (ctx.ruta[0] === 'a') { ctx.escribirDigital('Q', 0); ctx.programarEn(5n, 'drive'); }
            else { ctx.escribirIrq('IRQ_OUT', 0); ctx.programarEn(12n, 'reconocer'); }
          },
          entradaDigital(ctx, cambio) {
            if (ctx.ruta[0] !== 'b' || cambio.puerto !== 'I') return;
            irq.muestrear('I', cambio.actual); ctx.escribirIrq('IRQ_OUT', irq.irq ? 1 : 0);
          },
          evento(ctx, e) {
            if (e.tipo === 'drive') ctx.escribirDigital('Q', 1);
            else { irq.reconocer('I'); ctx.escribirIrq('IRQ_OUT', irq.irq ? 1 : 0); }
          },
          entradaIrq(ctx, cambio) { if (ctx.ruta[0] === 'a') vistos.push([ctx.ahoraPs, cambio.actual]); },
        };
      },
    });
    await s.avanzarHasta(16n);
    expect(vistos).toEqual([[3n, 0], [8n, 1], [14n, 0]]);
    expect(s.resultado?.dc.resuelto).toBe(true);
    expect(s.resultado?.dc.elementos.filter(e => e.local === 'salida' && e.ruta.at(-1) === 'chip')).toHaveLength(1);
  });
  it('cruza dos interfaces, entrega a cada hoja una vez y conserva pulsos y orden temporal', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    const vistos: unknown[] = [];
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      retardoIrqPs: 2n,
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) {
          expect(ctx.leerIrq('IRQ_IN')).toBe('X');
          if (ctx.ruta[0] === 'a') { ctx.escribirIrq('IRQ_OUT', 0); ctx.programarEn(5n, 'pulso'); }
        },
        evento(ctx) { ctx.escribirIrq('IRQ_OUT', 1); ctx.escribirIrq('IRQ_OUT', 1); ctx.escribirIrq('IRQ_OUT', 0); },
        entradaIrq(ctx, cambio) {
          vistos.push([ctx.ruta.join('/'), ctx.ahoraPs, cambio.actual, cambio.instanteEmisionPs, cambio.origen?.ruta.join('/')]);
          expect(ctx.leerIrq('IRQ_IN')).toBe(cambio.actual);
        },
      } : undefined,
    });
    await s.avanzarHasta(9n);
    for (const ruta of ['a/interior/chip', 'b/interior/chip']) {
      expect(vistos.filter(v => Array.isArray(v) && v[0] === ruta)).toEqual([
        [ruta, 3n, 0, 1n, 'a/interior/chip'],
        [ruta, 7n, 1, 5n, 'a/interior/chip'],
        [ruta, 7n, 0, 5n, 'a/interior/chip'],
      ]);
    }
    expect(s.resultado?.dc.resuelto).toBe(true);
    expect(s.resultado?.dc.tensiones.some(t => t.puerto.startsWith('IRQ'))).toBe(false);
    expect(s.grafoActual.redes.some(r => r.dominio === 'interrupcion')).toBe(true);
  });
  it.each([
    ['emisor', 'reset'], ['emisor', 'alimentacion'], ['receptor', 'reset'], ['receptor', 'alimentacion'],
  ] as const)('invalida mensajes en tránsito por %s/%s y resincroniza al recuperar', async (afectado, motivo) => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    if (c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    if (afectado === 'emisor') {
      const red = c.raiz.conexiones.find(r => r.id === 'irq'); if (!red) throw new Error('fixture');
      red.terminales[0] = hijo('b', 'IRQ_OUT');
    }
    const emisor = afectado === 'emisor' ? 'b' : 'a', receptor = afectado === 'emisor' ? 'a' : 'b';
    const vistos: unknown[] = [], inicios: string[] = [];
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes, {
      retardoIrqPs: 5n,
      crearModelo: i => i.ruta[0] === (motivo === 'reset' ? 'reset-b' : 'fuente-b') ? {
        iniciar(ctx) { ctx.programarEn(12n, 'off'); ctx.programarEn(20n, 'on'); },
        evento(ctx, e) { ctx.ponerParametro('voltage', e.tipo === 'off' ? 0 : 3.3); },
      } : i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) {
          inicios.push(ctx.ruta[0] ?? '');
          if (ctx.ruta[0] === emisor) {
            ctx.escribirIrq('IRQ_OUT', 0);
            if (ctx.ahoraPs < 10n) ctx.programarEn(10n, 'alto');
          }
        },
        evento(ctx) { ctx.escribirIrq('IRQ_OUT', 1); },
        entradaIrq(ctx, cambio) { if (ctx.ruta[0] === receptor) vistos.push([ctx.ahoraPs, cambio.actual]); },
      } : undefined,
    });
    await s.avanzarHasta(30n);
    expect(vistos).toEqual(afectado === 'emisor' ? [[6n, 0], [17n, 'X'], [26n, 0]] : [[6n, 0], [26n, 1]]);
    expect(inicios.filter(r => r === 'b')).toHaveLength(2);
    expect(inicios.filter(r => r === 'a')).toHaveLength(1);
    expect(s.resultado?.dc.resuelto).toBe(true);
  });
  it('solo enruta la representación elegida y no ejecuta las interfaces como emisores', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    const bloque = c.definiciones.find(d => d.id === 'bloque');
    if (!bloque || c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    c.envoltura.representaciones = { equivalente: referencia(bloque), predeterminada: 'interno' };
    for (const i of c.raiz.instancias) if (i.id === 'a' || i.id === 'b') i.definicion = referencia(c.envoltura);
    const creados: string[] = [], recibidos: string[] = [];
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes, {
      representaciones: [{ ruta: ['a'], seleccion: 'equivalente' }],
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { creados.push(ctx.ruta.join('/')); if (ctx.ruta[0] === 'a') ctx.escribirIrq('IRQ_OUT', 1); },
        evento() {}, entradaIrq(ctx, cambio) { recibidos.push(`${ctx.ruta.join('/')}:${cambio.origen?.ruta.join('/')}`); },
      } : undefined,
    });
    await s.avanzarHasta(4n);
    expect(creados).toEqual(['a/chip', 'b/interior/chip']);
    expect(recibidos).toEqual(['a/chip:a/chip', 'b/interior/chip:a/chip']);
  });
  it('un corte anterior en el mismo instante invalida la entrega incluso hacia una hoja sin perfil', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    if (c.digital.tipo !== 'hoja-legada' || c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const receptora = { ...structuredClone(c.digital), id: 'receptora', perfilDigital: undefined };
    c.definiciones.push(receptora);
    const a = c.raiz.instancias.find(i => i.id === 'a'); if (!a) throw new Error('fixture'); a.definicion = referencia(receptora);
    const red = c.raiz.conexiones.find(r => r.id === 'irq'); if (!red) throw new Error('fixture'); red.terminales[0] = hijo('b', 'IRQ_OUT');
    const vistos: unknown[] = [];
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes, {
      retardoIrqPs: 5n,
      crearModelo: i => i.ruta[0] === 'fuente-b' ? {
        iniciar(ctx) { ctx.programarEn(15n, 'off'); }, evento(ctx) { ctx.ponerParametro('voltage', 0); },
      } : i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { ctx.escribirIrq('IRQ_OUT', 0); ctx.programarEn(10n, 'alto'); }, evento(ctx) { ctx.escribirIrq('IRQ_OUT', 1); },
      } : i.definicion.id === 'receptora' ? {
        evento() {}, entradaIrq(ctx, cambio) { vistos.push([ctx.ahoraPs, cambio.actual]); },
      } : undefined,
    });
    await s.avanzarHasta(25n);
    expect(vistos).toEqual([[6n, 0], [20n, 'X']]); expect(s.resultado?.dc.resuelto).toBe(true);
  });
  it('una entrada IRQ sin emisor sigue X y no agrega mediciones eléctricas ficticias', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    if (c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    c.raiz.conexiones = c.raiz.conexiones.filter(r => r.id !== 'irq');
    let callbacks = 0;
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes, {
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { ctx.programarEn(3n, 'leer'); }, evento(ctx) { expect(ctx.leerIrq('IRQ_IN')).toBe('X'); },
        entradaIrq() { callbacks++; },
      } : undefined,
    });
    await s.avanzarHasta(4n); expect(callbacks).toBe(0); expect(s.resultado?.dc.resuelto).toBe(true);
  });
  it('dos copias con los mismos nombres de puerto conservan redes y estados independientes', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    if (c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    const red = c.raiz.conexiones.find(r => r.id === 'irq'); if (!red) throw new Error('fixture');
    red.terminales = [hijo('a', 'IRQ_OUT'), hijo('a', 'IRQ_IN')];
    c.raiz.conexiones.push({ id: 'irq-b', terminales: [hijo('b', 'IRQ_OUT'), hijo('b', 'IRQ_IN')] });
    const vistos: unknown[] = [];
    const s = new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes, {
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { ctx.escribirIrq('IRQ_OUT', ctx.ruta[0] === 'a' ? 1 : 0); }, evento() {},
        entradaIrq(ctx, cambio) { vistos.push([ctx.ruta[0], cambio.actual, cambio.origen?.ruta[0]]); },
      } : undefined,
    });
    await s.avanzarHasta(4n);
    expect(vistos).toEqual([['a', 1, 'a'], ['b', 0, 'b']]);
  });
  it.each(['ancho', 'bidireccional', 'emisores'] as const)('rechaza una topología IRQ no ejecutable: %s', async caso => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    if (c.raiz.tipo !== 'compuesto') throw new Error('fixture');
    if (caso === 'emisores') {
      const red = c.raiz.conexiones.find(r => r.id === 'irq'); if (!red) throw new Error('fixture'); red.terminales.push(hijo('b', 'IRQ_OUT'));
    } else for (const d of c.definiciones) for (const p of d.puertos) if (p.dominio === 'interrupcion') {
      if (caso === 'ancho') p.ancho = 2; else p.direccion = 'bidireccional';
    }
    // Se renuevan referencias de abajo hacia arriba tras modificar los contratos.
    const bloque = c.definiciones.find(d => d.id === 'bloque'); if (!bloque || bloque.tipo !== 'compuesto') throw new Error('fixture');
    for (const i of bloque.instancias) i.definicion = referencia(c.digital);
    for (const i of c.envoltura.instancias) i.definicion = referencia(bloque);
    for (const i of c.raiz.instancias) if (i.id === 'a' || i.id === 'b') i.definicion = referencia(c.envoltura);
    expect(() => new SimulacionTemporalComponentes(new CatalogoComponentes(c.definiciones), referencia(c.raiz), c.paquetes)).toThrow(caso === 'emisores' ? /Múltiples salidas/ : /IRQ/);
  });
  it('el presupuesto de la agenda detiene una realimentación IRQ y retira las medidas', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      limitesAgenda: { eventosPorAvance: 100 },
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { if (ctx.ruta[0] === 'a') ctx.escribirIrq('IRQ_OUT', 0); }, evento() {},
        entradaIrq(ctx, cambio) { if (ctx.ruta[0] === 'a') ctx.escribirIrq('IRQ_OUT', cambio.actual === 0 ? 1 : 0); },
      } : undefined,
    });
    await expect(s.avanzarHasta(1000n)).rejects.toThrow(/Presupuesto/);
    expect(s.estado).toBe('fallida'); expect(s.pendientes).toBe(0); expect(s.resultado).toBeNull();
  });
  it('retira de la cola los mensajes del emisor cancelado, aunque sus receptores estén fuera del subárbol', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      retardoIrqPs: 100n,
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { if (ctx.ruta[0] === 'a') { ctx.escribirIrq('IRQ_OUT', 0); ctx.programarEn(5n, 'alto'); } },
        evento(ctx) { ctx.escribirIrq('IRQ_OUT', 1); },
      } : undefined,
    });
    await s.avanzarHasta(5n); s.cancelarSubarbol(['a']);
    // Solo quedan las dos publicaciones X nuevas; ninguna entrega antigua retiene presupuesto.
    expect(s.pendientes).toBe(2);
    for (let n = 0; n < 100; n++) {
      s.cancelarSubarbol(['a']); expect(s.pendientes).toBe(2);
    }
    await s.avanzarHasta(106n); expect(s.pendientes).toBe(0);
  });
  it('pausa la entrega y descarta mensajes de la corrida anterior al detener y reiniciar', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir); const vistos: unknown[] = [];
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      retardoIrqPs: 3n,
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { if (ctx.ruta[0] === 'a') { ctx.escribirIrq('IRQ_OUT', 0); ctx.programarEn(10n, 'alto'); } },
        evento(ctx) { ctx.escribirIrq('IRQ_OUT', 1); },
        entradaIrq(ctx, cambio) { if (ctx.ruta[0] === 'b') vistos.push([ctx.ahoraPs, cambio.actual]); },
      } : undefined,
    });
    await s.avanzarHasta(10n); s.pausar(); await s.avanzarHasta(20n);
    expect(s.ahoraPs).toBe(10n); expect(vistos).toEqual([[4n, 0]]);
    s.reanudar(); await s.avanzarHasta(12n); expect(vistos).toEqual([[4n, 0]]);
    s.detener(); expect(s.pendientes).toBe(0); s.reiniciar(); await s.avanzarHasta(14n);
    expect(vistos).toEqual([[4n, 0], [4n, 0], [13n, 1]]);
  });
  it('rechaza retardos nulos o negativos y lecturas de salidas', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    for (const retardoIrqPs of [0n, -1n]) expect(() => new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, { retardoIrqPs })).toThrow(/Retardo IRQ/);
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { ctx.leerIrq('IRQ_OUT'); }, evento() {},
      } : undefined,
    });
    await expect(s.avanzarHasta(2n)).rejects.toThrow(/Entrada IRQ/);
  });
  it.each(['entrada', 'electrico', 'observacion'] as const)('rechaza emitir desde puerto o fase inválida: %s', async caso => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { if (ctx.ruta[0] === 'a') ctx.programarEn(4n, 'invalido', {}, caso === 'observacion' ? 'observacion' : 'modelo'); },
        evento(ctx) { ctx.escribirIrq(caso === 'entrada' ? 'IRQ_IN' : caso === 'electrico' ? 'Q' : 'IRQ_OUT', 1); },
      } : undefined,
    });
    expect(() => s.programar({ ruta: ['a', 'interior', 'chip'], instantePs: 4n, fase: 'modelo', tipo: '$irq:entrada' })).toThrow(/coordinador/);
    await expect(s.avanzarHasta(5n)).rejects.toThrow(/IRQ/);
    expect(s.estado).toBe('fallida'); expect(s.resultado).toBeNull(); expect(s.pendientes).toBe(0);
  });
  it('cancelar un emisor invalida el contexto de un receptor asíncrono en curso', async () => {
    const c = await circuitoIrq(); dirs.push(c.dir);
    let entrar: () => void = () => {}, liberar: () => void = () => {};
    const entrada = new Promise<void>(r => { entrar = r; }), espera = new Promise<void>(r => { liberar = r; });
    let contexto: ContextoModeloTemporal | undefined, servicios = 0;
    const s = new SimulacionTemporalComponentes(c.catalogo, c.referencia, c.paquetes, {
      crearModelo: i => i.definicion.id === 'digital-prueba' ? {
        iniciar(ctx) { if (ctx.ruta[0] === 'a') ctx.programarEn(5n, 'alto'); },
        evento(ctx) { if (ctx.ruta[0] === 'a') ctx.escribirIrq('IRQ_OUT', 1); else servicios++; },
        async entradaIrq(ctx, cambio) {
          if (ctx.ruta[0] !== 'b' || cambio.actual !== 1) return;
          contexto = ctx; entrar(); await espera; ctx.programarEn(9n, 'servicio');
        },
      } : undefined,
    });
    const avance = s.avanzarHasta(10n); await entrada;
    s.cancelarSubarbol(['a']);
    expect(() => contexto?.leerIrq('IRQ_IN')).toThrow(/vencido/);
    liberar(); await avance;
    expect(servicios).toBe(0); expect(s.estado).toBe('activa');
  });
});
