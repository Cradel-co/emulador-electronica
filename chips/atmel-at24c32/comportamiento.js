// Atmel AT24C32: EEPROM I2C de 4096 bytes. Según la hoja AT24C32/64:
//  - escritura: 2 bytes de dirección (se usan 12 bits) y hasta 32 datos; si se pasa del final de
//    la página de 32 bytes, vuelve al principio de la MISMA página (pisa lo primero);
//  - después del STOP de una escritura arranca el ciclo interno de grabado (t_WR): mientras dura,
//    el chip no contesta a su dirección (NACK) — el "acknowledge polling" que usan las librerías;
//  - lectura: desde la dirección actual (la última + 1), autoincrementando; al llegar al final
//    de la memoria vuelve a 0.
var TAM = 4096, PAGINA = 32;
var mem, actual = 0;

function direccion(ctx) {
  var d = String(ctx.props.direccion || '0x50');
  var n = parseInt(d, 16);
  return n >= 0x50 && n <= 0x57 ? n : 0x50;
}

function guardar(ctx) {
  var hex = '';
  for (var i = 0; i < TAM; i++) hex += (mem[i] < 16 ? '0' : '') + mem[i].toString(16);
  ctx.guardar({ hex: hex });
}

module.exports = {
  encender: function (ctx) {
    mem = [];
    // Es memoria no volátil: lo grabado en otra ejecución sigue ahí. De fábrica, borrada (FFh).
    var g = ctx.guardado && typeof ctx.guardado.hex === 'string' && ctx.guardado.hex.length === TAM * 2 ? ctx.guardado.hex : null;
    for (var i = 0; i < TAM; i++) mem.push(g ? parseInt(g.substr(i * 2, 2), 16) : 0xff);
    actual = 0;
  },
  direcciones: function (ctx) { return [direccion(ctx)]; },
  escribir: function (ctx, bytes) {
    if (bytes.length === 0) return;            // solo la dirección: sondeo
    if (bytes.length === 1) { actual = (bytes[0] << 8) & 0xfff; return; } // medio puntero: no alcanza
    var dir = ((bytes[0] << 8) | bytes[1]) & 0xfff;
    actual = dir;
    if (bytes.length === 2) return;            // "dummy write" de una lectura aleatoria: solo mueve el puntero
    var base = dir & ~(PAGINA - 1), off = dir & (PAGINA - 1);
    for (var i = 2; i < bytes.length; i++) {
      mem[base + off] = bytes[i];
      off = (off + 1) & (PAGINA - 1);          // vuelta dentro de la página
    }
    actual = base + off;
    guardar(ctx);
    var twr = Number(ctx.props.tWrMs);
    ctx.ocupadoHasta(ctx.t + (twr > 0 ? twr : 5) * 1000); // grabando: no contesta
  },
  leer: function (ctx, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(mem[(actual + i) % TAM]);
    return out;
  },
  leidos: function (ctx, n) { actual = (actual + n) % TAM; },
};
