import type { ModeloModulo } from '../../app/shared/src/modelo.js';
declare const module: { exports: ModeloModulo };

function positivo(valor: unknown, nombre: string): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) {
    throw new Error(`${nombre} debe ser un número finito mayor que cero.`);
  }
  return valor;
}

// Equivalente resistivo constante; el límite nominal es un dato declarado del usuario.
// No representa derating, curva de sobrecarga, temperatura ni avería permanente.
module.exports = {
  circuito(ctx) {
    positivo(ctx.props.powerRatedW, 'Potencia nominal');
    ctx.resistencia(ctx.pin('1'), ctx.pin('2'), positivo(ctx.props.ohms, 'Resistencia'), 'r');
  },
  observar(l) {
    const p = Math.abs(l.p('r'));
    const nominal = positivo(l.props.powerRatedW, 'Potencia nominal');
    return { avisos: p > nominal ? [{
      severidad: p > nominal * 2 ? 'peligro' : 'advertencia',
      mensaje: `Disipa ${p.toFixed(2).replace('.', ',')} W: supera la potencia nominal declarada (${nominal} W). Riesgo de sobrecalentamiento; requiere la curva de derating y las condiciones de montaje de la pieza.`,
    }] : [] };
  },
};
