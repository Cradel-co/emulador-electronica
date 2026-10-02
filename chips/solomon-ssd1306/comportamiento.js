// Solomon Systech SSD1306 por I2C. Según la hoja Rev 1.1 (secciones entre corchetes).
//
// Lo que publica es lo que se VE en el panel del módulo, no la RAM: la RAM (GDDRAM, 8 páginas
// de 128 bytes) pasa por la línea de inicio, el desplazamiento, el multiplex, la dirección de
// barrido de COM y la configuración de pines COM (DAh) hasta llegar a cada línea física del
// panel, que está cableada de una forma fija en el módulo. Si la configuración no coincide con
// el cableado, la imagen sale espejada o intercalada, como en la pantalla real.

var ANCHO = 128;
var PUBLICAR_CADA_US = 20000; // como mucho 50 cuadros por segundo de emulación

// Cuántos parámetros lleva cada comando de varios bytes [Tabla 9-1].
var PARAMETROS = { 0x81: 1, 0x8d: 1, 0x20: 1, 0x21: 2, 0x22: 2, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1,
  0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0xa3: 2 };

var ram, r, cmd, publicarEn, azar, avisadoScroll, alto, referencia, lineaAPad;

function reset() {
  // Valores de reset [8.5 y Tabla 9-1].
  r = {
    encendida: false, contraste: 0x7f, todoEncendido: false, inverso: false,
    modo: 2,                 // 10b = direccionamiento por página
    colIni: 0, colFin: 127, pagIni: 0, pagFin: 7, col: 0, pag: 0,
    lineaInicio: 0, desplazamiento: 0, mux: 64,
    segRemap: false, comInvertido: false,
    comAlternativo: true, comLR: false, // DAh = 12h al reset
    bomba: false,           // 8Dh 10h: bomba de carga apagada
  };
  cmd = null;
}

/** Fila lógica (ROW) que el chip saca por el pad COM `pad`, o null si ese pad no se usa [10.1.15, Tablas 10-1..10-3]. */
function filaEnPad(pad, c) {
  // 1. Cableado interno de los pads según DAh: secuencial o alternado, con o sin remapeo izquierda/derecha.
  var k;
  if (!c.comAlternativo) k = c.comLR ? (pad < 32 ? pad + 32 : pad - 32) : pad;
  else if (!c.comLR) k = pad < 32 ? 2 * pad : 2 * (pad - 32) + 1;
  else k = pad < 32 ? 2 * pad + 1 : 2 * (pad - 32);
  // 2. Dirección de barrido (C0h: de COM0 a COM[N−1]; C8h: de COM[N−1] a COM0).
  if (k >= c.mux) return null;
  var s = c.comInvertido ? c.mux - 1 - k : k;
  // 3. Desplazamiento vertical (D3h): ROW = (s + offset) mod 64; las que quedan fuera del multiplex no se ven.
  var fila = (s + c.desplazamiento) % 64;
  return fila < c.mux ? fila : null;
}

/**
 * El panel del módulo: qué pad maneja cada línea física (de arriba a abajo). Es la que da una
 * imagen derecha con la configuración que usa el fabricante del módulo (la de Adafruit).
 */
function armarPanel(props) {
  alto = props.panel === '128x32' ? 32 : 64;
  referencia = alto === 32
    ? { comAlternativo: false, comLR: false, comInvertido: true, mux: 32, desplazamiento: 0 }
    : { comAlternativo: true, comLR: false, comInvertido: true, mux: 64, desplazamiento: 0 };
  lineaAPad = [];
  for (var p = 0; p < 64; p++) { var f = filaEnPad(p, referencia); if (f !== null && f < alto) lineaAPad[f] = p; }
}

function escribirDato(b) {
  // A1h (remapeo de segmentos) se aplica AL ESCRIBIR: lo que ya está en la RAM no cambia [10.1.8].
  var colRam = r.segRemap ? ANCHO - 1 - r.col : r.col;
  ram[r.pag * ANCHO + colRam] = b;
  if (r.modo === 2) { // página: avanza la columna y vuelve al inicio sin cambiar de página [10.1.3]
    r.col = r.col >= r.colFin ? r.colIni : r.col + 1;
  } else if (r.modo === 0) { // horizontal
    if (r.col >= r.colFin) { r.col = r.colIni; r.pag = r.pag >= r.pagFin ? r.pagIni : r.pag + 1; } else r.col++;
  } else { // vertical
    if (r.pag >= r.pagFin) { r.pag = r.pagIni; r.col = r.col >= r.colFin ? r.colIni : r.col + 1; } else r.pag++;
  }
}

