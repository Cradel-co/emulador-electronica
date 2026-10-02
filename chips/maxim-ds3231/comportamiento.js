// Maxim DS3231: reloj de tiempo real por I2C (0x68). Basado en la hoja de datos (entre corchetes,
// la sección). El reloj corre con el tiempo de la EMULACIÓN, no el de la PC: si el Arduino emulado
// va más lento que el real, el reloj también, como si los dos compartieran el mismo tiempo.

var DIR = 0x68;
var CONV_US = 125000;          // t_CONV típico [características AC]: 125 ms (máx. 200)
var CICLO_TEMP_US = 64e6;      // conversión automática cada 64 s [TCXO]
var BSY_DEMORA_US = 2000;      // una conversión pedida no toca BSY por ~2 ms [CONV]
var MAX_SEG_REVISAR = 2 * 86400;   // si el programa no lee el chip por más de 2 días de emulación, se revisan los últimos 2

// --- Calendario del chip [Clock and Calendar]: años 2000-2199 (bit de siglo), bisiesto si
// el año (00-99) es múltiplo de 4, como lo cuenta el DS3231. ------------------------------
var DIAS_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function bisiesto(anio) { return (anio % 100) % 4 === 0; }
function diasDelMes(anio, mes) { return mes === 2 && bisiesto(anio) ? 29 : DIAS_MES[mes - 1]; }
function campos(seg) {
  var x = Math.floor(seg), dias = Math.floor(x / 86400), resto = x - dias * 86400;
  // Ciclos de 4 años (1461 días; el primero de cada ciclo es bisiesto): sin recorrer año por año.
  var ciclo = Math.floor(dias / 1461), r = dias - ciclo * 1461;
  var enCiclo = r < 366 ? 0 : 1 + Math.floor((r - 366) / 365);
  dias = enCiclo === 0 ? r : r - 366 - (enCiclo - 1) * 365;
  var anio = (ciclo * 4 + enCiclo) % 200, mes = 1;
  for (;;) { var dm = diasDelMes(anio, mes); if (dias < dm) break; dias -= dm; mes++; }
  return { anio: anio, mes: mes, fecha: dias + 1, hora: Math.floor(resto / 3600), min: Math.floor(resto / 60) % 60, seg: resto % 60 };
}
/** El segundo siguiente, con acarreo (más barato que recalcular la fecha). */
function siguiente(c) {
  if (++c.seg < 60) return false;
  c.seg = 0; if (++c.min < 60) return false;
  c.min = 0; if (++c.hora < 24) return false;
  c.hora = 0;
  if (++c.fecha > diasDelMes(c.anio, c.mes)) { c.fecha = 1; if (++c.mes > 12) { c.mes = 1; c.anio = (c.anio + 1) % 200; } }
  return true; // pasó la medianoche
}
function segundosDe(c) {
  var dias = 0;
  for (var a = 0; a < c.anio; a++) dias += bisiesto(a) ? 366 : 365;
  for (var m = 1; m < c.mes; m++) dias += diasDelMes(c.anio, m);
  dias += c.fecha - 1;
  return dias * 86400 + c.hora * 3600 + c.min * 60 + c.seg;
}

// --- Estado ------------------------------------------------------------------------------
var s;
function ppm() { return (Number(ctx.props.errorPpm) || 0) - 0.1 * sdk.conSigno(s.aging, 8); } // +aging = más lento [Aging]
function factor() { return 1 + ppm() * 1e-6; }
/** Segundos del calendario (con decimales) en el instante t. */
function segEn(t) { return s.s0 + ((t - s.t0) / 1e6) * factor(); }
/** Instante (µs) en que el calendario llega a `seg`. */
function tDe(seg) { return s.t0 + ((seg - s.s0) / factor()) * 1e6; }
/** Fija el calendario en `seg` a partir de t (cambia la base: hora escrita, aging). */
function rebase(t, seg) { s.t0 = t; s.s0 = seg; }
function diaSemana(seg) { return ((s.dow0 - 1 + Math.floor(seg / 86400) - s.dia0) % 7 + 7) % 7 + 1; }

