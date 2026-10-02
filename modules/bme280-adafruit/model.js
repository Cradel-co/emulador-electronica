// Placa BME280 de Adafruit (producto 2652), según su esquemático oficial (Adafruit-BME280-
// Breakout-PCB, archivo Eagle): U2 = MIC5225-3.3 (VIN → 3VO, EN atado a VIN), Q3/Q4 = BSS138
// como adaptador de nivel en SCK y SDI, R7/R8 = 10 kΩ a VIN del lado de afuera, R1/R2 = 10 kΩ a
// 3,3 V del lado del chip, R4 = 10 kΩ de SDO a 3,3 V (dirección 0x77 por defecto) y D2 = 1N4148
// de CSB (ánodo) a CS (cátodo). El BME280 consume del riel de 3,3 V.
//
// MIC5225: 150 mA, caída ~310 mV a plena carga, ~29 µA propios (hoja de Microchip/Micrel).
// Consumo del BME280: en modo normal con x16 mide casi todo el tiempo: ~0,7 mA promedio
// (tabla 1 de la hoja de Bosch: 340/714/350 µA por canal mientras mide). El modelo eléctrico
// no sabe en qué modo está el chip: usa ese peor caso.
module.exports = {
  circuito(ctx) {
    ctx.regulador(ctx.pin('VIN'), ctx.pin('3VO'), ctx.pin('GND'), { voltios: 3.3, caida: 0.31, limiteA: 0.15, iq: 29e-6 }, 'mic5225');
    ctx.resistencia(ctx.pin('3VO'), ctx.pin('GND'), 3.3 / 0.0007, 'bme280');
    // Pull-ups del lado de afuera (los que ve el micro): a VIN.
    ctx.resistencia(ctx.pin('SCK'), ctx.pin('VIN'), 10000, 'r7');
    ctx.resistencia(ctx.pin('SDI'), ctx.pin('VIN'), 10000, 'r8');
    // SDO: pull-up a 3,3 V (R4).
    ctx.resistencia(ctx.pin('SDO'), ctx.pin('3VO'), 10000, 'r4');
    // CS: el diodo deja que CS en bajo lleve CSB a bajo (modo SPI); en alto, no hace nada.
    ctx.resistencia(ctx.nodo('csb'), ctx.pin('3VO'), 100000, 'pullCsb');
    ctx.diodo(ctx.nodo('csb'), ctx.pin('CS'), { is: 2.52e-9, n: 1.752, rs: 0.568 }, 'd2');
  },
  observar(l) {
    const vin = l.vEntre('VIN', 'GND');
    const vdd = l.vEntre('3VO', 'GND');
    const avisos = [];
    if (vin > 6) avisos.push({ severidad: 'peligro', mensaje: `VIN en ${vin.toFixed(1).replace('.', ',')} V: la placa es para 3 a 5 V; el MIC5225 aguanta hasta 6 V en operación.` });
    if (vdd > 0.5 && vdd < 1.71) avisos.push({ severidad: 'advertencia', mensaje: `El BME280 recibe ${vdd.toFixed(2).replace('.', ',')} V: necesita al menos 1,71 V (VDD de la hoja). No va a responder.` });
    else if (vin > 0.5 && vin < 3.3 + 0.31 && vdd >= 1.71) avisos.push({ severidad: 'advertencia', mensaje: `VIN en ${vin.toFixed(2).replace('.', ',')} V: el regulador está en caída y el sensor recibe ${vdd.toFixed(2).replace('.', ',')} V (anda igual: el BME280 funciona desde 1,71 V).` });
    if (vdd > 3.6) avisos.push({ severidad: 'peligro', mensaje: `El BME280 recibe ${vdd.toFixed(2).replace('.', ',')} V por 3VO: el máximo de la hoja es 3,6 V.` });
    return { ui: { on: vdd >= 1.71 && vdd <= 3.6 }, avisos };
  },
};
