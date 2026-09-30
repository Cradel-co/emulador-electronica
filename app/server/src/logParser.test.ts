import { describe, expect, it } from 'vitest';
import net from 'node:net';
import {
  detectState,
  extractIp,
  HangWatchdog,
  isCrashLine,
  LineSplitter,
  parseLogLine,
  stripAnsi,
} from './logParser.js';
import { isPortFree, reservePorts } from './ports.js';

describe('stripAnsi', () => {
  it('quita los colores que manda ESPHome', () => {
    expect(stripAnsi('\x1b[0;32m[D]\x1b[0m [sim_bridge:12]: hola')).toBe('[D] [sim_bridge:12]: hola');
  });
});

describe('detectState', () => {
  it('detecta booted con la línea real de ESPHome', () => {
    const line = '[00:00:00]: [I][app:029]: setup() finished successfully!';
    expect(detectState(line, 'starting')).toBe('booted');
  });

  it('detecta wifi con la línea real de ESPHome', () => {
    expect(detectState('[00:00:05]: [I][wifi:294]: Connected network: TU_WIFI', 'booted')).toBe('wifi');
    expect(detectState('[00:00:06]: [I][wifi:294]: IPAddress: 192.168.4.2, mask: 255.255.255.0', 'booted')).toBe('wifi');
  });

  it('detecta booted de ESP-IDF y de MicroPython', () => {
    expect(detectState('I (5321) app_main: chip revision: v0.2', 'starting')).toBe('booted');
    expect(detectState('Calling app_main()', 'starting')).toBe('booted');
    expect(detectState('MicroPython v1.29.0; ESP32-S3', 'starting')).toBe('booted');
    expect(detectState('>>> ', 'starting')).toBe('booted');
  });

  it('detecta crashed con los patrones de panico y de abort', () => {
    expect(detectState("Guru Meditation Error: Core  0 panic'ed (Interrupt watch timeout)", 'booted')).toBe('crashed');
    expect(detectState('abort() was called', 'wifi')).toBe('crashed');
    expect(detectState('Backtrace: 0x400d1a3c:0x3ffb1e30 0x400d1a58:0x3ffb1e30', 'wifi')).toBe('crashed');
  });

  it('no confunde las lineas de aviso de backtrace con un crash', () => {
    expect(isCrashLine('Backtrace will be printed with the following format when an exception is generated')).toBe(false);
    expect(isCrashLine('ELF file SHA256: 1234')).toBe(false);
  });

  it('devuelve null si la línea no cambia el estado', () => {
    expect(detectState('[I][app:029]: MQTT connected', 'wifi')).toBeNull();
  });

  it('funciona con líneas que traen ANSI', () => {
    expect(detectState('\x1b[0;36m[I][app:029]: setup() finished successfully!\x1b[0m', 'starting')).toBe('booted');
  });
});

describe('extractIp', () => {
  it('saca la IP de la línea de wifi', () => {
    expect(extractIp('[I][wifi:000]: IPAddress: 192.168.4.2, mask: 255.255.255.0')).toBe('192.168.4.2');
    expect(extractIp('nada aqui')).toBeNull();
  });
});

describe('parseLogLine', () => {
  it('parsea el formato de ESPHome y el de IDF', () => {
    expect(parseLogLine('[W][sim_bridge:241]: GPIO6 no responde')).toEqual({
      line: 'GPIO6 no responde',
      level: 'W',
      tag: 'sim_bridge',
    });
    expect(parseLogLine('I (5321) app_main: hola')).toEqual({ line: 'hola', level: 'I', tag: 'app_main' });
  });

  it('devuelve la línea tal cual si no tiene formato de log', () => {
    expect(parseLogLine('texto suelto')).toEqual({ line: 'texto suelto', level: null, tag: null });
  });
});

describe('LineSplitter', () => {
  it('trocea renglones partidos entre chunks', () => {
    const s = new LineSplitter();
    expect(s.push('primer\nseg')).toEqual(['primer']);
    expect(s.push('undo\n')).toEqual(['segundo']);
  });

  it('quita el CR y vacía al final', () => {
    const s = new LineSplitter();
    expect(s.push('con cr\r\n')).toEqual(['con cr']);
    expect(s.push('resto')).toEqual([]);
    expect(s.flush()).toEqual(['resto']);
    expect(s.flush()).toEqual([]);
  });
});

describe('HangWatchdog', () => {
  it('cuelga solo si lleva rato sin líneas y sigue en starting', () => {
    const w = new HangWatchdog(10);
    w.feed('algo');
    expect(w.shouldHang('starting')).toBe(false);
    const w2 = new HangWatchdog(-1);
    expect(w2.shouldHang('starting')).toBe(true);
    expect(w2.shouldHang('booted')).toBe(false);
  });
});
describe('reservePorts', () => {
  it('devuelve N puertos distintos y libres', async () => {
    const ports = await reservePorts(4);
    expect(ports).toHaveLength(4);
    expect(new Set(ports).size).toBe(4);
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(20000);
      expect(await isPortFree(p)).toBe(true);
    }
  });

  it('saltea un puerto que ya está ocupado', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(20500, '127.0.0.1', () => r()));
    try {
      const ports = await reservePorts(2, 20499);
      expect(ports).not.toContain(20500);
      expect(ports).toHaveLength(2);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
