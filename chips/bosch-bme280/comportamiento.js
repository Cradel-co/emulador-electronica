// Bosch BME280, por I2C. Basado en la hoja de datos BST-BME280-DS001 rev. 1.23 (las secciones
// van entre corchetes). El chip entrega valores CRUDOS de su ADC; el firmware los convierte con
// las fórmulas de compensación [4.2.3] y los coeficientes de calibración que lee del chip. Para
// que el firmware muestre la temperatura del entorno, este modelo hace la cuenta al revés: busca
// el valor crudo que, pasado por la fórmula de Bosch, da esa temperatura.

// --- Calibración [4.2.2] ----------------------------------------------------------------
// T y P: los coeficientes del ejemplo de Bosch. H: un juego típico de un chip real.
var CAL = { T1: 27504, T2: 26435, T3: -1000, P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7,
  P7: 15500, P8: -14600, P9: 6000, H1: 75, H2: 362, H3: 0, H4: 313, H5: 50, H6: 30 };

var NVM = (function () {
  var m = {};
  function u16(dir, v) { v = sdk.sinSigno(v, 16); m[dir] = v & 0xff; m[dir + 1] = v >> 8; }
  u16(0x88, CAL.T1); u16(0x8a, CAL.T2); u16(0x8c, CAL.T3);
  u16(0x8e, CAL.P1); u16(0x90, CAL.P2); u16(0x92, CAL.P3); u16(0x94, CAL.P4); u16(0x96, CAL.P5);
  u16(0x98, CAL.P6); u16(0x9a, CAL.P7); u16(0x9c, CAL.P8); u16(0x9e, CAL.P9);
  m[0xa1] = CAL.H1;
  u16(0xe1, CAL.H2);
  m[0xe3] = CAL.H3;
  var h4 = sdk.sinSigno(CAL.H4, 12), h5 = sdk.sinSigno(CAL.H5, 12);
  m[0xe4] = (h4 >> 4) & 0xff;                          // dig_H4 [11:4]
  m[0xe5] = (h4 & 0x0f) | ((h5 & 0x0f) << 4);          // dig_H4 [3:0] y dig_H5 [3:0]
  m[0xe6] = (h5 >> 4) & 0xff;                          // dig_H5 [11:4]
  m[0xe7] = sdk.sinSigno(CAL.H6, 8);
  return m;
})();

// --- Compensación de Bosch [4.2.3], tal cual (enteros de 32 bits; presión en 64) ----------
function compT(adcT) {
  var v1 = Math.imul(((adcT >> 3) - (CAL.T1 << 1)), CAL.T2) >> 11;
  var d = (adcT >> 4) - CAL.T1;
  var v2 = Math.imul(Math.imul(d, d) >> 12, CAL.T3) >> 14;
  var tFine = (v1 + v2) | 0;
  return { t: (Math.imul(tFine, 5) + 128) >> 8, tFine: tFine }; // centésimas de °C
}
function compP(adcP, tFine) {
  var P1 = BigInt(CAL.P1), P2 = BigInt(CAL.P2), P3 = BigInt(CAL.P3), P4 = BigInt(CAL.P4), P5 = BigInt(CAL.P5),
    P6 = BigInt(CAL.P6), P7 = BigInt(CAL.P7), P8 = BigInt(CAL.P8), P9 = BigInt(CAL.P9);
  var v1 = BigInt(tFine) - 128000n;
  var v2 = v1 * v1 * P6;
  v2 = v2 + ((v1 * P5) << 17n);
  v2 = v2 + (P4 << 35n);
  v1 = ((v1 * v1 * P3) >> 8n) + ((v1 * P2) << 12n);
  v1 = (((1n << 47n) + v1) * P1) >> 33n;
  if (v1 === 0n) return 0;
  var p = 1048576n - BigInt(adcP);
  p = (((p << 31n) - v2) * 3125n) / v1;
  v1 = (P9 * (p >> 13n) * (p >> 13n)) >> 25n;
  v2 = (P8 * p) >> 19n;
  p = ((p + v1 + v2) >> 8n) + (P7 << 4n);
  return Number(p) / 256; // Pa
}
function compH(adcH, tFine) {
  var v = (tFine - 76800) | 0;
  v = Math.imul(
    ((((adcH << 14) - (CAL.H4 << 20) - Math.imul(CAL.H5, v)) + 16384) >> 15),
    (((((Math.imul((Math.imul(v, CAL.H6) >> 10), ((Math.imul(v, CAL.H3) >> 11) + 32768)) >> 10) + 2097152) * CAL.H2) + 8192) >> 14)
  );
  v = v - (Math.imul(Math.imul(v >> 15, v >> 15) >> 7, CAL.H1) >> 4);
  v = v < 0 ? 0 : v > 419430400 ? 419430400 : v;
  return (v >> 12) / 1024; // %HR
}

