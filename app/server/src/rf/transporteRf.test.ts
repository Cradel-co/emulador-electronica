import { describe, expect, it, vi } from 'vitest';
import { enviarTramaRf, type TransporteRf } from './transporteRf.js';

function destino() {
  const sendRf = vi.fn();
  const d: TransporteRf = {
    getStatus: () => ({ state: 'bridge' }),
    getBridge: () => ({ sendRf, watch: () => {}, setInput: () => {} }),
    capacidadRf: () => ({ maxBits: 24, protocolos: [1] }),
  };
  return { d, sendRf };
}

describe('capacidad real del transporte RF', () => {
  it.each(['1'.repeat(25), '1'.repeat(64), '', '101x'])('impide enviar la trama inválida %s al búfer RMT', bits => {
    const { d, sendRf } = destino();
    expect(() => enviarTramaRf(d, bits, 1)).toThrow(/trama/i);
    expect(sendRf).not.toHaveBeenCalled();
  });
  it('no transforma otro protocolo en el protocolo 1 que genera RMT', () => {
    const { d, sendRf } = destino();
    expect(() => enviarTramaRf(d, '1010', 2)).toThrow(/protocolo/i);
    expect(sendRf).not.toHaveBeenCalled();
  });
  it.each([null, undefined])('rechaza backend sin capacidad aunque tenga método sendRf (%s)', capacidad => {
    const { d, sendRf } = destino();
    if (capacidad === null) d.capacidadRf = () => null;
    else delete d.capacidadRf;
    expect(() => enviarTramaRf(d, '1010', 1)).toThrow(/soporte RF/);
    expect(sendRf).not.toHaveBeenCalled();
  });
  it('permite exactamente 24 bits y no entrega si el puente desaparece', () => {
    const { d, sendRf } = destino();
    const bits = '1'.repeat(24);
    expect(enviarTramaRf(d, bits, 1)).toBe(true);
    expect(sendRf).toHaveBeenCalledWith(bits, 1);
    d.getBridge = () => null;
    expect(enviarTramaRf(d, bits, 1)).toBe(false);
    expect(sendRf).toHaveBeenCalledTimes(1);
  });
});
