// Sitronix ST7735R por SPI (4 hilos con D/CX). Hoja ST7735R V0.2 [secciones entre corchetes].
//
// La memoria (GRAM) es de 132 × 162 o de 128 × 160 según cómo esté configurado el chip en el módulo
// (pines GM). Cada píxel que entra se guarda donde dicen el puntero de columna y de fila (CASET,
// RASET) pasados por MADCTL: MX y MY invierten el orden de columnas y filas, MV las intercambia.
// El panel del módulo está cableado de una forma fija a esa memoria: lo que se ve sale de ahí, con
// el filtro de color del panel (RGB o BGR) y la inversión.

var PUBLICAR_CADA_US = 50000;          // como mucho 20 cuadros por segundo de emulación

var PANELES = {
  // Pestaña negra o roja: memoria de 128 × 160 (GM), el panel la cubre entera.
  negra: { ancho: 128, alto: 160, gramCols: 128, gramFilas: 160, x0: 127, y0: 159, bgr: false },
  roja:  { ancho: 128, alto: 160, gramCols: 128, gramFilas: 160, x0: 127, y0: 159, bgr: true },
  // Pestaña verde: memoria de 132 × 162 con el panel corrido (columnas 2..129, filas 1..160).
  verde: { ancho: 128, alto: 160, gramCols: 132, gramFilas: 162, x0: 129, y0: 160, bgr: true },
};

var panel, gram, r, cmd, publicarEn, escribiendo, azar;

function reset() {
  // Valores por defecto [10.1.2 SWRESET, tabla de valores de reset]: sleep in, display off,
  // MADCTL 00h, COLMOD 18 bits (06h), ventana entera.
  r = {
    dormido: true, encendido: false, invertido: false,
    madctl: 0x00, colmod: 0x06,
    xs: 0, xe: panel.gramCols - 1, ys: 0, ye: panel.gramFilas - 1,
    c: 0, f: 0,
  };
  cmd = null; escribiendo = false; pendientePixel = [];
}

// --- Escritura de píxeles [10.1.21 RAMWR, 9.x Memory Data Access Control] ---------------------
var pendientePixel = [];
function guardarPixel(rr, gg, bb) {
  var mv = r.madctl & 0x20, mx = r.madctl & 0x40, my = r.madctl & 0x80;
  // Con MV el contador de "columna" recorre las filas físicas.
  var maxC = (mv ? panel.gramFilas : panel.gramCols) - 1, maxF = (mv ? panel.gramCols : panel.gramFilas) - 1;
  var c = mx ? maxC - r.c : r.c, f = my ? maxF - r.f : r.f;
  var col = mv ? f : c, fila = mv ? c : f;
  if (col >= 0 && col < panel.gramCols && fila >= 0 && fila < panel.gramFilas) {
    var i = (fila * panel.gramCols + col) * 3;
    gram[i] = rr; gram[i + 1] = gg; gram[i + 2] = bb;
  }
  // Avanza: columna hasta XE, después la fila; al terminar la ventana vuelve a empezar.
  if (r.c >= r.xe) { r.c = r.xs; r.f = r.f >= r.ye ? r.ys : r.f + 1; } else r.c++;
}

/** Un byte de dato durante RAMWR, según el formato de color (COLMOD) [10.1.30]. */
function datoPixel(b) {
  pendientePixel.push(b);
  var fmt = r.colmod & 7;
  if (fmt === 5 && pendientePixel.length === 2) {            // 16 bits: RRRRRGGG GGGBBBBB
    var v = (pendientePixel[0] << 8) | pendientePixel[1];
    guardarPixel(((v >> 11) & 0x1f) << 3 | ((v >> 13) & 7), ((v >> 5) & 0x3f) << 2 | ((v >> 9) & 3), (v & 0x1f) << 3 | ((v >> 2) & 7));
    pendientePixel = [];
  } else if (fmt === 6 && pendientePixel.length === 3) {     // 18 bits: un byte por color (6 bits altos)
    guardarPixel(pendientePixel[0] & 0xfc, pendientePixel[1] & 0xfc, pendientePixel[2] & 0xfc);
    pendientePixel = [];
  } else if (fmt === 3 && pendientePixel.length === 3) {     // 12 bits: dos píxeles en tres bytes
    var p = pendientePixel;
    guardarPixel(p[0] & 0xf0, (p[0] << 4) & 0xf0, p[1] & 0xf0);
    guardarPixel((p[1] << 4) & 0xf0, p[2] & 0xf0, (p[2] << 4) & 0xf0);
    pendientePixel = [];
  } else if (fmt !== 3 && fmt !== 5 && fmt !== 6) {
    pendientePixel = []; // formato no definido: se descarta
  }
}

