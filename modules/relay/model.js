// Módulo de relé de 5 V (SRD-05VDC con transistor de mando): la entrada IN pasa por 1 kΩ a la
// base de un transistor que conecta la bobina (~70 Ω, ~71 mA a 5 V) a GND. La bobina lleva su
// diodo de rueda libre. El contacto cierra cuando por la bobina pasa al menos el 75 % de su
// corriente nominal: con VCC bajo, el relé no "pega" aunque la entrada esté activa.
module.exports = {
  circuito(ctx) {
    ctx.resistencia(ctx.pin('IN'), ctx.nodo('base'), 1000, 'rbase');
    ctx.diodo(ctx.nodo('base'), ctx.pin('GND'), { is: 1e-14, n: 1 }, 'vbe');
    ctx.resistencia(ctx.pin('VCC'), ctx.nodo('bobina'), 70, 'bobina');
    ctx.interruptorControlado(ctx.nodo('bobina'), ctx.pin('GND'), ctx.nodo('base'), ctx.pin('GND'),
      { umbral: 0.55, histeresis: 0.02, ron: 0.5 }, 'transistor');
    ctx.diodo(ctx.nodo('bobina'), ctx.pin('VCC'), { is: 1e-12, n: 1.5 }, 'ruedalibre');
  },
  observar(l) {
    const iBobina = l.i('bobina');
    const pega = iBobina > 0.75 * (5 / 70);
    const avisos = [];
    const vcc = l.vEntre('VCC', 'GND');
    if (iBobina > 0.005 && !pega) {
      avisos.push({ severidad: 'advertencia', mensaje: `La bobina recibe ${vcc.toFixed(1).replace('.', ',')} V (${(iBobina * 1000).toFixed(0)} mA): no alcanza para cerrar el contacto. El relé es de 5 V.` });
    }
    if (vcc > 7) avisos.push({ severidad: 'peligro', mensaje: `VCC del relé en ${vcc.toFixed(1).replace('.', ',')} V: la bobina es de 5 V, se recalienta.` });
    return { ui: { on: pega }, avisos };
  },
};
