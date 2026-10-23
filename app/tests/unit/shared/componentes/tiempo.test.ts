import { describe, expect, it } from 'vitest';
import { AgendaTemporal, RelojComponente } from '../../../../shared/src/componentes/tiempo.js';

describe('agenda común de componentes', () => {
  it('ordena instante, fase y secuencia sin reloj de pared ni pérdida de enteros', async () => {
    const agenda = new AgendaTemporal([[], ['a'], ['b']]);
    const instantePs = 9_007_199_254_740_993n;
    agenda.programar({ ruta: ['b'], instantePs, fase: 'observacion', tipo: 'leer' });
    agenda.programar({ ruta: ['a'], instantePs, fase: 'modelo', tipo: 'primero' });
    agenda.programar({ ruta: ['b'], instantePs, fase: 'entrada', tipo: 'entrada' });
    agenda.programar({ ruta: ['a'], instantePs, fase: 'modelo', tipo: 'segundo' });
    const vistos: string[] = [];
    await agenda.avanzarHasta(instantePs, e => { vistos.push(e.tipo); });
    expect(vistos).toEqual(['entrada', 'primero', 'segundo', 'leer']);
    expect(agenda.ahoraPs).toBe(instantePs);
  });
  it('cancela físicamente eventos y subárboles sin afectar a otra instancia', async () => {
    const a = new AgendaTemporal([[], ['a'], ['a', 'hijo'], ['b']]);
    const b = new AgendaTemporal([[]]);
    const token = a.programar({ ruta: ['a'], instantePs: 2n, fase: 'modelo', tipo: 'x' });
    expect(b.cancelar(token)).toBe(false);
    expect(a.cancelar(token)).toBe(true); expect(a.cancelar(token)).toBe(false);
    for (const ruta of [['a', 'hijo'], ['b']]) a.programar({ ruta, instantePs: 2n, fase: 'modelo', tipo: 'x' });
    a.cancelarSubarbol(['a']);
    expect(a.pendientes).toBe(1);
    const rutas: string[][] = [];
    await a.avanzarHasta(4n, e => { rutas.push(e.ruta); });
    expect(rutas).toEqual([['b']]);
  });
  it('pausa, detiene y reinicia sin reutilizar tokens ni eventos anteriores', async () => {
    const a = new AgendaTemporal([[]]);
    const token = a.programar({ ruta: [], instantePs: 2n, fase: 'modelo', tipo: 'x' });
    a.pausar(); await a.avanzarHasta(4n, () => { throw new Error('pausado'); });
    expect(a.ahoraPs).toBe(0n);
    a.reanudar(); await a.avanzarHasta(1n, () => {});
    a.detener(); expect(a.pendientes).toBe(0);
    await expect(a.avanzarHasta(3n, () => {})).rejects.toThrow();
    a.reiniciar(); expect(a.ahoraPs).toBe(0n); expect(a.cancelar(token)).toBe(false);
  });
  it('rechaza pasado, fases regresivas, rutas inválidas y saturación', async () => {
    const a = new AgendaTemporal([[]], { pendientes: 2, eventosPorAvance: 2 });
    expect(() => a.programar({ ruta: ['ausente'], instantePs: 0n, fase: 'modelo', tipo: 'x' })).toThrow();
    for (let i = 0; i < 2; i++) a.programar({ ruta: [], instantePs: 1n, fase: 'modelo', tipo: 'x' });
    expect(() => a.programar({ ruta: [], instantePs: 1n, fase: 'modelo', tipo: 'x' })).toThrow();
    await a.avanzarHasta(1n, () => {
      expect(() => a.programar({ ruta: [], instantePs: 1n, fase: 'entrada', tipo: 'x' })).toThrow();
      expect(() => a.programar({ ruta: [], instantePs: 0n, fase: 'modelo', tipo: 'x' })).toThrow();
    });
    await expect(a.avanzarHasta(0n, () => {})).rejects.toThrow();
  });
  it('limita bucles de duración cero y queda fallida sin eventos residuales', async () => {
    const a = new AgendaTemporal([[]], { eventosPorAvance: 3 });
    const evento = { ruta: [], instantePs: 0n, fase: 'modelo' as const, tipo: 'bucle' };
    a.programar(evento);
    await expect(a.avanzarHasta(1n, () => { a.programar(evento); })).rejects.toThrow(/presupuesto/i);
    expect(a.estado).toBe('fallida'); expect(a.pendientes).toBe(0);
  });
  it('espera barreras asíncronas y no permite avances concurrentes', async () => {
    const a = new AgendaTemporal([[]]);
    let liberar: () => void = () => {};
    const espera = new Promise<void>(r => { liberar = r; });
    a.programar({ ruta: [], instantePs: 1n, fase: 'electrico', tipo: 'resolver' });
    a.programar({ ruta: [], instantePs: 1n, fase: 'observacion', tipo: 'leer' });
    const vistos: string[] = [];
    const avance = a.avanzarHasta(3n, async e => { vistos.push(e.tipo); if (e.tipo === 'resolver') await espera; });
    await expect(a.avanzarHasta(5n, () => {})).rejects.toThrow(/curso/);
    expect(vistos).toEqual(['resolver']); expect(a.ahoraPs).toBe(1n);
    liberar(); await avance; expect(vistos).toEqual(['resolver', 'leer']);
  });

  it('una barrera raíz sigue vigente al cancelar una hoja y caduca al detenerse', () => {
    const a = new AgendaTemporal([[], ['a']]);
    const raiz = a.capturarVigencia([]), hoja = a.capturarVigencia(['a']);
    a.cancelarSubarbol(['a']); expect(raiz()).toBe(true); expect(hoja()).toBe(false);
    a.detener(); expect(raiz()).toBe(false);
    a.reiniciar(); expect(raiz()).toBe(false);
  });
  it('invalida la generación del callback en vuelo al cancelar su subárbol', async () => {
    const a = new AgendaTemporal([[], ['a']]);
    a.programar({ ruta: ['a'], instantePs: 1n, fase: 'modelo', tipo: 'x' });
    let vigente: () => boolean = () => false;
    await a.avanzarHasta(1n, (_e, contexto) => {
      vigente = contexto.vigente; expect(vigente()).toBe(true);
      a.cancelarSubarbol(['a']); expect(vigente()).toBe(false);
    });
  });
});

describe('dominio de reloj racional', () => {
  it('conserva residuos y frecuencia sin redondear cada tick', () => {
    const reloj = new RelojComponente(3n);
    expect(reloj.avanzarTicks(1n)).toBe(333_333_333_333n);
    reloj.cambiarFrecuencia(6n);
    expect(reloj.avanzarTicks(1n)).toBe(166_666_666_667n);
    expect(reloj.avanzarTicks(3n)).toBe(500_000_000_000n);
  });
  it('coincide al avanzar por lotes y rechaza frecuencias/ticks inválidos', () => {
    const a = new RelojComponente(240_000_000n), b = new RelojComponente(240_000_000n);
    let total = 0n; for (let i = 0; i < 240; i++) total += a.avanzarTicks(1n);
    expect(total).toBe(b.avanzarTicks(240n)); expect(total).toBe(1_000_000n);
    expect(() => a.avanzarTicks(-1n)).toThrow(); expect(() => a.cambiarFrecuencia(0n)).toThrow();
  });
});