function inicial(t) {
  // Sin pila (o 'sin-pila'): cada encendido es el primero (OSF = 1, hora en cero).
  var en = ctx.props.estado !== 'sin-pila' && ctx.props.pila !== 'ninguna';
  var c = { anio: 0, mes: 1, fecha: 1, hora: 0, min: 0, seg: 0 }, dow = 1;
  if (en) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/.exec(String(ctx.props.inicio || ''));
    var d = m ? null : new Date();
    c = m ? { anio: +m[1] - 2000, mes: +m[2], fecha: +m[3], hora: +m[4], min: +m[5], seg: +m[6] }
          : { anio: d.getFullYear() - 2000, mes: d.getMonth() + 1, fecha: d.getDate(), hora: d.getHours(), min: d.getMinutes(), seg: d.getSeconds() };
    // Día de la semana como RTClib (lunes = 1 ... domingo = 7): sale de la fecha real.
    var js = new Date(Date.UTC(c.anio + 2000, c.mes - 1, c.fecha)).getUTCDay();
    dow = js === 0 ? 7 : js;
  }
  var seg0 = segundosDe(c);
  s = {
    t0: t, s0: seg0, dow0: dow, dia0: Math.floor(seg0 / 86400), doce: false,
    alarmas: [0, 0, 0, 0, 0, 0, 0],      // 07h..0Dh, tal cual se escribieron
    control: 0x1c,                        // EOSC=0 BBSQW=0 CONV=0 RS2=RS1=1 INTCN=1 A2IE=A1IE=0 [Control]
    osf: en ? 0 : 1, en32: 1, a1f: 0, a2f: 0,
    aging: 0,
    temp: 0,                              // 0 °C hasta la primera conversión [Temperature Registers]
    encendido: t,                         // conversiones automáticas cada 64 s desde acá
    convManual: null,                     // { desde, hasta }
    convHechas: 0,                        // conversiones automáticas ya guardadas
    revisadoHasta: Math.floor(seg0),      // último segundo evaluado para las alarmas
    puntero: 0,
    avisadoSqw: false,
  };
  // Con pila, el chip siguió andando mientras la placa estuvo apagada: retoma la hora y los
  // registros que guardó, más el tiempo real que pasó (a su frecuencia), y las alarmas que
  // vencieron en ese lapso prenden sus flags [Power Control: con VBAT el oscilador sigue].
  var g = ctx.guardado;
  if (en && !ctx.props.inicio && g && typeof g.seg === 'number' && typeof g.pcMs === 'number') {
    s.aging = g.aging | 0; s.alarmas = g.alarmas || s.alarmas; s.control = (g.control | 0) & ~0x20;
    s.doce = !!g.doce; s.osf = g.osf | 0; s.en32 = g.en32 === undefined ? 1 : g.en32 | 0;
    s.a1f = g.a1f | 0; s.a2f = g.a2f | 0;
    var apagado = Math.max(0, (Date.now() - g.pcMs) / 1000) * factor();
    var ahora = g.seg + apagado;
    s.s0 = ahora; s.dia0 = Math.floor(g.seg / 86400); s.dow0 = g.dow || 1;
    var d0 = Math.floor(ahora / 86400);
    s.dow0 = ((s.dow0 - 1 + d0 - s.dia0) % 7 + 7) % 7 + 1; s.dia0 = d0;
    s.revisadoHasta = Math.floor(g.seg);
  }
}

/** Guarda lo que conserva la pila: la hora (con el reloj de la PC, para sumar lo que esté apagado) y los registros. */
function guardar(t) {
  if (ctx.props.pila === 'ninguna' || ctx.props.estado === 'sin-pila') return;
  var seg = segEn(t);
  ctx.guardar({ seg: seg, pcMs: Date.now(), dow: diaSemana(seg), doce: s.doce, alarmas: s.alarmas.slice(),
    control: s.control, osf: s.osf, en32: s.en32, a1f: s.a1f, a2f: s.a2f, aging: s.aging });
}

