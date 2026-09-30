import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AvrEmulator } from '../avrEmulator.js';
import type { EmulatorEvents } from '../emulator.js';
import { AdaptadorAvr } from './adaptadorAvr.js';
import { cargarSimbolos } from './simbolos.js';
import type { EstadoEjecucion } from './tipos.js';

/**
 * Depurador del Arduino Uno sobre avr8js (modo local, en el mismo hilo) con un sketch
 * compilado de verdad por arduino-cli (fixtures/depuracion/uno-debug.cpp):
 *   volatile unsigned long contador (línea 9) se incrementa en cada loop (línea 17),
 *   char nombre[12] = "uno-debug".
 */
const fixture = (n: string): string => fileURLToPath(new URL(`../fixtures/depuracion/${n}`, import.meta.url));
const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const emuladores: AvrEmulator[] = [];
afterEach(async () => {
  for (const e of emuladores.splice(0)) await e.stop();
});

async function arrancar(): Promise<{ emu: AvrEmulator; a: AdaptadorAvr; paradas: EstadoEjecucion[]; serial: string[] }> {
  const serial: string[] = [];
  const eventos: EmulatorEvents = { onLog: (l) => serial.push(l), onState: () => undefined, onBridgeMessage: () => undefined, onBridgeState: () => undefined };
  const emu = new AvrEmulator(eventos, 'local');
  emuladores.push(emu);
  await emu.start('uno-debug', { firmware: fixture('uno-debug.hex'), elf: fixture('uno-debug.elf'), usesApi: false, usesWebServer: false, needsRepl: false });
  const paradas: EstadoEjecucion[] = [];
  const a = new AdaptadorAvr(await cargarSimbolos(fixture('uno-debug.elf')), emu, {
    detenido: (e) => paradas.push(e),
    continuado: () => undefined,
    aviso: () => undefined,
  });
  await a.iniciar();
  return { emu, a, paradas, serial };
}

async function hasta(cond: () => boolean, ms = 5000): Promise<void> {
  const fin = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fin) throw new Error('no se cumplió a tiempo');
    await esperar(10);
  }
}

describe('AdaptadorAvr (avr8js + .elf real de arduino-cli)', () => {
  it('lee globales de la SRAM con su tipo, sin frenar el programa', async () => {
    const { a } = await arrancar();
    await esperar(200);
    const c1 = Number((await a.evaluate('contador')).result);
    await esperar(200);
    const c2 = Number((await a.evaluate('contador')).result);
    expect(c1).toBeGreaterThan(0);
    expect(c2).toBeGreaterThan(c1); // sigue corriendo
    expect(await a.evaluate('nombre')).toMatchObject({ result: '"uno-debug"', type: 'char [12]', memoryReference: '0x00800100' });
    expect((await a.evaluate('nombre[4] == 100')).result).toBe('1'); // 'd'
    expect(Buffer.from(await a.leerMemoria(0x800100, 9)).toString()).toBe('uno-debug');

    const scopes = await a.scopes();
    expect(scopes.map((s) => s.name)).toEqual(['Globales del programa', 'Registros de E/S (PORTx, DDRx, PINx, timers...)', 'Otras globales (framework)', 'Registros']);
    const globales = await a.variables(scopes[0]!.variablesReference);
    expect(globales.map((v) => v.name)).toEqual(['contador', 'nombre']);
    const es = await a.variables(scopes[1]!.variablesReference);
    // D13 (PB5) es salida: DDRB tiene el bit 5 en 1.
    expect(Number(es.find((v) => v.name === 'DDRB')!.value.split(' ')[0]) & 0x20).toBe(0x20);
    const regs = await a.variables(scopes[3]!.variablesReference);
    expect(regs.map((r) => r.name).slice(0, 4)).toEqual(['PC', 'SP', 'SREG', 'r0']);
    const resumen = (await a.resumen()) as { globales: Record<string, string>; cpu: { funcion: string } };
    expect(resumen.globales.contador).toMatch(/^\d+ {2}\(volatile long unsigned int\)$/);
  });

  it('breakpoint en sketch.cpp:17, continuar = una vuelta de loop, next, pausa', async () => {
    const { a, paradas } = await arrancar();
    const [bp] = await a.setBreakpoints(new Map([['sketch.cpp', [17]]]), []);
    expect(bp).toMatchObject({ verified: true, line: 17, instructionReference: ['0x00000740'] });
    await hasta(() => a.estado().status === 'stopped');
    expect(a.estado()).toMatchObject({ reason: 'breakpoint', line: 17, function: 'main', hitBreakpointIds: [bp!.id] });
    const v1 = Number((await a.evaluate('contador')).result);
    // Frenado: el valor no cambia.
    await esperar(100);
    expect(Number((await a.evaluate('contador')).result)).toBe(v1);

    await a.control('continue');
    await hasta(() => paradas.length >= 2);
    expect(Number((await a.evaluate('contador')).result)).toBe(v1 + 1);

    await a.control('next');
    await hasta(() => paradas.length >= 3);
    expect(a.estado()).toMatchObject({ reason: 'step', line: 18 });
    expect(Number((await a.evaluate('contador')).result)).toBe(v1 + 2);
    const pila = await a.stackTrace();
    expect(pila[0]).toMatchObject({ name: 'main', line: 18, source: { name: 'sketch.cpp' } });

    // Sin breakpoints sigue libre; pause lo frena donde esté.
    await a.setBreakpoints(new Map(), []);
    await a.control('continue');
    expect(a.estado().status).toBe('running');
    await esperar(100);
    const e = await a.control('pause');
    expect(e).toMatchObject({ status: 'stopped', reason: 'pause' });
    await a.control('continue');
    expect(a.estado().status).toBe('running');
  });

  it('breakpoint por función: micros sí; loop no existe (LTO) y lo explica', async () => {
    const { a } = await arrancar();
    const bps = await a.setBreakpoints(new Map(), ['micros', 'loop']);
    expect(bps[0]).toMatchObject({ verified: true, function: 'micros' });
    expect(bps[1]).toMatchObject({ verified: false, function: 'loop', message: expect.stringContaining('LTO') });
    await hasta(() => a.estado().status === 'stopped');
    expect(a.estado().function).toBe('micros');
    // stepOut: vuelve a quien llamó a micros (pila por escaneo, aproximada).
    await a.control('stepOut');
    await hasta(() => a.estado().reason === 'step');
    expect(a.estado().function).not.toBe('micros');
  });
});
