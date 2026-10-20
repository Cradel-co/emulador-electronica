// LED: un diodo real (ecuación de Shockley), no una caída fija. Su Vf a 20 mA depende del
// color (vars.vf del module.json: ~2 V rojo/amarillo, ~3 V azul/blanco); en inversa aguanta
// 5 V (hoja de datos típica de un LED de 5 mm). Prende con la corriente que le pasa.
const VT = 0.025865; // tensión térmica a 27 °C
const N = 2; // factor de idealidad típico de un LED
const RS = 2; // resistencia serie interna (Ω)
const I_NOM = 0.02; // corriente a la que se especifica el Vf

import type { ModeloModulo } from '@emu/shared';

export default {
  circuito(ctx) {
    const vf = Number(ctx.vars.vf) || 2;
    // Corriente de saturación tal que a 20 mA la caída sea exactamente el Vf del color.
    const is = I_NOM / Math.exp((vf - I_NOM * RS) / (N * VT));
    ctx.diodo(ctx.pin('IN'), ctx.pin('GND'), { is, n: N, rs: RS, bv: 5, ibv: 1e-5 }, 'led');
  },
  observar(l) {
    const mA = l.i('led') * 1000;
    // La tensión inversa máxima (5 V de hoja de datos) está en las `reglas` del module.json.
    return { ui: { on: mA > 0.5, brillo: Math.max(0, Math.min(1, mA / 20)) } };
  },
} satisfies ModeloModulo;