// --- Temperatura -------------------------------------------------------------------------
function convertirTemperatura() {
  var q = Math.round(sdk.limitar(ctx.entorno.temperatura, -128, 127.75) * 4); // 10 bits, 0,25 °C
  s.temp = q;
}
function ocupadoConvirtiendo(t) {
  var k = Math.floor((t - s.encendido) / CICLO_TEMP_US);
  var enAuto = t - (s.encendido + k * CICLO_TEMP_US) < CONV_US;
  var enManual = s.convManual && t >= s.convManual.desde + BSY_DEMORA_US && t < s.convManual.hasta;
  return enAuto || enManual;
}
function avanzarTemperatura(t) {
  // Conversiones automáticas que terminaron hasta t (la primera, al encender).
  var hechas = Math.floor((t - s.encendido - CONV_US) / CICLO_TEMP_US) + 1;
  if (hechas > s.convHechas) { convertirTemperatura(); s.convHechas = hechas; }
  if (s.convManual && t >= s.convManual.hasta) { convertirTemperatura(); s.convManual = null; }
}

// --- Alarmas [Alarms] --------------------------------------------------------------------
function horaDeRegistro(v) {
  if (v & 0x40) { var h = sdk.deBcd(v & 0x1f) % 12; return (v & 0x20) ? h + 12 : h; } // 12 h con AM/PM
  return sdk.deBcd(v & 0x3f);
}
function coincide(c, dow) {
  var a = s.alarmas;
  function diaOk(r) { return (r & 0x40) ? (r & 0x0f) === dow : sdk.deBcd(r & 0x3f) === c.fecha; }
  var a1 = ((a[0] & 0x80) || sdk.deBcd(a[0] & 0x7f) === c.seg)
        && ((a[1] & 0x80) || sdk.deBcd(a[1] & 0x7f) === c.min)
        && ((a[2] & 0x80) || horaDeRegistro(a[2]) === c.hora)
        && ((a[3] & 0x80) || diaOk(a[3]));
  // La alarma 2 no tiene segundos: dispara en el segundo 00.
  var a2 = c.seg === 0
        && ((a[4] & 0x80) || sdk.deBcd(a[4] & 0x7f) === c.min)
        && ((a[5] & 0x80) || horaDeRegistro(a[5]) === c.hora)
        && ((a[6] & 0x80) || diaOk(a[6]));
  return { a1: a1, a2: a2 };
}
function revisarAlarmas(t) {
  var hasta = Math.floor(segEn(t));
  var desde = Math.max(s.revisadoHasta + 1, hasta - MAX_SEG_REVISAR);
  s.revisadoHasta = Math.max(s.revisadoHasta, hasta);
  if (desde > hasta) return;
  // La comparación se hace en la actualización de cada segundo [Alarms]: los flags se prenden
  // siempre, estén o no habilitadas las interrupciones. Para no recorrer segundo a segundo
  // (un hueco largo sin leer el chip), se miran solo los segundos candidatos según las máscaras.
  var a = s.alarmas;
  if (!s.a1f) {
    var m1 = a[0] & 0x80, m2 = a[1] & 0x80, m3 = a[2] & 0x80, m4 = a[3] & 0x80;
    if (m1 && m2 && m3 && m4) s.a1f = 1; // una vez por segundo
    else {
      var p1 = m1 ? 1 : m2 ? 60 : m3 ? 3600 : 86400;
      var fase1 = (m1 ? 0 : sdk.deBcd(a[0] & 0x7f)) + (m2 || m1 ? 0 : sdk.deBcd(a[1] & 0x7f) * 60) + (m3 || m2 || m1 ? 0 : horaDeRegistro(a[2]) * 3600);
      if (barrer(desde, hasta, p1, fase1, function (c, dow) { return coincide(c, dow).a1; })) s.a1f = 1;
    }
  }
  if (!s.a2f) {
    var n2 = a[4] & 0x80, n3 = a[5] & 0x80;
    var p2 = n2 ? 60 : n3 ? 3600 : 86400;
    var fase2 = (n2 ? 0 : sdk.deBcd(a[4] & 0x7f) * 60) + (n3 || n2 ? 0 : horaDeRegistro(a[5]) * 3600);
    if (barrer(desde, hasta, p2, fase2, function (c, dow) { return coincide(c, dow).a2; })) s.a2f = 1;
  }
}
/** ¿Algún segundo de [desde, hasta] con seg ≡ fase (mod paso) cumple? */
function barrer(desde, hasta, paso, fase, cumple) {
  var primero = desde + ((((fase - desde) % paso) + paso) % paso);
  for (var seg = primero; seg <= hasta; seg += paso) if (cumple(campos(seg), diaSemana(seg))) return true;
  return false;
}

