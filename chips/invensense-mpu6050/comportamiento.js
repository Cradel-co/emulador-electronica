// InvenSense MPU-6050 por I2C. Mapa de registros RM-MPU-6000A rev. 4.0 [RM] y especificación
// PS-MPU-6000A rev. 3.1 [PS].
//
// Los datos se actualizan a la frecuencia de muestreo (registro 25) mientras el chip está
// despierto, con el filtro digital (DLPF) como un pasabajos de primer orden del ancho de banda de
// la tabla del registro 26, ruido según la densidad espectral de la hoja y, si se piden, los
// errores típicos de fábrica (cero y escala) que hacen que todo el mundo calibre este sensor.

var ARRANQUE_US = 20000;               // [PS 6.3] Start-up time for register read/write: 20 ms (máx. 100)
var ESCALA_ACEL = [16384, 8192, 4096, 2048];   // LSB/g [PS 6.2]
var ESCALA_GIRO = [131, 65.5, 32.8, 16.4];      // LSB/(°/s) [PS 6.1]
var BW_ACEL = [260, 184, 94, 44, 21, 10, 5, 260]; // Hz por DLPF_CFG [RM 4.3]
var BW_GIRO = [256, 188, 98, 42, 20, 10, 5, 256];
var RUIDO_ACEL_G = 400e-6;             // g/√Hz [PS 6.2]
var RUIDO_GIRO = 0.005;                // °/s/√Hz [PS 6.1]
var PULSO_US = 50;                     // INT sin LATCH_INT_EN: pulso de 50 µs [RM 4.15]
var MAX_INT_HZ = 1000;

var reg, errores, azar, filtro, ultimaMuestra, despiertoDesde, intPin, avisadoInt, pulsoHasta;

function defaults() {
  reg = [];
  for (var i = 0; i < 128; i++) reg.push(0);
  reg[0x6b] = 0x40;                    // arranca dormido [RM 3]
  reg[0x75] = 0x68;                    // WHO_AM_I
  filtro = null;
  ultimaMuestra = -1;
  despiertoDesde = null;
}

