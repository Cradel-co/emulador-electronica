// Resistencia: Ley de Ohm (V = I·R). Potencia nominal 1/4 W, como una de carbón común:
// por encima se calienta de más, y con más del doble se quema.
module.exports = {
  circuito(ctx) {
    ctx.resistencia(ctx.pin('1'), ctx.pin('2'), Number(ctx.props.ohms), 'r');
  },
  observar(l) {
    const p = Math.abs(l.p('r'));
    const avisos = [];
    if (p > 0.5) {
      avisos.push({ severidad: 'peligro', mensaje: `Disipa ${p.toFixed(2).replace('.', ',')} W: más del doble de su potencia nominal (1/4 W). Se quema.` });
    } else if (p > 0.25) {
      avisos.push({ severidad: 'advertencia', mensaje: `Disipa ${p.toFixed(2).replace('.', ',')} W: más de su potencia nominal (1/4 W), se calienta de más. Usá una de 1/2 W o más.` });
    }
    return { avisos };
  },
};