// --- Pin INT/SQW (colector abierto) y despertador -----------------------------------------
function actualizarPin(t) {
  var intcn = s.control & 0x04;
  if (intcn) {
    var activa = (s.a1f && (s.control & 1)) || (s.a2f && (s.control & 2));
    ctx.pin('INT/SQW', activa ? 0 : null);
  } else if ((s.control & 0x18) === 0) {
    // 1 Hz: en bajo la primera mitad de cada segundo, suelto (alto por el pull-up) la segunda.
    var frac = segEn(t) % 1;
    ctx.pin('INT/SQW', frac < 0.5 ? 0 : null);
  } else {
    if (!s.avisadoSqw) { s.avisadoSqw = true; ctx.log('INT/SQW: onda cuadrada de más de 1 Hz no emulada; el pin queda suelto.'); }
    ctx.pin('INT/SQW', null);
  }
}
function programar(t) {
  var intcn = s.control & 0x04, seg = segEn(t);
  if (!intcn && (s.control & 0x18) === 0) { ctx.despertarEn(tDe(Math.floor(seg * 2) / 2 + 0.5) + 1); return; }
  var pendiente = ((s.control & 1) && !s.a1f) || ((s.control & 2) && !s.a2f);
  if (intcn && pendiente) ctx.despertarEn(tDe(Math.floor(seg) + 1) + 1);
}

function avanzar(t) {
  avanzarTemperatura(t);
  revisarAlarmas(t);
  actualizarPin(t);
  programar(t);
}

// --- Registros [Figure 1] ----------------------------------------------------------------
function leerRegistro(r, c) {
  switch (r) {
    case 0x00: return sdk.aBcd(c.seg);
    case 0x01: return sdk.aBcd(c.min);
    case 0x02:
      if (s.doce) { var h12 = c.hora % 12 === 0 ? 12 : c.hora % 12; return 0x40 | (c.hora >= 12 ? 0x20 : 0) | sdk.aBcd(h12); }
      return sdk.aBcd(c.hora);
    case 0x03: return c.dow;
    case 0x04: return sdk.aBcd(c.fecha);
    case 0x05: return (c.anio >= 100 ? 0x80 : 0) | sdk.aBcd(c.mes);
    case 0x06: return sdk.aBcd(c.anio % 100);
    case 0x0e: return s.control;
    case 0x0f: return (s.osf << 7) | (s.en32 << 3) | (c.bsy ? 4 : 0) | (s.a2f << 1) | s.a1f;
    case 0x10: return s.aging;
    case 0x11: return (s.temp >> 2) & 0xff;
    case 0x12: return (s.temp & 3) << 6;
    default: return s.alarmas[r - 0x07];
  }
}