function gauss() {
  var u = Math.max(azar(), 1e-12), v = azar();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Errores de fábrica fijos por semilla, dentro de los típicos de la hoja [PS 6.1, 6.2]. */
function armarErrores(props) {
  var r = sdk.azar(Number(props.semilla) || 6050);
  function g() { var u = Math.max(r(), 1e-12), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function lim(x, m) { return Math.max(-m, Math.min(m, x)); }
  if (props.errores === 'ninguno') return { ceroAcel: [0, 0, 0], ceroGiro: [0, 0, 0], escala: [1, 1, 1, 1, 1, 1] };
  return {
    ceroAcel: [lim(g() * 0.02, 0.05), lim(g() * 0.02, 0.05), lim(g() * 0.03, 0.08)], // g: ±50 mg X/Y, ±80 mg Z
    ceroGiro: [lim(g() * 6, 20), lim(g() * 6, 20), lim(g() * 6, 20)],                // °/s: ZRO ±20 °/s
    escala: [1 + lim(g() * 0.01, 0.03), 1 + lim(g() * 0.01, 0.03), 1 + lim(g() * 0.01, 0.03),
             1 + lim(g() * 0.01, 0.03), 1 + lim(g() * 0.01, 0.03), 1 + lim(g() * 0.01, 0.03)], // ±3 %
  };
}

function dormido() { return (reg[0x6b] & 0x40) !== 0; }
function dlpf() { return reg[0x1a] & 7; }
function periodoUs() {
  var base = dlpf() === 0 || dlpf() === 7 ? 8000 : 1000;   // Hz de salida del giróscopo [RM 4.2]
  return 1e6 / (base / (1 + reg[0x19]));
}

/** Lo que mide el chip en el instante t: el entorno pasado por el filtro (primer orden) y con ruido. */
function medir(t) {
  var e = ctx.entorno;
  var objetivo = [e.aceleracionX, e.aceleracionY, e.aceleracionZ, e.giroX, e.giroY, e.giroZ];
  var bw = [BW_ACEL[dlpf()], BW_ACEL[dlpf()], BW_ACEL[dlpf()], BW_GIRO[dlpf()], BW_GIRO[dlpf()], BW_GIRO[dlpf()]];
  if (!filtro) filtro = { t: t, v: objetivo.slice() };
  var dt = Math.max(0, t - filtro.t) / 1e6;
  for (var i = 0; i < 6; i++) {
    var tau = 1 / (2 * Math.PI * bw[i]);
    filtro.v[i] += (objetivo[i] - filtro.v[i]) * (1 - Math.exp(-dt / tau));
  }
  filtro.t = t;
  var out = [];
  for (var k = 0; k < 3; k++) out.push((filtro.v[k] * errores.escala[k] + errores.ceroAcel[k] + gauss() * RUIDO_ACEL_G * Math.sqrt(bw[k])));
  for (var j = 3; j < 6; j++) out.push((filtro.v[j] * errores.escala[j] + errores.ceroGiro[j - 3] + gauss() * RUIDO_GIRO * Math.sqrt(bw[j])));
  return out;
}

function a16(v) { v = Math.round(v); return v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
function guardar16(dir, v) { var u = sdk.sinSigno(a16(v), 16); reg[dir] = u >> 8; reg[dir + 1] = u & 0xff; }

/** Muestras nuevas hasta t: registros de datos y el flag de dato listo [RM 4.17]. */
function avanzar(t) {
  if (dormido() || despiertoDesde === null) return;
  var p = periodoUs();
  var n = Math.floor((t - despiertoDesde) / p);
  if (n <= ultimaMuestra) return;
  ultimaMuestra = n;
  var tm = despiertoDesde + n * p;
  var m = medir(tm);
  var fsA = ESCALA_ACEL[(reg[0x1c] >> 3) & 3], fsG = ESCALA_GIRO[(reg[0x1b] >> 3) & 3];
  guardar16(0x3b, m[0] * fsA); guardar16(0x3d, m[1] * fsA); guardar16(0x3f, m[2] * fsA);
  if (!(reg[0x6b] & 0x08)) guardar16(0x41, (ctx.entorno.temperatura - 36.53) * 340); // TEMP_DIS [RM 4.30]
  guardar16(0x43, m[3] * fsG); guardar16(0x45, m[4] * fsG); guardar16(0x47, m[5] * fsG);
  reg[0x3a] |= 0x01;                   // DATA_RDY_INT
}

function sinFiltro() { filtro = null; }

/** El pin INT según INT_PIN_CFG [RM 4.15] y el despertador para la próxima muestra. */
function pinInt(t) {
  var cfg = reg[0x37], activo = (reg[0x38] & 1) && (reg[0x3a] & 1);
  var nivelActivo = cfg & 0x80 ? 0 : 1, abierto = (cfg & 0x40) !== 0;
  var latch = (cfg & 0x20) !== 0;
  var alto = latch ? activo : (activo && t < pulsoHasta);
  var nivel = alto ? nivelActivo : 1 - nivelActivo;
  if (abierto && nivel === 1) nivel = null; // colector abierto: el 1 lo pone el pull-up
  ctx.pin('INT', nivel);
}

function programar(t) {
  if (!(reg[0x38] & 1) || dormido() || despiertoDesde === null) return;
  var p = periodoUs();
  if (1e6 / p > MAX_INT_HZ) {
    if (!avisadoInt) { avisadoInt = true; ctx.log('interrupción de dato listo a más de 1 kHz de muestreo: no se emula el pin INT (subí SMPLRT_DIV o activá el DLPF).'); }
    return;
  }
  var proxima = despiertoDesde + (ultimaMuestra + 1) * p;
  ctx.despertarEn(pulsoHasta > t ? Math.min(pulsoHasta, proxima) : proxima);
}

function tick(t) {
  var antes = ultimaMuestra;
  avanzar(t);
  if (ultimaMuestra !== antes && (reg[0x38] & 1)) pulsoHasta = despiertoDesde + ultimaMuestra * periodoUs() + PULSO_US;
  pinInt(t);
  programar(t);
}

function escribirRegistro(r, v, t) {
  if (r === 0x75 || (r >= 0x3a && r <= 0x48)) return; // solo lectura
  if (r === 0x6b) {
    if (v & 0x80) { defaults(); return; }            // DEVICE_RESET: todo a los valores de reset [RM 4.30]
    var estabaDormido = dormido();
    reg[0x6b] = v & 0x7f;
    if (estabaDormido && !dormido()) { despiertoDesde = t; ultimaMuestra = -1; sinFiltro(); }
    if (!estabaDormido && dormido()) despiertoDesde = null;
    return;
  }
  if (r === 0x68) { // SIGNAL_PATH_RESET: limpia lo medido [RM 4.27]
    if (v & 4) { reg[0x43] = reg[0x44] = reg[0x45] = reg[0x46] = reg[0x47] = reg[0x48] = 0; }
    if (v & 2) { reg[0x3b] = reg[0x3c] = reg[0x3d] = reg[0x3e] = reg[0x3f] = reg[0x40] = 0; }
    if (v & 1) { reg[0x41] = reg[0x42] = 0; }
    sinFiltro();
    return;
  }
  if (r === 0x6a) { // USER_CTRL: los bits de reset (2..0) se borran solos [RM 4.29]
    reg[r] = v & ~0x07;
    if (v & 1) { for (var k = 0x3b; k <= 0x48; k++) reg[k] = 0; sinFiltro(); } // SIG_COND_RESET: limpia lo medido
    return;
  }
  if (r === 0x19 || r === 0x1a) { reg[r] = v; if (despiertoDesde !== null) { despiertoDesde = t; ultimaMuestra = -1; } return; }
  reg[r] = v;
}

var puntero = 0;

module.exports = {
  encender: function (ctx) {
    defaults();
    errores = armarErrores(ctx.props);
    azar = sdk.azar((Number(ctx.props.semilla) || 6050) + 1);
    intPin = null; avisadoInt = false; pulsoHasta = 0;
    ctx.ocupadoHasta(ctx.t + ARRANQUE_US);
    pinInt(ctx.t);
  },
  direcciones: function (ctx) { return [ctx.props.ad0 === 'alto' ? 0x69 : 0x68]; },
  // Escritura en ráfaga: registro y datos con autoincremento [PS 9.3].
  escribir: function (ctx, bytes) {
    tick(ctx.t);
    if (bytes.length === 0) return;
    puntero = bytes[0] & 0x7f;
    for (var i = 1; i < bytes.length; i++) { escribirRegistro(puntero, bytes[i], ctx.t); puntero = (puntero + 1) & 0x7f; }
    tick(ctx.t);
  },
  leer: function (ctx, n) {
    tick(ctx.t);
    var out = [];
    for (var i = 0; i < n; i++) out.push(reg[(puntero + i) & 0x7f]);
    return out;
  },
  leidos: function (ctx, n) {
    // Leer INT_STATUS borra sus flags; con INT_RD_CLEAR, cualquier lectura [RM 4.15, 4.17].
    var leyoEstado = false;
    for (var i = 0; i < n; i++) if (((puntero + i) & 0x7f) === 0x3a) leyoEstado = true;
    if (n > 0 && (leyoEstado || (reg[0x37] & 0x10))) reg[0x3a] = 0;
    puntero = (puntero + n) & 0x7f;
    pinInt(ctx.t);
  },
  tick: function (ctx) { tick(ctx.t); },
};
