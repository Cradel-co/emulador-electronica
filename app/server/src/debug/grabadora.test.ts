import { describe, expect, it, vi } from 'vitest';
import { Grabadora } from './grabadora.js';
import { DetectorErrores, type ErrorDetectado } from './errores.js';

describe('Grabadora', () => {
  it('registra con tiempo y seq, y devuelve lo nuevo desde un seq', () => {
    const g = new Grabadora(100);
    g.reiniciar({ proyecto: 'p' });
    const a = g.registrar('serial', { linea: 'hola' });
    const b = g.registrar('estado', { estado: 'booted' });
    expect(b.seq).toBe(a.seq + 1);
    expect(a.t).toBeGreaterThanOrEqual(0);
    expect(g.desde(0).eventos.map((e) => e.tipo)).toEqual(['serial', 'estado']);
    expect(g.desde(a.seq).eventos).toEqual([b]);
    expect(g.desde(0, { tipos: ['estado'] }).eventos).toEqual([b]);
    expect(g.corrida.proyecto).toBe('p');
  });

  it('buffer circular acotado: pisa lo viejo y cuenta lo perdido', () => {
    const g = new Grabadora(10, 5);
    for (let i = 0; i < 25; i++) g.registrar('serial', { linea: `l${i}` });
    const r = g.desde(0, { limite: 100 });
    expect(r.eventos).toHaveLength(10);
    expect(r.eventos[0]!.linea).toBe('l15');
    expect(r.perdidos).toBe(15);
    expect(g.desde(3).seHuboSaltos).toBe(true);
    // Las últimas líneas de consola se guardan aparte (acotadas también).
    expect(g.ultimasLineas(100).map((l) => l.linea)).toEqual(['l20', 'l21', 'l22', 'l23', 'l24']);
    // Con límite, los más nuevos.
    expect(g.desde(0, { limite: 2 }).eventos.map((e) => e.linea)).toEqual(['l23', 'l24']);
  });

  it('pines: solo registra cambios, separa entrada y salida, y quién la puso', () => {
    const g = new Grabadora();
    expect(g.pin(7, 1, 'salida', 'firmware')).not.toBeNull();
    expect(g.pin(7, 1, 'salida', 'firmware')).toBeNull(); // mismo nivel: nada
    g.pin(6, 0, 'entrada', 'ui');
    g.pin(7, 0, 'salida', 'firmware');
    expect(g.pines.get(7)).toMatchObject({ salida: 0, entrada: null, cambios: 2 });
    expect(g.pines.get(6)).toMatchObject({ entrada: 0, origenEntrada: 'ui' });
    expect([...g.nivelesSalida()]).toEqual([[7, 0]]);
    expect(g.desde(0, { tipos: ['pin'] }).eventos.map((e) => `${e.pin}:${e.direccion}:${e.nivel}:${e.origen}`)).toEqual([
      '7:salida:1:firmware',
      '6:entrada:0:ui',
      '7:salida:0:firmware',
    ]);
  });

  it('recorta textos largos y no deja pisar seq/t/tipo', () => {
    const g = new Grabadora();
    const e = g.registrar('error', { tipo: 'traceback', seq: 999, mensaje: 'x'.repeat(1000) });
    expect(e.tipo).toBe('error');
    expect(e.seq).not.toBe(999);
    expect(String(e.mensaje).length).toBeLessThan(310);
    expect(g.ultimosErrores()).toEqual([e]);
  });

  it('reiniciar vacía todo menos la numeración (para seguir con ?since=)', () => {
    const g = new Grabadora();
    g.registrar('serial', { linea: 'a' });
    g.pin(1, 1, 'salida', 'firmware');
    const ultimo = g.totalEventos;
    g.reiniciar();
    expect(g.desde(0).eventos).toEqual([]);
    expect(g.pines.size).toBe(0);
    expect(g.registrar('app', {}).seq).toBe(ultimo + 1);
  });
});

