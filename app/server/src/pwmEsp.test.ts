import { describe, expect, it, vi } from 'vitest';
import { PuentePwm } from './pwmEsp.js';

/**
 * El PWM que declara el firmware. Lo que llega es `@PWM <gpio> <hz> <duty_u16> <ticks>`, o
 * `@PWM <gpio> off 0 <ticks>` cuando el programa libera el pin.
 */

const p = () => new PuentePwm();

describe('PuentePwm', () => {
  it('guarda frecuencia y ciclo de trabajo de un pin', () => {
    const b = p();
    expect(b.recibir('@PWM 5 440 32768 123')).toBe(true);
    expect(b.estado().get(5)).toEqual({ hz: 440, duty: 32768 / 65535 });
  });

  it('el duty llega en 0..65535 y sale en 0..1', () => {
    const b = p();
    b.recibir('@PWM 5 440 0 1');
    expect(b.estado().get(5)?.duty).toBe(0);
    b.recibir('@PWM 5 440 65535 2');
    expect(b.estado().get(5)?.duty).toBe(1);
  });

  it('off libera el pin', () => {
    const b = p();
    b.recibir('@PWM 5 440 32768 1');
    expect(b.recibir('@PWM 5 off 0 2')).toBe(true);
    expect(b.estado().has(5)).toBe(false);
  });

  it('cada pin es independiente', () => {
    const b = p();
    b.recibir('@PWM 5 440 32768 1');
    b.recibir('@PWM 6 880 16384 2');
    expect(b.estado().get(5)?.hz).toBe(440);
    expect(b.estado().get(6)?.hz).toBe(880);
    b.recibir('@PWM 5 off 0 3');
    expect(b.estado().get(6)?.hz).toBe(880);
  });

  it('el último aviso de un pin manda', () => {
    const b = p();
    b.recibir('@PWM 5 440 32768 1');
    b.recibir('@PWM 5 494 16384 2');
    expect(b.estado().get(5)).toEqual({ hz: 494, duty: 16384 / 65535 });
  });

  it('avisa cuando algo cambió, y no cuando no', () => {
    const alCambiar = vi.fn();
    const b = new PuentePwm(alCambiar);
    b.recibir('@PWM 5 440 32768 1');
    expect(alCambiar).toHaveBeenCalledTimes(1);
    b.recibir('@PWM 5 440 32768 2');
    expect(alCambiar).toHaveBeenCalledTimes(1);
    b.recibir('@PWM 5 494 32768 3');
    expect(alCambiar).toHaveBeenCalledTimes(2);
  });

  it('una línea que no entiende la deja pasar sin romperse', () => {
    const b = p();
    for (const linea of [
      '@PWM', '@PWM 5', '@PWM 5 440', '@PWM x 440 100 1', '@PWM 5 440 100',
      '@PWM 5 -1 100 1', '@PWM 5 440 -1 1', '@PWM 5 440 99999 1', '@PWM 5 nada 0 1',
      '@P 5 1 1', 'cualquier cosa', `@PWM 5 440 ${'9'.repeat(400)} 1`,
    ]) {
      expect(b.recibir(linea), linea).toBe(false);
    }
    expect(b.estado().size).toBe(0);
  });

  it('se limpia al reiniciar el programa: el PWM no sobrevive un reset', () => {
    const b = p();
    b.recibir('@PWM 5 440 32768 1');
    b.limpiar();
    expect(b.estado().size).toBe(0);
  });
});
