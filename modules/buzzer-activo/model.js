// Buzzer activo de 5 V (TMB12A05 y compatibles): trae su propio oscilador, así que zumba
// con solo recibir tensión. Entre 3 y 5,5 V consume ~30 mA a 5 V; por debajo de 2,5 V el
// oscilador no arranca y casi no consume. Máximo absoluto: 6 V.
//
// La FRECUENCIA (2,4 kHz) no está acá: es un dato de la hoja de datos y va en `salidas` del
// module.json, porque el motor no calcula señales en el tiempo (ver SDD-AUDIO.md). Este
// modelo resuelve lo eléctrico: si le llega tensión para arrancar, cuánto consume y si se daña.
module.exports = {
  circuito(ctx) {
    // El oscilador: un interruptor que se cierra cuando IN − GND supera 2,5 V...
    ctx.interruptorControlado(
      ctx.pin('IN'), ctx.nodo('osc'), ctx.pin('IN'), ctx.pin('GND'),
      { umbral: 2.5, histeresis: 0.1 }, 'oscilador',
    );
    // ...y lo que consume zumbando: el equivalente de ~30 mA a 5 V.
    ctx.resistencia(ctx.nodo('osc'), ctx.pin('GND'), 166, 'bobina');
  },
  observar(l) {
    const mA = l.i('bobina') * 1000;
    const v = l.vEntre('IN', 'GND');
    const avisos = [];
    if (v > 6) {
      avisos.push({ severidad: 'peligro', mensaje: `Tiene ${v.toFixed(1).replace('.', ',')} V: el máximo es 6 V, se daña.` });
    } else if (v > 5.5) {
      avisos.push({ severidad: 'advertencia', mensaje: `Tiene ${v.toFixed(1).replace('.', ',')} V: trabaja hasta 5,5 V. Zumba más fuerte pero dura menos.` });
    }
    if (v < -0.5) avisos.push({ severidad: 'advertencia', mensaje: 'Está al revés: no zumba.' });
    return { ui: { on: mA > 5 }, avisos };
  },
};