describe('DetectorErrores', () => {
  const juntar = (lineas: string[], resolver?: ConstructorParameters<typeof DetectorErrores>[1]): ErrorDetectado[] => {
    const out: ErrorDetectado[] = [];
    const d = new DetectorErrores((e) => out.push(e), resolver ?? null);
    lineas.forEach((l, i) => d.linea(l, i * 10));
    d.cerrarBloque();
    return out;
  };

  it('Traceback de MicroPython (real, del emulador) con archivo:línea', () => {
    const [e] = juntar(['voy a fallar', 'Traceback (most recent call last):', '  File "main.py", line 26, in <module>', 'KeyError: no-existe', 'MicroPython v1.29.0 on 2026-08-24']);
    expect(e).toMatchObject({
      tipo: 'traceback',
      mensaje: 'KeyError: no-existe (main.py:26, en <module>)',
      marcos: [{ archivo: 'main.py', linea: 26, funcion: '<module>' }],
    });
    expect(e!.lineas).toHaveLength(3);
  });

  it('Traceback con varias funciones: el más interno al final', () => {
    const [e] = juntar([
      'Traceback (most recent call last):',
      '  File "main.py", line 30, in <module>',
      '  File "main.py", line 12, in paso',
      '  File "sensores.py", line 4, in leer',
      'ZeroDivisionError: divide by zero',
    ]);
    expect(e!.marcos!.map((m) => `${m.archivo}:${m.linea}`)).toEqual(['main.py:30', 'main.py:12', 'sensores.py:4']);
    expect(e!.mensaje).toBe('ZeroDivisionError: divide by zero (sensores.py:4, en leer)');
  });

  it('Guru Meditation del ESP32 con backtrace traducido a función y línea', () => {
    const resolver = vi.fn((pc: number) => (pc === 0x42002f4e ? { funcion: 'app_main', archivo: '/project/main/main.c', linea: 14 } : null));
    const [e] = juntar(
      [
        "Guru Meditation Error: Core  0 panic'ed (LoadProhibited). Exception was unhandled.",
        '',
        'Core  0 register dump:',
        'PC      : 0x42002f4e  PS      : 0x00060d30  A0      : 0x82009e2c  A1      : 0x3fc9b3f0',
        'Backtrace: 0x42002f4e:0x3fc9b3f0 0x42009e29:0x3fc9b410',
        'ELF file SHA256: 1234',
        'Rebooting...',
      ],
      resolver,
    );
    expect(e).toMatchObject({
      tipo: 'panic',
      mensaje: 'Guru Meditation: LoadProhibited en app_main (main.c:14)',
      pc: { pc: '0x42002f4e', funcion: 'app_main', linea: 14 },
    });
    expect(e!.backtrace!.map((b) => b.pc)).toEqual(['0x42002f4e', '0x42009e29']);
  });

  it('abort() + assert en un solo bloque; stack overflow; watchdog', () => {
    const errores = juntar([
      'assert failed: app_main main.c:20 (x == 1)',
      'abort() was called at PC 0x40375e1f on core 0',
      'Rebooting...',
      '***ERROR*** A stack overflow in task loopTask has been detected.',
      'Rebooting...',
      'E (5123) task_wdt: Task watchdog got triggered. The following tasks/users did not reset the watchdog in time:',
    ]);
    expect(errores.map((e) => e.tipo)).toEqual(['assert', 'stack-overflow', 'watchdog']);
    expect(errores[0]!.mensaje).toContain('assert failed: app_main main.c:20');
    expect(errores[0]!.pc?.pc).toBe('0x40375e1f');
    expect(errores[1]!.mensaje).toBe('A stack overflow in task loopTask has been detected.');
  });

  it('errores de log (ESP-IDF y ESPHome), agrupando repetidos', () => {
    const errores = juntar(['E (1200) i2c: bus is busy', 'E (1300) i2c: bus is busy', '[E][sensor:042]: Lectura inválida', 'I (1) algo normal']);
    expect(errores.map((e) => e.mensaje)).toEqual(['i2c: bus is busy', 'sensor:042: Lectura inválida']);
    expect(errores[0]!.repeticiones).toBe(2);
  });
});
