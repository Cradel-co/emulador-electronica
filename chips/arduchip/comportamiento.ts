export {};
// ArduChip: registros publicados por ArduCAM, revisión 066a7ea.
interface Contexto { publicar(o: Record<string, unknown>): void; log(m: string): void }
type Entrada = { tipo: 'configuracion'; soportada: boolean } | { tipo: 'imagen'; token: number; bytes: number[] } | { tipo: 'fallo'; token: number; mensaje: string };
declare const module: { exports: unknown };
let configurada = false, pendiente = false, terminada = false;
let token = 0, comando = -1, posicion = 0;
let fifo: number[] = [], registros = new Uint8Array(128);
function cancelar(c: Contexto) { const habia = pendiente; pendiente = false; token++; c.publicar({ cameraAction: 'cancel', ...(habia ? { cameraError: 'La captura fue cancelada por el circuito.' } : {}) }); }
function reset(c: Contexto) { cancelar(c); fifo = []; posicion = 0; terminada = false; comando = -1; registros = new Uint8Array(128); configurada = false; }
function leer(reg: number) {
  if (reg === 0x41) return terminada ? 8 : 0;
  if (reg >= 0x42 && reg <= 0x44) return (fifo.length >> ((reg - 0x42) * 8)) & 255;
  if (reg === 0x3d || reg === 0x3c) return fifo[posicion++] ?? 0;
  return registros[reg] ?? 0;
}
function escribir(c: Contexto, reg: number, v: number) {
  registros[reg] = v;
  if (reg === 6 && (v & 1)) { reset(c); return; }
  if (reg === 6 && (v & 6)) { cancelar(c); terminada = false; return; }
  if (reg !== 4) return;
  if (v & 0x21) { cancelar(c); fifo = []; posicion = 0; terminada = false; }
  if (v & 0x10) posicion = 0;
  if (v & 2) {
    if (pendiente) { c.log('ArduCAM: ya hay una captura pendiente.'); return; }
    terminada = false;
    if ((registros[6] ?? 0) & 6) { c.log('ArduCAM: controlador en standby o power-down.'); return; }
    if (!configurada) { const mensaje = 'Configurá el sensor para JPEG 320 × 240 antes de capturar.'; c.log('ArduCAM: ' + mensaje); c.publicar({ cameraError: mensaje }); return; }
    pendiente = true; token++;
    c.publicar({ cameraAction: 'capture', token });
  }
}
module.exports = {
  encender: reset, apagar: reset,
  seleccionar() { comando = -1; },
  externo(c: Contexto, e: Entrada) {
    if (e.tipo === 'configuracion') { configurada = e.soportada; if (!configurada && pendiente) cancelar(c); return; }
    if (!pendiente || e.token !== token) return;
    pendiente = false;
    if (e.tipo === 'fallo') { c.log(`ArduCAM: ${e.mensaje}`); c.publicar({ cameraError: e.mensaje }); return; }
    fifo = e.bytes.slice(); posicion = 0; terminada = true;
    c.publicar({ cameraLength: fifo.length });
  },
  spi(c: Contexto, mosi: number[]) {
    return mosi.map(b => {
      if (comando < 0) { comando = b; return 0; }
      if (comando & 0x80) { escribir(c, comando & 0x7f, b); return 0; }
      return leer(comando);
    });
  },
};