// --- Comandos [10.1] -------------------------------------------------------------------------
var PARAMETROS = { 0x2a: 4, 0x2b: 4, 0x36: 1, 0x3a: 1, 0x26: 1, 0xb1: 3, 0xb2: 3, 0xb3: 6, 0xb4: 1, 0xb6: 2,
  0xc0: 3, 0xc1: 1, 0xc2: 2, 0xc3: 2, 0xc4: 2, 0xc5: 1, 0xc7: 1, 0xe0: 16, 0xe1: 16, 0x30: 4, 0x33: 6, 0x37: 2 };

function ejecutar(c, p) {
  switch (c) {
    case 0x01: reset(); break;                                    // SWRESET
    case 0x10: r.dormido = true; break;                           // SLPIN
    case 0x11: r.dormido = false; break;                          // SLPOUT
    case 0x20: r.invertido = false; break;                        // INVOFF
    case 0x21: r.invertido = true; break;                         // INVON
    case 0x28: r.encendido = false; break;                        // DISPOFF
    case 0x29: r.encendido = true; break;                         // DISPON
    case 0x2a: r.xs = (p[0] << 8) | p[1]; r.xe = (p[2] << 8) | p[3]; r.c = r.xs; break; // CASET
    case 0x2b: r.ys = (p[0] << 8) | p[1]; r.ye = (p[2] << 8) | p[3]; r.f = r.ys; break; // RASET
    case 0x36: r.madctl = p[0]; break;                            // MADCTL
    case 0x3a: r.colmod = p[0]; break;                            // COLMOD
    default: break; // NOP, NORON, frame rate, power, gamma...: no cambian lo que se ve
  }
}

function byteComando(b) {
  escribiendo = false;
  pendientePixel = [];
  if (b === 0x2c) { r.c = r.xs; r.f = r.ys; escribiendo = true; return; } // RAMWR: desde el inicio de la ventana
  var n = PARAMETROS[b];
  if (n) cmd = { c: b, n: n, p: [] }; else { cmd = null; ejecutar(b, []); }
}

function byteDato(b) {
  if (cmd) { cmd.p.push(b); if (cmd.p.length >= cmd.n) { var x = cmd; cmd = null; ejecutar(x.c, x.p); } return; }
  if (escribiendo) datoPixel(b);
}

/** Lo que se ve: RGB565 en base64, fila por fila (el panel de 128 × 160, mirando de frente). */
function imagen() {
  var visible = !r.dormido && r.encendido;
  var bytes = new Array(panel.ancho * panel.alto * 2);
  // El filtro del panel: si MADCTL dice otro orden que el del panel, se ven rojo y azul cambiados.
  var cambiarRB = ((r.madctl & 0x08) !== 0) !== panel.bgr;
  for (var y = 0, k = 0; y < panel.alto; y++) {
    for (var x = 0; x < panel.ancho; x++, k += 2) {
      var R = 255, G = 255, B = 255; // apagada o dormida: página en blanco (TN normalmente blanco)
      if (visible) {
        var i = ((panel.y0 - y) * panel.gramCols + (panel.x0 - x)) * 3;
        R = gram[i]; G = gram[i + 1]; B = gram[i + 2];
        if (cambiarRB) { var t = R; R = B; B = t; }
        if (r.invertido) { R = 255 - R; G = 255 - G; B = 255 - B; }
      }
      var v = ((R >> 3) << 11) | ((G >> 2) << 5) | (B >> 3);
      bytes[k] = v >> 8; bytes[k + 1] = v & 0xff;
    }
  }
  return { tipo: 'pantalla', formato: 'rgb565', ancho: panel.ancho, alto: panel.alto, encendida: visible, brillo: 1, rgb565: sdk.base64(bytes) };
}

function ensuciar(t) {
  if (publicarEn === null) { publicarEn = t + PUBLICAR_CADA_US; ctx.despertarEn(publicarEn); }
}

module.exports = {
  encender: function (ctx) {
    panel = PANELES[ctx.props.pestana] || PANELES.negra;
    azar = sdk.azar(0x7735);
    gram = new Array(panel.gramCols * panel.gramFilas * 3);
    for (var i = 0; i < gram.length; i++) gram[i] = Math.floor(azar() * 256); // basura al encender
    reset();
    publicarEn = null;
    ctx.publicar(imagen());
  },
  seleccionar: function () { pendientePixel = []; },
  // D/CX: 0 = comando, 1 = dato o parámetro [8.4 Serial interface].
  spi: function (ctx, mosi, dc) {
    for (var i = 0; i < mosi.length; i++) { if (dc[i]) byteDato(mosi[i]); else byteComando(mosi[i]); }
    ensuciar(ctx.t);
    return [];
  },
  // RESX en bajo: reinicio por hardware [10.1.2: mismos valores que SWRESET].
  pin: function (ctx, nombre, nivel) {
    if (nombre === 'RESX' && nivel === 0) { reset(); ensuciar(ctx.t); }
  },
  tick: function (ctx) {
    if (publicarEn !== null && ctx.t >= publicarEn) { publicarEn = null; ctx.publicar(imagen()); }
    else if (publicarEn !== null) ctx.despertarEn(publicarEn);
  },
};
