import type { ModeloModulo } from '../../app/shared/src/modelo.js';
declare const module: { exports: ModeloModulo };

/** Hoja de datos del SEN0232 (DFRobot): 30–130 dBA en 0,6–2,6 V, lineales. */
const DBA_MIN = 30;
const DBA_MAX = 130;
const V_MIN = 0.6;
const V_MAX = 2.6;
/** Caída mínima del amplificador de salida: por debajo no puede sostener el fondo de escala. */
const CAIDA_V = 0.2;
/** Lo que puede entregar su salida. No es un driver de potencia: alimenta una entrada de ADC. */
const LIMITE_SALIDA_A = 0.01;

function positivo(valor: unknown, nombre: string): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) {
    throw new Error(`${nombre} debe ser un número finito mayor que cero.`);
  }
  return valor;
}

/** Tensión de salida para un nivel de sonido, recortada al rango que el sonómetro mide. */
export function tensionPorDbA(dbA: number): number {
  const nivel = Math.min(DBA_MAX, Math.max(DBA_MIN, Number.isFinite(dbA) ? dbA : DBA_MIN));
  return V_MIN + ((nivel - DBA_MIN) * (V_MAX - V_MIN)) / (DBA_MAX - DBA_MIN);
}

/**
 * Sonómetro SEN0232: un micrófono con su acondicionamiento, que entrega el nivel de sonido como
 * una tensión lineal en dBA. No suena — es una entrada, no una salida.
 *
 * La salida se modela con un regulador y no con una fuente de tensión: así la energía que entrega
 * SALE de su VCC en vez de aparecer de la nada, y si la alimentación no alcanza, el fondo de
 * escala cae solo.
 *
 * Lo que NO modela: la ponderación A real (31,5 Hz–8,5 kHz), la constante de tiempo de 125 ms, el
 * error de ±1,5 dB, ni el consumo a potencia constante de su regulador conmutado (la hoja declara
 * 14 mA a 5 V y 22 mA a 3,3 V; acá el consumo es el que declare el usuario). El nivel de sonido
 * del ambiente es un dato de la escena, no una simulación acústica.
 */
module.exports = {
  circuito(ctx) {
    const consumoA = positivo(ctx.props.consumoMa, 'Consumo declarado') / 1000;
    ctx.regulador(
      ctx.pin('VCC'), ctx.pin('OUT'), ctx.pin('GND'),
      { voltios: tensionPorDbA(Number(ctx.props.dbA)), caida: CAIDA_V, limiteA: LIMITE_SALIDA_A, iq: consumoA },
      'salida',
    );
  },
  observar(l) {
    const v = l.vEntre('VCC', 'GND');
    const avisos = [];
    if (v > 5.5) {
      avisos.push({ severidad: 'peligro' as const, mensaje: `Tiene ${v.toFixed(1).replace('.', ',')} V: trabaja con 3,3 a 5 V, se daña.` });
    } else if (v > 0.5 && v < 3.3) {
      avisos.push({ severidad: 'advertencia' as const, mensaje: `Tiene ${v.toFixed(1).replace('.', ',')} V: necesita al menos 3,3 V. La medición no es confiable.` });
    }
    return { avisos };
  },
};
