import type { ModeloModulo } from '../../app/shared/src/modelo.js';
declare const module: { exports: ModeloModulo };
module.exports = {
  circuito(ctx) {
    const h = ctx.props.henrios, i0 = ctx.props.inicialA;
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || typeof i0 !== 'number' || !Number.isFinite(i0)) {
      throw new Error('Inductancia positiva y corriente inicial finitas requeridas.');
    }
    ctx.inductor(ctx.pin('1'), ctx.pin('2'), h, { i0 }, 'l');
  },
};