// --- Registros y modos -----------------------------------------------------------------
var OSRS = [0, 1, 2, 4, 8, 16, 16, 16];                 // [5.4.3] y [5.4.5]
var FILTRO = [1, 2, 4, 8, 16, 16, 16, 16];              // [5.4.6] tabla 28 (1 = apagado)
var STANDBY_MS = [0.5, 62.5, 125, 250, 500, 1000, 10, 20]; // [5.4.6] tabla 27
var RUIDO_T = [0, 0.005, 0.004, 0.003, 0.003, 0.003];   // °C RMS por osrs_t [tabla 14]
var RUIDO_P = [0, 3.3, 2.6, 2.1, 1.6, 1.3];             // Pa RMS por osrs_p, sin filtro [tabla 12]
var RUIDO_H = [0, 0.07, 0.05, 0.04, 0.03, 0.02];        // %HR RMS por osrs_h [tabla 11]
var ARRANQUE_US = 2000;                                  // t_startup [1.1, tabla 1]

var s;          // estado del chip (se arma en reset)
var azar;

function reset(t) {
  s = {
    listoDesde: t + ARRANQUE_US,
    puntero: 0,
    ctrlHum: 0, ctrlMeas: 0, config: 0,
    osrsH: 0,                 // el efectivo: ctrl_hum se aplica al escribir ctrl_meas [5.4.3]
    modo: 0,                  // 0 dormido, 1 forzado, 3 normal
    medicion: null,           // { inicio, fin } en µs
    normalDesde: 0, ciclosHechos: 0,
    pendiente: null,          // ctrl_meas escrito durante una medición: espera al final [3.3.1]
    datos: { p: 0x80000, t: 0x80000, h: 0x8000 },   // valores de reset [tabla 18]
    filtro: { t: null, p: null },
  };
  ctx.ocupadoHasta(s.listoDesde);
}

function tMedicionUs() {
  // t_measure típico [9.1]: 1 + [2·T] + [2·P + 0,5] + [2·H + 0,5] ms (los términos con osrs = 0 no van).
  var ot = OSRS[(s.ctrlMeas >> 5) & 7], op = OSRS[(s.ctrlMeas >> 2) & 7], oh = OSRS[s.osrsH];
  var ms = 1 + (ot ? 2 * ot : 0) + (op ? 2 * op + 0.5 : 0) + (oh ? 2 * oh + 0.5 : 0);
  return ms * 1000;
}

