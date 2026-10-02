// Módulo ZS-042: DS3231 + AT24C32. No hay un esquemático oficial (es un módulo genérico); este
// modelo sigue el que difunde la comunidad y coincide con las placas que se venden:
//  - red de 4 resistencias de 4,7 kΩ (472) de VCC a SCL, SDA, SQW y 32K;
//  - LED rojo de encendido con 1 kΩ;
//  - circuito de carga de la pila: 200 Ω + 1N4148 de VCC al + de la pila (pensado para una
//    LIR2032 recargable, pero viene con una CR2032 que NO lo es);
//  - consumo: DS3231 ~200 µA con el I2C activo (hoja: I_CCA, 200 µA a 3,63 V; 300 µA a 5,5 V)
//    + AT24C32 en reposo (unos µA).
module.exports = {
  circuito(ctx) {
    const vcc = ctx.pin('VCC'), gnd = ctx.pin('GND');
    ctx.resistencia(vcc, gnd, 5 / 0.0003, 'chips');
    for (const p of ['SCL', 'SDA', 'SQW', '32K']) ctx.resistencia(ctx.pin(p), vcc, 4700, `pullup${p}`);
    ctx.resistencia(vcc, ctx.nodo('led'), 1000, 'rled');
    ctx.diodo(ctx.nodo('led'), gnd, { is: 1e-18, n: 1.9, rs: 5 }, 'led');
    if (ctx.props.pila !== 'ninguna') {
      ctx.resistencia(vcc, ctx.nodo('carga'), 200, 'r200');
      ctx.diodo(ctx.nodo('carga'), ctx.nodo('pila'), { is: 2.52e-9, n: 1.752, rs: 0.568 }, 'd1n4148');
      // CR2032: 3,0 V; LIR2032: 3,6 V nominal. Resistencia interna de una pila de botón: ~15 Ω.
      ctx.bateria(ctx.nodo('pila'), gnd, ctx.props.pila === 'LIR2032' ? 3.6 : 3.0, { rInterna: 15 }, 'pila');
    }
  },
  observar(l) {
    const vcc = l.vEntre('VCC', 'GND');
    const avisos = [];
    if (vcc > 5.5) avisos.push({ severidad: 'peligro', mensaje: `VCC en ${vcc.toFixed(1).replace('.', ',')} V: el DS3231 aguanta hasta 5,5 V.` });
    else if (vcc > 0.5 && vcc < 2.3) avisos.push({ severidad: 'advertencia', mensaje: `VCC en ${vcc.toFixed(2).replace('.', ',')} V: el DS3231 necesita al menos 2,3 V; queda andando con la pila.` });
    if (l.props.pila !== 'ninguna') {
      const carga = l.i('pila'); // positiva: entra por el + y la atraviesa (la está cargando)
      if (l.props.pila === 'CR2032' && carga > 10e-6) {
        avisos.push({ severidad: 'peligro', mensaje: `Le entran ${(carga * 1000).toFixed(1).replace('.', ',')} mA a la CR2032 por el circuito de carga del módulo: no es recargable, se puede hinchar o romper. Alimentalo con 3,3 V, sacá el diodo o la resistencia de 200 Ω, o usá una LIR2032.` });
      }
    }
    return { ui: { on: vcc >= 2.3 && vcc <= 5.5 }, avisos };
  },
};
