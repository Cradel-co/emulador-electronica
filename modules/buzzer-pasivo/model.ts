import type { ModeloModulo } from '../../app/shared/src/modelo.js';
declare const module: { exports: ModeloModulo };

/** Hoja de datos del PS1240P02BT (TDK) y piezos equivalentes. */
const V_PICO_MAX = 12.5;
/** Resistencia de aislación del disco: enorme, pero no infinita. */
const FUGA_OHM = 1e6;

function positivo(valor: unknown, nombre: string): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) {
    throw new Error(`${nombre} debe ser un número finito mayor que cero.`);
  }
  return valor;
}

/**
 * Buzzer pasivo: un disco piezoeléctrico, sin oscilador. No suena por recibir tensión — suena
 * porque el programa le pone una señal alterna, y de ahí que pueda tocar notas.
 *
 * Eléctricamente **es un capacitor**: en continua no conduce, así que no carga el pin que lo
 * maneja. Eso explica por qué un piezo consume casi nada comparado con un buzzer activo.
 *
 * La frecuencia y el volumen NO salen de este modelo: salen del PWM que declara el firmware más
 * la tensión que resuelve el motor (ver `salidas` en su module.json y docs/audio.md). Este modelo
 * resuelve lo eléctrico: cuánto carga el pin y si se lo está pasando de tensión.
 *
 * Lo que NO modela: la resonancia mecánica (suena bastante más fuerte cerca de sus 4 kHz que
 * lejos, y acá la amplitud no depende de la frecuencia), la impedancia que cambia con la
 * frecuencia, ni la caja o el soporte, que en un piezo real cambian mucho el resultado.
 */
module.exports = {
  circuito(ctx) {
    const nF = positivo(ctx.props.capacidadNf, 'Capacidad del piezo');
    ctx.capacitor(ctx.pin('IN'), ctx.pin('GND'), nF * 1e-9, {}, 'piezo');
    ctx.resistencia(ctx.pin('IN'), ctx.pin('GND'), FUGA_OHM, 'fuga');
  },
  observar(l) {
    const v = Math.abs(l.vEntre('IN', 'GND'));
    if (v > V_PICO_MAX) {
      return { avisos: [{
        severidad: 'peligro' as const,
        mensaje: `Tiene ${v.toFixed(1).replace('.', ',')} V de pico: el máximo es ${String(V_PICO_MAX).replace('.', ',')} V. Se despega la cerámica.`,
      }] };
    }
    return {};
  },
};
