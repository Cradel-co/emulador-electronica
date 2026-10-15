import type { ModeloModulo } from '../../app/shared/src/modelo.js';
declare const module: { exports: ModeloModulo };

function positivo(valor: unknown, nombre: string): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) {
    throw new Error(`${nombre} debe ser un número finito mayor que cero.`);
  }
  return valor;
}

/**
 * Potenciómetro: una resistencia con un cursor que la parte en dos. Entre A y B siempre está el
 * total; el cursor (W) lo divide según la posición (0 = pegado a A, 100 = pegado a B).
 *
 * La tensión del cursor no la escribe nadie: sale de la Ley de Ohm sobre los dos tramos, así que
 * con una carga colgada de W el divisor se carga como en la realidad.
 *
 * El límite nominal es un dato declarado del usuario. No representa derating, ley de rotación
 * (se asume lineal, no logarítmica), resistencia de contacto real, ruido del cursor ni avería
 * permanente.
 */
module.exports = {
  circuito(ctx) {
    const total = positivo(ctx.props.ohms, 'Resistencia total');
    positivo(ctx.props.powerRatedW, 'Potencia nominal');
    const posicion = Number(ctx.props.posicion);
    const x = Math.min(100, Math.max(0, Number.isFinite(posicion) ? posicion : 50)) / 100;
    // Ninguna parte llega a 0 Ω: un potenciómetro real tiene resistencia de contacto, y un
    // tramo de 0 Ω le daría a la fuente un camino sin nada que limite la corriente.
    ctx.resistencia(ctx.pin('A'), ctx.pin('W'), Math.max(1, total * x), 'tramoA');
    ctx.resistencia(ctx.pin('W'), ctx.pin('B'), Math.max(1, total * (1 - x)), 'tramoB');
  },
  observar(l) {
    const p = Math.max(Math.abs(l.p('tramoA')), Math.abs(l.p('tramoB')));
    const nominal = positivo(l.props.powerRatedW, 'Potencia nominal');
    return { avisos: p > nominal ? [{
      severidad: p > nominal * 2 ? 'peligro' : 'advertencia',
      mensaje: `Uno de sus tramos disipa ${p.toFixed(2).replace('.', ',')} W: supera la potencia nominal declarada (${nominal} W). Riesgo de quemar la pista; requiere la curva de derating de la pieza.`,
    }] : [] };
  },
};
