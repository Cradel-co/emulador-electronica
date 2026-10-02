// Módulo TFT 1,8" genérico (ST7735, 8 pines). Sin esquemático oficial; lo común en estas placas:
// regulador de 3,3 V (662K) para el controlador, y la retroiluminación (LEDs blancos) con una
// resistencia en serie desde el pin LED. El valor de esa resistencia cambia de placa a placa: este
// modelo usa 47 Ω y un LED blanco equivalente (Vf ≈ 3 V), aproximado.
module.exports = {
  circuito(ctx) {
    const vcc = ctx.pin('VCC'), gnd = ctx.pin('GND');
    ctx.regulador(vcc, ctx.nodo('v33'), gnd, { voltios: 3.3, caida: 0.25, limiteA: 0.2, iq: 1e-6 }, 'ldo');
    ctx.resistencia(ctx.nodo('v33'), gnd, 3.3 / 0.006, 'st7735'); // ~6 mA del controlador y el panel
    ctx.resistencia(ctx.pin('LED'), ctx.nodo('luz'), 47, 'rled');
    ctx.diodo(ctx.nodo('luz'), gnd, { is: 1e-19, n: 2.4, rs: 2 }, 'backlight');
  },
  observar(l) {
    const vcc = l.vEntre('VCC', 'GND');
    const avisos = [];
    if (vcc > 6) avisos.push({ severidad: 'peligro', mensaje: `VCC en ${vcc.toFixed(1).replace('.', ',')} V: el módulo es para 3,3 a 5 V.` });
    const luz = l.i('backlight');
    if (vcc >= 3 && luz < 1e-3) avisos.push({ severidad: 'advertencia', mensaje: 'La retroiluminación (LED) no recibe corriente: la pantalla va a verse oscura. Conectá LED a 3,3 V o 5 V (o a un pin con PWM).' });
    return { ui: { on: vcc >= 3 && vcc <= 6 }, avisos };
  },
};
