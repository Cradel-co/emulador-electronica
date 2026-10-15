export {};
// OV2640: bancos y configuración JPEG QVGA, según ArduCAM revisión 066a7ea.
interface Contexto { publicar(o: Record<string, unknown>): void; log(m: string): void }
declare const module: { exports: unknown };
let banco = 1, puntero = 0;
let registros = [new Uint8Array(256), new Uint8Array(256)];
function reset(c: Contexto) {
  registros = [new Uint8Array(256), new Uint8Array(256)]; banco = 1; puntero = 0;
  c.publicar({ cameraConfig: false });
}
function soportada() {
  const r = registros[0];
  return !!r && (r[0xda] ?? 0) === 0x10 && r[0x5a] === 0x50 && r[0x5b] === 0x3c && r[0x5c] === 0 && r[0xe0] === 0;
}
module.exports = {
  direcciones: [0x30], encender: reset, apagar: reset,
  escribir(c: Contexto, bytes: number[]) {
    puntero = bytes[0] ?? 0;
    for (const v of bytes.slice(1)) {
      const p = puntero++ & 255;
      if (p === 0xff) { banco = v & 1; continue; }
      if (banco === 1 && p === 0x12 && (v & 0x80)) { reset(c); continue; }
      const r = registros[banco]; if (r) r[p] = v;
      c.publicar({ cameraConfig: soportada() });
      if (banco === 0 && p === 0xe0 && v === 0 && !soportada()) c.log('ArduCAM: configuración fuera del alcance; se admite JPEG 320 × 240.');
    }
  },
  leidos(_c: Contexto, n: number) { puntero = (puntero + n) & 255; },
  leer(_c: Contexto, n: number) {
    const inicio = puntero;
    return Array.from({ length: n }, (_, indice) => {
      const p = (inicio + indice) & 255;
      if (p === 0xff) return banco;
      if (banco === 1) {
        const ids: Record<number, number> = { 10: 0x26, 11: 0x42, 28: 0x7f, 29: 0xa2 };
        if (ids[p] !== undefined) return ids[p];
      }
      return registros[banco]?.[p] ?? 0;
    });
  },
};
