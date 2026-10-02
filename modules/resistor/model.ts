// Resistencia: Ley de Ohm (V = I·R). Potencia nominal 1/4 W, como una de carbón común: los
// límites (se calienta de más, se quema) están en las `reglas` del module.json.
import type { ModeloModulo } from '@emu/shared';

export default {
  circuito(ctx) {
    ctx.resistencia(ctx.pin('1'), ctx.pin('2'), Number(ctx.props.ohms), 'r');
  },
} satisfies ModeloModulo;
