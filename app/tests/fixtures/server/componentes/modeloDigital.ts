import type { ModeloModulo } from '../../../../shared/src/modelo.js';

/** Perfil de prueba declarado: salida resistiva a sus rieles, sin consumo ni protección ESD. */
export default {
  circuito(ctx) {
    const nivel = ctx.props.nivel;
    if (nivel === 'Z') return;
    if (nivel !== '0' && nivel !== '1') throw new Error('Nivel digital inválido');
    ctx.resistencia(ctx.pin('Q'), ctx.pin(nivel === '1' ? 'VCC' : 'GND'), Number(ctx.props.ron), 'salida');
  },
} satisfies ModeloModulo;