function ejecutar(c, p) {
  if (c <= 0x0f) { if (r.modo === 2) r.col = (r.col & 0xf0) | c; return; }         // columna baja (modo página)
  if (c <= 0x1f) { if (r.modo === 2) r.col = ((c & 0x07) << 4) | (r.col & 0x0f); return; } // columna alta
  if (c >= 0x40 && c <= 0x7f) { r.lineaInicio = c & 0x3f; return; }
  if (c >= 0xb0 && c <= 0xb7) { if (r.modo === 2) r.pag = c & 7; return; }
  switch (c) {
    case 0x81: r.contraste = p[0]; break;
    case 0x8d: r.bomba = (p[0] & 0x04) !== 0; break;
    case 0x20: r.modo = p[0] & 3; if (r.modo === 3) r.modo = 2; break; // 11b no es válido
    case 0x21: r.colIni = p[0] & 0x7f; r.colFin = p[1] & 0x7f; r.col = r.colIni; break;
    case 0x22: r.pagIni = p[0] & 7; r.pagFin = p[1] & 7; r.pag = r.pagIni; break;
    case 0xa0: case 0xa1: r.segRemap = c === 0xa1; break;
    case 0xa4: case 0xa5: r.todoEncendido = c === 0xa5; break;
    case 0xa6: case 0xa7: r.inverso = c === 0xa7; break;
    case 0xa8: { var m = (p[0] & 0x3f) + 1; if (m >= 16) r.mux = m; break; } // 16 a 64; menos es inválido
    case 0xae: case 0xaf: r.encendida = c === 0xaf; break;
    case 0xc0: case 0xc8: r.comInvertido = c === 0xc8; break;
    case 0xd3: r.desplazamiento = p[0] & 0x3f; break;
    case 0xda: r.comAlternativo = (p[0] & 0x10) !== 0; r.comLR = (p[0] & 0x20) !== 0; break;
    case 0x26: case 0x27: case 0x29: case 0x2a: case 0xa3: break; // configuración de scroll: se guarda nada
    case 0x2f:
      if (!avisadoScroll) { avisadoScroll = true; ctx.log('scroll por hardware (2Fh) no emulado: la imagen queda quieta.'); }
      break;
    default: break; // 2Eh, D5h, D9h, DBh, E3h (NOP): no cambian lo que se ve
  }
}

/** Un byte de comando: arma los de varios bytes y los ejecuta cuando están completos. */
function byteComando(b) {
  if (cmd) {
    cmd.p.push(b);
    if (cmd.p.length >= cmd.n) { var x = cmd; cmd = null; ejecutar(x.c, x.p); }
    return;
  }
  var n = PARAMETROS[b];
  if (n) cmd = { c: b, n: n, p: [] };
  else ejecutar(b, []);
}

/** Lo que se ve en el panel, en hexadecimal: una fila de 16 bytes (128 píxeles) por línea física. */
function imagen() {
  var visible = r.encendida && r.bomba; // sin bomba de carga no hay tensión para los OLED
  var filas = [];
  for (var y = 0; y < alto; y++) {
    var pad = lineaAPad[y], fila = pad === undefined ? null : filaEnPad(pad, r);
    var ramFila = fila === null ? null : (fila + r.lineaInicio) % 64;
    var hex = '';
    for (var bx = 0; bx < 16; bx++) {
      var byte = 0;
      for (var i = 0; i < 8; i++) {
        var x = bx * 8 + i;
        var on = false;
        if (visible && fila !== null) {
          // El módulo cablea los segmentos al revés: SEG127 queda a la izquierda (por eso A1h da una imagen derecha).
          var colRam = ANCHO - 1 - x;
          var bit = (ram[(ramFila >> 3) * ANCHO + colRam] >> (ramFila & 7)) & 1;
          on = r.todoEncendido ? true : (bit === 1) !== r.inverso;
        }
        if (on) byte |= 0x80 >> i;
      }
      hex += (byte < 16 ? '0' : '') + byte.toString(16);
    }
    filas.push(hex);
  }
  return { tipo: 'pantalla', ancho: ANCHO, alto: alto, encendida: visible, brillo: Math.round((r.contraste / 255) * 1000) / 1000, filas: filas };
}

function ensuciar(t) {
  if (publicarEn === null) { publicarEn = t + PUBLICAR_CADA_US; ctx.despertarEn(publicarEn); }
}

module.exports = {
  encender: function (ctx) {
    azar = sdk.azar(0x1306);
    ram = [];
    for (var i = 0; i < 1024; i++) ram.push(Math.floor(azar() * 256)); // basura al encender
    reset();
    armarPanel(ctx.props);
    avisadoScroll = false;
    publicarEn = null;
    ctx.publicar(imagen());
  },
  direcciones: function (ctx) { return [ctx.props.sa0 === 'alto' ? 0x3d : 0x3c]; },
  // Cada transacción: bytes de control (Co, D/C#) y después datos o comandos [8.1.5.2].
  escribir: function (ctx, bytes) {
    var i = 0, cambio = false;
    while (i < bytes.length) {
      var control = bytes[i++];
      var co = (control & 0x80) !== 0, dato = (control & 0x40) !== 0;
      if (co) { // un solo byte y después viene otro byte de control
        if (i < bytes.length) { if (dato) escribirDato(bytes[i++]); else byteComando(bytes[i++]); cambio = true; }
        continue;
      }
      for (; i < bytes.length; i++) { if (dato) escribirDato(bytes[i]); else byteComando(bytes[i]); cambio = true; }
    }
    if (cambio) ensuciar(ctx.t);
  },
  leer: function (ctx, n) { var out = []; for (var i = 0; i < n; i++) out.push(0xff); return out; },
  tick: function (ctx) {
    if (publicarEn !== null && ctx.t >= publicarEn) { publicarEn = null; ctx.publicar(imagen()); }
    else if (publicarEn !== null) ctx.despertarEn(publicarEn);
  },
};
