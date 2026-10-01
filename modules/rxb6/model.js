// Receptor RF RXB6 (433 MHz): alimentación 3,3–5,5 V, consume ~4,5 mA. Se modela su consumo
// (la salida DATA la maneja el puente de radio de la simulación).
module.exports = {
  circuito(ctx) {
    ctx.resistencia(ctx.pin('VCC'), ctx.pin('GND'), 1100, 'consumo');
  },
  observar(l) {
    const v = l.vEntre('VCC', 'GND');
    const avisos = [];
    if (v > 6) avisos.push({ severidad: 'peligro', mensaje: `VCC del RXB6 en ${v.toFixed(1).replace('.', ',')} V: el máximo es 5,5 V, se daña.` });
    else if (v > 0.5 && v < 3.3) avisos.push({ severidad: 'advertencia', mensaje: `VCC del RXB6 en ${v.toFixed(1).replace('.', ',')} V: necesita entre 3,3 y 5,5 V para recibir bien.` });
    return { ui: { on: v >= 3.3 && v <= 5.5 }, avisos };
  },
};
