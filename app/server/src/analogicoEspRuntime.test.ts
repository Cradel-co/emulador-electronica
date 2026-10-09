import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { perfilEspPrueba } from './fixtures/analogicoEsp.js';
import type { BuildArtifacts } from './buildService.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), puentes: [] as { emitir: (linea: string) => void; respuestas: string[] }[] }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./ports.js', () => ({ reservePorts: async () => [20001, 20002, 20003, 20004], releasePorts: () => {}, PORTS_PER_INSTANCE: 4 }));
vi.mock('node:net', () => ({ default: { createConnection: () => {
  const socket = Object.assign(new EventEmitter(), { setEncoding: () => {}, setNoDelay: () => {}, destroy: () => {}, end: () => {}, write: () => { queueMicrotask(() => socket.emit('data', 'OK\n')); } });
  queueMicrotask(() => socket.emit('connect')); return socket;
} } }));
vi.mock('./bridgeClient.js', () => ({ BridgeClient: class {
  private readonly oyentes: ((linea: string) => void)[] = [];
  readonly respuestas: string[] = [];
  constructor() { mocks.puentes.push(this); }
  emitir(linea: string): void { this.oyentes.forEach(o => o(linea)); }
  escucharLineas(o: (l: string) => void): void { this.oyentes.push(o); }
  enviarLinea(l: string): void { this.respuestas.push(l); }
  connect(): void {}
  close(): void {}
} }));
import { EmulatorManager } from './emulator.js';
import { AvrEmulator } from './avrEmulator.js';

const artefactos: BuildArtifacts = { firmware: '/dev/null', elf: null, usesApi: false, usesWebServer: false, needsRepl: true };
function preparar() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, exitCode: null as number | null, signalCode: null as string | null,
    kill: () => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0, null)); },
  });
  mocks.spawn.mockReturnValue(child);
  const logs: string[] = [];
  return { emu: new EmulatorManager({ onLog: l => logs.push(l), onState: () => {}, onBridgeMessage: () => {}, onBridgeState: () => {} }), logs };
}
const puenteActual = () => { const p = mocks.puentes.at(-1); if (!p) throw new Error('Falta puente'); return p; };
afterEach(() => { mocks.puentes.length = 0; mocks.spawn.mockReset(); });

describe('ADC MicroPython conectado al ciclo de vida del emulador', () => {
  it('start con snapshot, actualización, reset y reinicio sin perfil; descarta listener anterior', async () => {
    const { emu, logs } = preparar();
    const perfil = perfilEspPrueba(), snapshot = { resuelto: true, vcc: 3.3, canales: { 4: 1.6 } };
    try {
      await emu.start('adc', artefactos, { perfilAnalogicoEsp: perfil, analogicoEsp: snapshot });
      const p = puenteActual(); p.emitir('@ADC 1 4 3'); expect(p.respuestas).toContain('@ADCR 1 2048');
      snapshot.canales[4] = 0;
      const canal = perfil.canales[0]; if (!canal) throw new Error('Falta perfil'); canal.voltajeFondoEscalaV = 10;
      p.emitir('@ADC 2 4 3'); expect(p.respuestas).toContain('@ADCR 2 2048');
      emu.actualizarAnalogicoEsp({ resuelto: true, vcc: 3.3, canales: { 4: 0.8 } });
      await emu.reset(); p.emitir('@ADC 3 4 3'); expect(p.respuestas).toContain('@ADCR 3 1024');
      await emu.stop();
      p.emitir('@ADC 4 4 3'); expect(p.respuestas).not.toContain('@ADCR 4 1024');
      await emu.start('sin-perfil', artefactos);
      const nuevo = puenteActual(); nuevo.emitir('@ADC 5 4 3'); expect(nuevo.respuestas).toContain('@ADCR 5 E:SIN_MODELO');
      p.emitir('@ADC 6 4 3'); expect(nuevo.respuestas.some(l => l.startsWith('@ADCR 6'))).toBe(false);
      expect(logs.join('\n')).toContain('oraculo-sintetico');
    } finally { await emu.stop(); }
  });
  it('rechaza perfiles incompatibles antes de arrancar procesos o tocar la corrida válida', async () => {
    const { emu } = preparar();
    await expect(emu.start('nativo', { ...artefactos, needsRepl: false }, { perfilAnalogicoEsp: perfilEspPrueba() })).rejects.toThrow(/MicroPython/);
    await expect(emu.start('c3', artefactos, { chip: 'esp32c3', perfilAnalogicoEsp: perfilEspPrueba() })).rejects.toThrow(/chip/);
    await expect(emu.start('avr', artefactos, { perfilAnalogicoAvr: { tipo: 'ideal-10bits' } })).rejects.toThrow(/AVR/);
    expect(mocks.spawn).not.toHaveBeenCalled();
    try {
      await emu.start('vigente', artefactos, { perfilAnalogicoEsp: perfilEspPrueba(), analogicoEsp: { resuelto: true, vcc: 3.3, canales: { 4: 1.6 } } });
      await expect(emu.start('incompatible', artefactos, { chip: 'esp32c3', perfilAnalogicoEsp: perfilEspPrueba() })).rejects.toThrow(/chip/);
      expect(emu.getStatus()).toMatchObject({ running: true, project: 'vigente' });
      const p = puenteActual(); p.emitir('@ADC 1 4 3'); expect(p.respuestas).toContain('@ADCR 1 2048');
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
    } finally { await emu.stop(); }
  });
  it('AVR rechaza un perfil ESP antes de cargar firmware o crear worker', async () => {
    const avr = new AvrEmulator({ onLog: () => {}, onState: () => {}, onBridgeMessage: () => {}, onBridgeState: () => {} });
    await expect(avr.start('incompatible', { ...artefactos, firmware: '/no-existe.hex', needsRepl: false }, { perfilAnalogicoEsp: perfilEspPrueba() })).rejects.toThrow(/perfil ADC ESP.*AVR/);
    expect(avr.getStatus().running).toBe(false);
  });
  it('declara RF sólo durante una corrida nativa con RMT loopback y retira capacidad al parar', async () => {
    const { emu } = preparar();
    expect(emu.capacidadRf()).toBeNull();
    try {
      await emu.start('mp', artefactos, { rmtLoopback: ['17:18'] });
      expect(emu.capacidadRf()).toBeNull(); await emu.stop();
      await emu.start('nativo-sin-rmt', { ...artefactos, needsRepl: false });
      expect(emu.capacidadRf()).toBeNull(); await emu.stop();
      await emu.start('nativo-rmt', { ...artefactos, needsRepl: false }, { rmtLoopback: ['17:18'] });
      expect(emu.capacidadRf()).toEqual({ maxBits: 24, protocolos: [1] });
    } finally { await emu.stop(); }
    expect(emu.capacidadRf()).toBeNull();
  });
});
