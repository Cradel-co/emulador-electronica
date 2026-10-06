import type { ModeloModulo } from '../../app/shared/src/modelo.js';
declare const module: { exports: ModeloModulo };
module.exports = {
  circuito(ctx) {
    const f = ctx.props.faradios, v0 = ctx.props.inicialV;
    if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0 || typeof v0 !== 'number' || !Number.isFinite(v0)) {
      throw new Error('Capacitancia positiva y tensión inicial finitas requeridas.');
    }
    ctx.capacitor(ctx.pin('1'), ctx.pin('2'), f, { v0 }, 'c');
  },
};
