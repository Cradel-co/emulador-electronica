// Transmisor RF STX882 (433 MHz): alimentación 1,2–6 V. En reposo casi no consume; mientras
// DATA está en alto transmite y consume ~34 mA a 5 V. DATA es una entrada de alta impedancia.
module.exports = {
  circuito(ctx) {
    ctx.resistencia(ctx.pin('DATA'), ctx.pin('GND'), 100000, 'entrada');
    ctx.resistencia(ctx.pin('VCC'), ctx.nodo('tx'), 147, 'tx');
    ctx.interruptorControlado(ctx.nodo('tx'), ctx.pin('GND'), ctx.pin('DATA'), ctx.pin('GND'),
      { umbral: 1.0, histeresis: 0.1, ron: 1 }, 'modulador');
  },
  observar(l) {
    const v = l.vEntre('VCC', 'GND');
    const avisos = [];
    if (v > 6.5) avisos.push({ severidad: 'peligro', mensaje: `VCC del STX882 en ${v.toFixed(1).replace('.', ',')} V: el máximo es 6 V, se daña.` });
    return { ui: { on: l.i('tx') > 0.005 }, avisos };
  },
};