function gauss() {
  var u = Math.max(azar(), 1e-12), v = azar();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Una medición completa con el entorno de ahora [3.4, figura 6]. */
function medir() {
  var e = ctx.entorno;
  var it = (s.ctrlMeas >> 5) & 7, ip = (s.ctrlMeas >> 2) & 7, ih = s.osrsH;
  var coef = FILTRO[(s.config >> 2) & 7];
  var tObj = e.temperatura + gauss() * RUIDO_T[Math.min(it, 5)];
  // Se invierte contra t_fine (≈ 0,0002 °C por paso), no contra la salida en centésimas: si no,
  // el valor queda siempre redondeado hacia arriba (sesgo de hasta 0,01 °C).
  var adcT = sdk.invertirMonotona(function (a) { return compT(a).tFine; }, tObj * 5120, 0, 0xfffff);
  var tFine = compT(adcT).tFine;
  // La presión y la humedad se compensan con la temperatura medida en el mismo ciclo.
  var pObj = e.presion * 100 + gauss() * RUIDO_P[Math.min(ip, 5)];
  var adcP = sdk.invertirMonotona(function (a) { return compP(a, tFine); }, pObj, 0, 0xfffff);
  var hObj = sdk.limitar(e.humedad + gauss() * RUIDO_H[Math.min(ih, 5)], 0, 100);
  var adcH = sdk.invertirMonotona(function (a) { return compH(a, tFine); }, hObj, 0, 0xffff);

  // Resolución [3.4.2/3.4.3]: sin filtro, 16 + (osrs − 1) bits; con filtro, 20 bits.
  function resolucion(adc, i) { return coef > 1 ? adc : adc & ~((1 << (20 - (16 + Math.min(i, 5) - 1))) - 1); }
  // Filtro IIR [3.4.4]: el primer valor después de reiniciarlo pasa sin cambios.
  function filtrar(canal, adc) {
    if (coef === 1 || s.filtro[canal] === null) { s.filtro[canal] = adc; return adc; }
    s.filtro[canal] = Math.floor((s.filtro[canal] * (coef - 1) + adc) / coef);
    return s.filtro[canal];
  }
  // Un canal salteado da 0x80000 (0x8000 la humedad) y no toca su memoria del filtro [3.4.4].
  s.datos.t = it ? resolucion(filtrar('t', adcT), it) : 0x80000;
  s.datos.p = ip ? resolucion(filtrar('p', adcP), ip) : 0x80000;
  s.datos.h = ih ? adcH : 0x8000;
}

/**
 * Lleva el chip hasta el instante t. Si había un cambio de modo esperando el final de la
 * medición en curso [3.3.1], primero avanza hasta ese final, lo aplica ahí, y sigue.
 */
function avanzar(t) {
  if (s.pendiente !== null && t >= s.pendiente.en) {
    var p = s.pendiente;
    avanzarHasta(p.en);
    s.pendiente = null;
    s.medicion = null;
    escribirCtrlMeas(p.valor, p.en);
  }
  avanzarHasta(t);
}

function avanzarHasta(t) {
  if (s.modo === 1 && s.medicion && t >= s.medicion.fin) {
    medir();
    s.medicion = null;
    s.modo = 0; // el modo forzado vuelve solo a dormido [3.3.3]
  }
  if (s.modo === 3) {
    var tm = tMedicionUs(), periodo = tm + STANDBY_MS[(s.config >> 5) & 7] * 1000;
    // Ciclos completos desde que entró en modo normal (el primero arranca enseguida) [3.3.4].
    var hechos = Math.max(0, Math.floor((t - s.normalDesde - tm) / periodo) + 1);
    var nuevos = hechos - s.ciclosHechos;
    // Si pasaron muchos, alcanza con los últimos para que el filtro converja.
    for (var k = Math.max(0, nuevos - 64); k < nuevos; k++) medir();
    s.ciclosHechos = hechos;
    var enCiclo = (t - s.normalDesde) % periodo;
    s.medicion = t >= s.normalDesde && enCiclo < tm ? { inicio: t - enCiclo, fin: t - enCiclo + tm } : null;
  }
}

function escribirCtrlMeas(v, t) {
  // Durante una medición, el cambio espera a que termine [3.3.1].
  if (s.medicion) { s.pendiente = { valor: v, en: s.medicion.fin }; return; }
  s.ctrlMeas = v;
  s.osrsH = s.ctrlHum & 7; // ahora sí se aplica ctrl_hum [5.4.3]
  var modo = v & 3;
  if (modo === 2) modo = 1; // 01 y 10 son forzado [tabla 25]
  s.modo = modo;
  if (modo === 1) s.medicion = { inicio: t, fin: t + tMedicionUs() };
  if (modo === 3) { s.normalDesde = t; s.ciclosHechos = 0; avanzarHasta(t); }
}

function escribirRegistro(r, v, t) {
  if (r === 0xe0) { if (v === 0xb6) reset(t); return; }           // [5.4.2]
  if (r === 0xf2) { if (s.pendiente === null) s.ctrlHum = v & 7; return; } // [5.4.3], [3.3.1]
  if (r === 0xf4) { if (s.pendiente === null) escribirCtrlMeas(v, t); return; }
  if (r === 0xf5) {
    if (s.modo === 3) return;                     // en modo normal se puede ignorar [5.4.6]
    if (((v >> 2) & 7) !== ((s.config >> 2) & 7)) s.filtro = { t: null, p: null }; // reinicia el filtro [3.4.4]
    s.config = v & 0xfd;                           // bit 1 no existe
    return;
  }
  // El resto es de solo lectura: escribirlo no hace nada.
}

function leerRegistro(r, t) {
  if (r >= 0x88 && r <= 0xa1) return NVM[r] || 0;
  if (r >= 0xe1 && r <= 0xf0) return NVM[r] || 0;
  switch (r) {
    case 0xd0: return 0x60;
    case 0xe0: return 0x00;
    case 0xf2: return s.ctrlHum;
    case 0xf3: return (s.medicion ? 0x08 : 0) | (t < s.listoDesde ? 0x01 : 0);
    case 0xf4: return (s.ctrlMeas & 0xfc) | s.modo;
    case 0xf5: return s.config;
    case 0xf7: return (s.datos.p >> 12) & 0xff;
    case 0xf8: return (s.datos.p >> 4) & 0xff;
    case 0xf9: return (s.datos.p & 0x0f) << 4;
    case 0xfa: return (s.datos.t >> 12) & 0xff;
    case 0xfb: return (s.datos.t >> 4) & 0xff;
    case 0xfc: return (s.datos.t & 0x0f) << 4;
    case 0xfd: return (s.datos.h >> 8) & 0xff;
    case 0xfe: return s.datos.h & 0xff;
    default: return 0x00;
  }
}

module.exports = {
  encender: function (ctx) {
    azar = sdk.azar(Number(ctx.props.semilla) || 0x280);
    reset(ctx.t);
  },
  direcciones: function (ctx) {
    return [ctx.props.sdo === 'bajo' ? 0x76 : 0x77];
  },
  // Escritura I2C [6.2.1]: el primer byte es el registro; después, pares registro/dato
  // (sin autoincremento al escribir). Un solo byte solo mueve el puntero de lectura.
  escribir: function (ctx, bytes) {
    avanzar(ctx.t);
    if (bytes.length === 0) return;
    s.puntero = bytes[0];
    for (var i = 0; i + 1 < bytes.length; i += 2) escribirRegistro(bytes[i], bytes[i + 1], ctx.t);
  },
  // Lectura [6.2.2]: autoincrementa desde el puntero. Lo que se lee en una ráfaga es una foto
  // del momento en que empezó (los registros de datos tienen sombra durante la lectura).
  leer: function (ctx, n) {
    avanzar(ctx.t);
    var out = [];
    for (var i = 0; i < n; i++) out.push(leerRegistro((s.puntero + i) & 0xff, ctx.t));
    return out;
  },
  leidos: function (ctx, n) {
    s.puntero = (s.puntero + n) & 0xff;
  },
  // El bus avisa antes de cambiar el entorno: las mediciones que ya terminaron usan el de antes.
  tick: function (ctx) { avanzar(ctx.t); },
};