function escribirRegistro(r, v, t) {
  if (r <= 0x06) {
    var seg = segEn(t), c = campos(seg), frac = seg - Math.floor(seg), dow = diaSemana(seg);
    if (r === 0x00) { c.seg = Math.min(59, sdk.deBcd(v & 0x7f)); frac = 0; } // reinicia la cuenta [Clock and Calendar]
    else if (r === 0x01) c.min = Math.min(59, sdk.deBcd(v & 0x7f));
    else if (r === 0x02) { s.doce = (v & 0x40) !== 0; c.hora = Math.min(23, horaDeRegistro(v)); }
    else if (r === 0x03) dow = (v & 7) || 1;
    else if (r === 0x04) c.fecha = Math.max(1, Math.min(31, sdk.deBcd(v & 0x3f)));
    else if (r === 0x05) { c.mes = Math.max(1, Math.min(12, sdk.deBcd(v & 0x1f))); c.anio = (v & 0x80 ? 100 : 0) + (c.anio % 100); }
    else if (r === 0x06) c.anio = (c.anio >= 100 ? 100 : 0) + Math.min(99, sdk.deBcd(v));
    c.fecha = Math.min(c.fecha, diasDelMes(c.anio, c.mes));
    var nuevo = segundosDe(c) + frac;
    rebase(t, nuevo);
    s.dia0 = Math.floor(nuevo / 86400); s.dow0 = dow;
    s.revisadoHasta = Math.floor(nuevo);
    return;
  }
  if (r <= 0x0d) { s.alarmas[r - 0x07] = v; return; }
  if (r === 0x0e) {
    var conv = v & 0x20;
    // CONV no se puede poner mientras BSY = 1 [Control, bit 5].
    if (conv && !ocupadoConvirtiendo(t) && !s.convManual) s.convManual = { desde: t, hasta: t + CONV_US };
    s.control = (v & ~0x20) | (s.convManual ? 0x20 : 0);
    return;
  }
  if (r === 0x0f) {
    if (!(v & 0x80)) s.osf = 0;           // OSF solo se borra [Status, bit 7]
    s.en32 = (v >> 3) & 1;
    if (!(v & 2)) s.a2f = 0;              // A1F/A2F: solo se pueden escribir en 0
    if (!(v & 1)) s.a1f = 0;
    return;
  }
  if (r === 0x10) { var seg2 = segEn(t); s.aging = v; rebase(t, seg2); return; } // el aging cambia la frecuencia desde acá
  // 11h y 12h (temperatura): solo lectura.
}

module.exports = {
  encender: function (ctx) { inicial(ctx.t); avanzar(ctx.t); },
  direcciones: [DIR],
  // Escritura: el primer byte es el puntero; los datos siguen con autoincremento (vuelve a 00h después de 12h).
  escribir: function (ctx, bytes) {
    avanzar(ctx.t);
    if (bytes.length === 0) return;
    s.puntero = bytes[0] > 0x12 ? 0 : bytes[0];
    for (var i = 1; i < bytes.length; i++) {
      escribirRegistro(s.puntero, bytes[i], ctx.t);
      s.puntero = s.puntero >= 0x12 ? 0 : s.puntero + 1;
    }
    if (s.control & 0x20 && !s.convManual) s.control &= ~0x20;
    avanzar(ctx.t);
    // Solo el puntero (lo que antecede a cada lectura) no cambia nada que conserve la pila: no se guarda.
    if (bytes.length > 1) guardar(ctx.t);
  },
  // Lectura: la hora se copia a un búfer en cada START [Address Map], así que una ráfaga es una foto.
  leer: function (ctx, n) {
    avanzar(ctx.t);
    var seg = segEn(ctx.t), c = campos(seg);
    c.dow = diaSemana(seg);
    c.bsy = ocupadoConvirtiendo(ctx.t);
    if (s.convManual === null) s.control &= ~0x20; // CONV vuelve a 0 al terminar la conversión
    var out = [], p = s.puntero;
    for (var i = 0; i < n; i++) { out.push(leerRegistro(p, c)); p = p >= 0x12 ? 0 : p + 1; }
    return out;
  },
  leidos: function (ctx, n) { for (var i = 0; i < n; i++) s.puntero = s.puntero >= 0x12 ? 0 : s.puntero + 1; },
  tick: function (ctx) { avanzar(ctx.t); },
  apagar: function (ctx) { avanzar(ctx.t); guardar(ctx.t); },
};
