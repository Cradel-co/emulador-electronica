// Módulo OLED genérico de 0,96" (4 pines, I2C). No hay un esquemático oficial: sigue lo que tienen
// las placas más vendidas: regulador de 3,3 V en SOT-23 (marcado 662K, tipo XC6206: caída ~0,25 V,
// hasta 200 mA, ~1 µA propio) para la lógica y la bomba de carga del SSD1306, y pull-ups de 4,7 kΩ
// a VCC en SCL y SDA (en algunas placas son de 10 kΩ).
//
// Consumo: el de un OLED depende de cuántos píxeles están prendidos y del contraste (de ~1 mA con
// la pantalla negra a ~20 mA toda blanca). El modelo eléctrico no conoce la imagen: usa 10 mA,
// un valor típico con texto y gráficos.
module.exports = {
  circuito(ctx) {
    const vcc = ctx.pin('VCC'), gnd = ctx.pin('GND');
    ctx.regulador(vcc, ctx.nodo('v33'), gnd, { voltios: 3.3, caida: 0.25, limiteA: 0.2, iq: 1e-6 }, 'ldo');
    ctx.resistencia(ctx.nodo('v33'), gnd, 3.3 / 0.01, 'oled');
    ctx.resistencia(ctx.pin('SCL'), vcc, 4700, 'pullupSCL');
    ctx.resistencia(ctx.pin('SDA'), vcc, 4700, 'pullupSDA');
  },
  observar(l) {
    const vcc = l.vEntre('VCC', 'GND');
    // Los límites de VCC están en las `reglas` del module.json.
    return { ui: { on: vcc >= 3.0 && vcc <= 6 } };
  },
};
