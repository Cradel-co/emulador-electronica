// Contacto mecánico: mientras está activo (apretado / encendido) une sus dos patas con
// ~50 mΩ, como un pulsador o una llave real; suelto, es un circuito abierto.
module.exports = {
  circuito(ctx) {
    ctx.interruptor(ctx.pin('OUT'), ctx.pin('GND'), ctx.control, { ron: 0.05 }, 'contacto');
  },
};
