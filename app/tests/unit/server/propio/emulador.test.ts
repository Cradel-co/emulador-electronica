import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmuladorPropio } from '../../../../server/src/propio/emulador.js';
import type { EmulatorEvents } from '../../../../server/src/emulator.js';
import type { BuildArtifacts } from '../../../../server/src/buildService.js';
const artefactos = (main: string): BuildArtifacts => ({ firmware: 'programa-propio', elf: null, usesApi: false, usesWebServer: false, needsRepl: false, codigoPropio: { main } });
function crear() {
  const eventos: EmulatorEvents = { onLog: vi.fn(), onState: vi.fn(), onBridgeState: vi.fn(), onBridgeMessage: vi.fn() };
  return { eventos, motor: new EmuladorPropio(eventos) };
}
const blink = 'from machine import Pin\nfrom time import sleep_ms\nled = Pin(7, Pin.OUT)\nwhile True:\n    led.value(not led.value())\n    sleep_ms(100)\n';
afterEach(() => { vi.useRealTimers(); });
describe('backend propio sobre la agenda común', () => {
  it('arranca sin PID/puertos, alterna GPIO y cancela el timer al parar', async () => {
    vi.useFakeTimers(); const { motor, eventos } = crear();
    try {
      await motor.start('blink', artefactos(blink), { pinesPropios: [7] });
      const direcciones = motor.direccionesGpio(); if (direcciones?.[0]) direcciones[0].gpio = 99;
      expect(motor.direccionesGpio()?.[0]?.gpio).toBe(7);
      expect(motor.getStatus()).toMatchObject({ state: 'bridge', pid: null, ports: null, running: true });
      expect(eventos.onBridgeMessage).toHaveBeenCalledWith({ type: 'OUT', pin: 7, level: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(eventos.onBridgeMessage).toHaveBeenLastCalledWith({ type: 'OUT', pin: 7, level: 0 });
      await motor.stop(); const n = vi.mocked(eventos.onBridgeMessage).mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000); expect(vi.mocked(eventos.onBridgeMessage).mock.calls).toHaveLength(n);
      expect(vi.getTimerCount()).toBe(0); expect(motor.getStatus().running).toBe(false);
    } finally { await motor.shutdown(); }
  });
  it('reset cancela la generación anterior y reinicia el programa', async () => {
    vi.useFakeTimers(); const { motor, eventos } = crear();
    try {
      await motor.start('blink', artefactos(blink), { pinesPropios: [7] });
      await vi.advanceTimersByTimeAsync(100); await motor.reset();
      expect(eventos.onBridgeMessage).toHaveBeenLastCalledWith({ type: 'OUT', pin: 7, level: 1 });
      expect(vi.getTimerCount()).toBe(1);
    } finally { await motor.stop(); }
  });
  it('una entrada que pierde referencia falla y no conserva su último nivel', async () => {
    vi.useFakeTimers(); const { motor } = crear();
    const main = 'from machine import Pin\nfrom time import sleep_ms\np = Pin(6, Pin.IN, Pin.PULL_UP)\nwhile True:\n    print(p.value())\n    sleep_ms(50)';
    try {
      await motor.start('entrada', artefactos(main), { pinesPropios: [6], entradasPropias: [{ gpio: 6, nivel: 1 }] });
      motor.actualizarEntradaDigital(6, null); await vi.advanceTimersByTimeAsync(50);
      expect(motor.getStatus()).toMatchObject({ state: 'crashed', running: false });
      expect(motor.getStatus().exitInfo).toMatch(/sin nivel.*X/); expect(vi.getTimerCount()).toBe(0);
    } finally { await motor.stop(); }
  });
  it('no acepta GPIO inexistentes, buses ni artefactos de esp-emu', async () => {
    const { motor } = crear();
    try {
      await expect(motor.start('x', artefactos(blink), { pinesPropios: [6] })).rejects.toThrow(/no existe/);
      await expect(motor.start('x', artefactos(blink), { pinesPropios: [7], capacidadesPropias: [{ gpio: 7, entrada: true, salida: false }] })).rejects.toThrow(/modo digital/);
      await expect(motor.start('x', { ...artefactos(blink), codigoPropio: undefined })).rejects.toThrow(/programa validado/);
      await expect(motor.start('x', artefactos(blink), { perfilAnalogicoEsp: {} as never })).rejects.toThrow(/ADC/);
    } finally { await motor.stop(); }
  });
});
describe('barrera eléctrica de escrituras propias', () => {
  it('espera el solver antes de leer una entrada afectada por una salida', async () => {
    const { motor, eventos } = crear(); let nivel: 0 | 1 = 0, liberar: () => void = () => {};
    const puerta = new Promise<void>(resolve => { liberar = resolve; });
    vi.mocked(eventos.onBridgeMessage).mockImplementation(m => { if (m.type === 'OUT') nivel = m.level; });
    const sincronizar = vi.fn(async () => { if (nivel === 1) await puerta; motor.actualizarEntradaDigital(6, nivel); });
    const main = 'from machine import Pin\nentrada = Pin(6, Pin.IN)\nled = Pin(7, Pin.OUT)\nled.on()\nprint(entrada.value())\n';
    const inicio = motor.start('circuito', artefactos(main), { pinesPropios: [6, 7], entradasPropias: [{ gpio: 6, nivel: 0 }], sincronizarEntradasPropias: sincronizar });
    try {
      await vi.waitFor(() => expect(sincronizar).toHaveBeenCalledTimes(2));
      expect(eventos.onLog).not.toHaveBeenCalledWith('1');
      liberar(); await inicio;
      expect(eventos.onLog).toHaveBeenCalledWith('1');
    } finally { liberar(); await inicio.catch(() => {}); await motor.stop(); }
  });
  it('una barrera pendiente no revive el programa después de Parar', async () => {
    const { motor, eventos } = crear(); let liberar: () => void = () => {};
    const puerta = new Promise<void>(resolve => { liberar = resolve; });
    const sincronizar = vi.fn(() => puerta);
    const inicio = motor.start('circuito', artefactos('from machine import Pin\nled = Pin(7, Pin.OUT)\nprint("tarde")\n'), { pinesPropios: [7], sincronizarEntradasPropias: sincronizar });
    try {
      await vi.waitFor(() => expect(sincronizar).toHaveBeenCalledOnce());
      await motor.stop(); liberar(); await inicio;
      expect(eventos.onLog).not.toHaveBeenCalledWith('tarde'); expect(motor.getStatus().running).toBe(false);
    } finally { liberar(); await inicio.catch(() => {}); await motor.stop(); }
  });
});
it('el rechazo tardío de una barrera anterior no derriba una corrida nueva', async () => {
  const { motor } = crear(); let rechazar: (e: Error) => void = () => {};
  const barrera = new Promise<void>((_, reject) => { rechazar = reject; });
  const sincronizar = vi.fn(() => barrera);
  const viejo = motor.start('viejo', artefactos('from machine import Pin\np = Pin(7, Pin.OUT)\n'), { pinesPropios: [7], sincronizarEntradasPropias: sincronizar });
  const falloViejo = viejo.catch(e => e as Error);
  try {
    await vi.waitFor(() => expect(sincronizar).toHaveBeenCalledOnce());
    await motor.start('nuevo', artefactos('print("nuevo")\n'), { pinesPropios: [] });
    rechazar(new Error('Barrera vieja rechazada')); await falloViejo;
    expect(motor.getStatus()).toMatchObject({ project: 'nuevo', state: 'bridge', running: true });
  } finally { rechazar(new Error('limpiar')); await falloViejo; await motor.stop(); }
});
