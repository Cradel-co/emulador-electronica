// Receptor RF RXB6 (433 MHz): alimentación 3,3–5,5 V, consume ~4,5 mA. Se modela su consumo
// (la salida DATA la maneja el puente de radio de la simulación).
import type { ModeloModulo } from '@emu/shared';

export default {
  circuito(ctx) {
    ctx.resistencia(ctx.pin('VCC'), ctx.pin('GND'), 1100, 'consumo');
  },
  observar(l) {
    const v = l.vEntre('VCC', 'GND');
    // Los límites de VCC (3,3 a 5,5 V) están en las `reglas` del module.json.
    return { ui: { on: v >= 3.3 && v <= 5.5 } };
  },
} satisfies ModeloModulo;
