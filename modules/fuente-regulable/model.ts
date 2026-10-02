// Canal de una fuente de laboratorio: CV/CC. Entrega el voltaje ajustado (CV) mientras la
// carga pida menos que el límite; si pide más, entrega el límite y la tensión baja (CC).
// `control` = la salida está prendida (proyecto sin placa: ▶ la prende). Apagada, no entrega nada.
module.exports = {
  circuito(ctx) {
    if (!ctx.control) return;
    const v = Number(ctx.props.voltage);
    const limiteA = Number(ctx.props.currentLimitMa) / 1000;
    ctx.fuenteTension(ctx.pin('V'), ctx.pin('GND'), v, { limiteA }, 'salida');
  },
};
