import { describe, expect, it } from 'vitest';
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeLineParser,
  encodeAppMessage,
  parseFirmwareLine,
} from './protocol.js';

describe('parseFirmwareLine', () => {
  it('parsea @READY con y sin versión de ESPHome', () => {
    expect(parseFirmwareLine(`@READY ${BRIDGE_PROTOCOL_VERSION} 2026.9.0`)).toEqual({
      type: 'READY',
      version: 1,
      esphomeVersion: '2026.9.0',
    });
    expect(parseFirmwareLine('@READY 1')).toEqual({ type: 'READY', version: 1, esphomeVersion: undefined });
  });

  it('parsea @OUT, @TX, @PONG y @ERR', () => {
    expect(parseFirmwareLine('@OUT 7 1')).toEqual({ type: 'OUT', pin: 7, level: 1 });
    expect(parseFirmwareLine('@TX 101100111000101001011010 1')).toEqual({
      type: 'TX',
      bits: '101100111000101001011010',
      protocol: 1,
    });
    expect(parseFirmwareLine('@PONG 42')).toEqual({ type: 'PONG', n: 42 });
    expect(parseFirmwareLine('@ERR 9 pin invalido')).toEqual({ type: 'ERR', code: '9', message: 'pin invalido' });
  });

  it('acepta niveles "0" y "1" y rechaza otros', () => {
    expect(parseFirmwareLine('@OUT 7 0')).toEqual({ type: 'OUT', pin: 7, level: 0 });
    expect(parseFirmwareLine('@OUT 7 2')).toBeNull();
  });

  it('ignora líneas que no son del protocolo o están mal formadas', () => {
    expect(parseFirmwareLine('log del firmware')).toBeNull();
    expect(parseFirmwareLine('@OUT')).toBeNull();
    expect(parseFirmwareLine('@OUT 99 1')).toBeNull();
    expect(parseFirmwareLine('@TX 12ab 1')).toBeNull();
    expect(parseFirmwareLine('')).toBeNull();
  });

  it('tolera CR', () => {
    expect(parseFirmwareLine('@OUT 7 1\r')).toEqual({ type: 'OUT', pin: 7, level: 1 });
  });
});

describe('BridgeLineParser', () => {
  it('rearma líneas partidas entre varios paquetes TCP', () => {
    const p = new BridgeLineParser();
    expect(p.push('@OU')).toEqual([]);
    expect(p.push('T 7 ')).toEqual([]);
    expect(p.push('1\n@PONG')).toEqual([{ type: 'OUT', pin: 7, level: 1 }]);
    expect(p.push(' 3\n')).toEqual([{ type: 'PONG', n: 3 }]);
  });

  it('devuelve varios mensajes de un solo chunk y descarta basura', () => {
    const p = new BridgeLineParser();
    const msgs = p.push('basura\n@READY 1\n@OUT 4 1\n@OUT 4 0\n');
    expect(msgs).toEqual([
      { type: 'READY', version: 1, esphomeVersion: undefined },
      { type: 'OUT', pin: 4, level: 1 },
      { type: 'OUT', pin: 4, level: 0 },
    ]);
  });

  it('acepta Buffer y Uint8Array', () => {
    const p = new BridgeLineParser();
    expect(p.push(Buffer.from('@OUT 7 1\n'))).toEqual([{ type: 'OUT', pin: 7, level: 1 }]);
    expect(p.push(new TextEncoder().encode('@OUT 8 0\n'))).toEqual([{ type: 'OUT', pin: 8, level: 0 }]);
  });

  it('no crece sin límite si nunca llega un salto de línea', () => {
    const p = new BridgeLineParser();
    for (let i = 0; i < 1000; i++) p.push('X'.repeat(64));
    const out = p.push('@OUT 7 1\n');
    expect(out).toEqual([{ type: 'OUT', pin: 7, level: 1 }]);
  });

  it('reset() descarta el buffer parcial', () => {
    const p = new BridgeLineParser();
    p.push('@OUT 7');
    p.reset();
    expect(p.push(' 1\n')).toEqual([]);
  });
});

describe('encodeAppMessage', () => {
  it('genera las líneas del protocolo 7.1', () => {
    expect(encodeAppMessage({ type: 'HELLO', version: 1 })).toBe('@HELLO 1\n');
    expect(encodeAppMessage({ type: 'WATCH', pin: 7 })).toBe('@WATCH 7\n');
    expect(encodeAppMessage({ type: 'IN', pin: 6, level: 0 })).toBe('@IN 6 0\n');
    expect(encodeAppMessage({ type: 'RF', bits: '1010', protocol: 1 })).toBe('@RF 1010 1\n');
    expect(encodeAppMessage({ type: 'PING', n: 1 })).toBe('@PING 1\n');
  });
});
