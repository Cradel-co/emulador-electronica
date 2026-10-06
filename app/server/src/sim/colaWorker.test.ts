import { describe, expect, it } from 'vitest';
import { ColaWorker } from './colaWorker.js';

describe('worker eléctrico protegido', () => {
  const entry = new URL('./fixtures/workerPrueba.ts', import.meta.url);
  it('mata un bucle de CPU y recupera el siguiente trabajo sin bloquear el hilo principal', async () => {
    const cola = new ColaWorker<string, string>({ entry, timeoutMs: 1000 });
    try {
      expect(await cola.ejecutar('listo')).toBe('listo');
      let latidos = 0; const reloj = setInterval(() => { latidos++; }, 10);
      try {
        const bloqueado = cola.ejecutar('bucle');
        const siguiente = cola.ejecutar('recuperado');
        await expect(bloqueado).rejects.toThrow(/tiempo límite/);
        expect(await siguiente).toBe('recuperado');
        expect(latidos).toBeGreaterThan(10);
        expect(cola.terminaciones).toBe(1);
      } finally { clearInterval(reloj); }
    } finally { await cola.cerrar(); }
  });
  it('recupera también la salida inesperada del worker', async () => {
    const cola = new ColaWorker<string, string>({ entry, timeoutMs: 1000 });
    try {
      await expect(cola.ejecutar('salir')).rejects.toThrow(/terminó/);
      expect(await cola.ejecutar('siguiente')).toBe('siguiente');
    } finally { await cola.cerrar(); }
  });
  it('limita la cola y rechaza nuevos trabajos después de cerrar', async () => {
    const cola = new ColaWorker<string, string>({ entry, timeoutMs: 1000, maxPendientes: 1 });
    const uno = cola.ejecutar('uno');
    await expect(cola.ejecutar('dos')).rejects.toThrow(/cola/);
    expect(await uno).toBe('uno');
    await cola.cerrar();
    await expect(cola.ejecutar('tres')).rejects.toThrow(/cerrado/);
  });
});

it('el presupuesto de cálculo comienza después del arranque confirmado', async () => {
  const cola = new ColaWorker<string, string>({ entry: new URL('./fixtures/workerInicioLento.ts', import.meta.url), startupTimeoutMs: 5000, timeoutMs: 50 });
  try { expect(await cola.ejecutar('listo')).toBe('listo'); }
  finally { await cola.cerrar(); }
});
it('cerrar termina el trabajo activo y rechaza los pendientes', async () => {
  const cola = new ColaWorker<string, string>({ entry: new URL('./fixtures/workerPrueba.ts', import.meta.url) });
  await cola.ejecutar('listo');
  const activo = cola.ejecutar('bucle'); const activoRechazado = expect(activo).rejects.toThrow(/cerrado/);
  const pendiente = cola.ejecutar('pendiente'); const pendienteRechazado = expect(pendiente).rejects.toThrow(/cerrado/);
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  await cola.cerrar();
  await Promise.all([activoRechazado, pendienteRechazado]);
  expect(cola.terminaciones).toBe(1);
});
