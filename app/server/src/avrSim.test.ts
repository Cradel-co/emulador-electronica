import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FirmwareMessage } from '@emu/shared';
import { AvrSimulador, parsearIntelHex } from './avrSim.js';
import { AvrEmulator } from './avrEmulator.js';
import type { EmulatorStatus } from './emulator.js';

/**
 * Firmware real: fixtures/uno-boton-led.cpp compilado con arduino-cli para
 * arduino:avr:uno (imagen docker/arduino-avr). Botón en D2 con INPUT_PULLUP → LED en D13,
 * y por el Serial "Hola desde el Uno" + "Boton PRESIONADO/suelto".
 */
const HEX = readFileSync(new URL('./fixtures/uno-boton-led.hex', import.meta.url), 'utf8');
const MS = 16_000; // ciclos por milisegundo a 16 MHz

function simular() {
  const serial: number[] = [];
  const pines: [number, number][] = [];
  const sim = new AvrSimulador(HEX, { onSerial: (b) => serial.push(b), onPin: (p, n) => pines.push([p, n]) });
  const texto = () => Buffer.from(serial).toString('utf8');
  return { sim, serial, pines, texto };
}

describe('parsearIntelHex', () => {
  it('arma la imagen de flash (el vector de reset es un jmp)', () => {
    const flash = parsearIntelHex(HEX);
    expect(flash.length).toBe(0x8000);
    // 0x940C = jmp absoluto: la tabla de vectores del ATmega328P.
    expect(flash[0]! | (flash[1]! << 8)).toBe(0x940c);
  });

  it('rechaza un checksum roto y un registro que no entra en la flash', () => {
    expect(() => parsearIntelHex(':0100000000FE\n')).toThrow(/checksum/);
    expect(() => parsearIntelHex(':0280000000007E\n:00000001FF\n', 0x8000)).toThrow(/no entra/);
  });
});

describe('AvrSimulador (avr8js, firmware real del Uno)', () => {
  it('arranca, imprime por el Serial y el LED arranca apagado', () => {
    const { sim, texto } = simular();
    sim.ejecutar(50 * MS);
    expect(texto()).toContain('Hola desde el Uno');
    expect(texto()).toContain('Boton suelto');
    expect(sim.nivelSalida(13)).toBe(0);
  });

  it('el pull-up de D2 se lee como 1 sin nadie que lo maneje (botón suelto)', () => {
    const { sim, texto } = simular();
    sim.ejecutar(100 * MS);
    expect(texto()).not.toContain('PRESIONADO');
  });

  it('una entrada inyectada llega al pad: D2 a 0 → el sketch prende D13 (pin.out)', () => {
    const { sim, pines, texto } = simular();
    sim.ejecutar(30 * MS);
    expect(sim.ponerEntrada(2, 0)).toBe(true);
    sim.ejecutar(50 * MS);
    expect(sim.nivelSalida(13)).toBe(1);
    expect(pines).toContainEqual([13, 1]);
    expect(texto()).toContain('Boton PRESIONADO');

    // Suelta el botón (deja de manejarlo): vuelve el pull-up y se apaga.
    sim.ponerEntrada(2, null);
    sim.ejecutar(50 * MS);
    expect(sim.nivelSalida(13)).toBe(0);
    expect(pines.at(-1)).toEqual([13, 0]);
  });

  it('mandar 1 explícito (como hace la UI al soltar) también suelta el botón', () => {
    const { sim } = simular();
    sim.ejecutar(30 * MS);
    sim.ponerEntrada(2, 0);
    sim.ejecutar(40 * MS);
    sim.ponerEntrada(2, 1);
    sim.ejecutar(40 * MS);
    expect(sim.nivelSalida(13)).toBe(0);
  });

  it('pines fuera del Uno se ignoran', () => {
    const { sim } = simular();
    expect(sim.ponerEntrada(20, 1)).toBe(false);
    expect(sim.nivelSalida(99)).toBe(0);
  });
});

/** Arranca el emulador y junta eventos, como los recibe index.ts. */
function emulador(modo: 'worker' | 'local') {
  const log: string[] = [];
  const estados: string[] = [];
  const mensajes: FirmwareMessage[] = [];
  const puente: boolean[] = [];
  const emu = new AvrEmulator(
    {
      onLog: (l) => log.push(l),
      onState: (s: EmulatorStatus) => estados.push(s.state),
      onBridgeMessage: (m) => {
        mensajes.push(m);
        if (m.type === 'READY') emu.markBridgeReady();
      },
      onBridgeState: (c) => puente.push(c),
    },
    modo,
  );
  return { emu, log, estados, mensajes, puente };
}

const hexPath = new URL('./fixtures/uno-boton-led.hex', import.meta.url).pathname;
const artefactos = { firmware: hexPath, elf: null, usesWebServer: false, usesApi: false, needsRepl: false };

async function hasta(cond: () => boolean, ms = 45_000): Promise<void> {
  const limite = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > limite) throw new Error('tiempo agotado');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Con la PC cargada (la suite entera en paralelo) el Arduino emulado puede ir más lento
// que el tiempo real: esperas holgadas.
describe.each(['local', 'worker'] as const)('AvrEmulator (modo %s)', { timeout: 120_000 }, (modo) => {
  it('mismos estados y mensajes que el flujo de esp-emu: starting → booted → bridge, @READY y @OUT', async () => {
    const { emu, log, estados, mensajes, puente } = emulador(modo);
    await emu.start('uno', artefactos);
    try {
      await hasta(() => emu.getStatus().state === 'bridge');
      expect(estados.slice(0, 3)).toEqual(['starting', 'booted', 'bridge']);
      expect(puente).toEqual([true]);
      expect(mensajes[0]).toMatchObject({ type: 'READY', version: 1 });

      await hasta(() => log.some((l) => l === 'Hola desde el Uno'));
      emu.getBridge()!.setInput(2, 0);
      await hasta(() => mensajes.some((m) => m.type === 'OUT' && m.pin === 13 && m.level === 1));
      await hasta(() => log.includes('Boton PRESIONADO'));
      emu.getBridge()!.setInput(2, 1);
      await hasta(() => mensajes.some((m) => m.type === 'OUT' && m.pin === 13 && m.level === 0));

      // @WATCH: responde enseguida con el nivel actual.
      const antes = mensajes.length;
      emu.getBridge()!.watch(13);
      await hasta(() => mensajes.length > antes);
      expect(mensajes.at(-1)).toEqual({ type: 'OUT', pin: 13, level: 0 });
    } finally {
      await emu.stop();
    }
    expect(emu.getStatus()).toMatchObject({ state: 'stopped', running: false });
    expect(puente.at(-1)).toBe(false);
  });

  it('reset: el sketch arranca de nuevo', async () => {
    const { emu, log } = emulador(modo);
    await emu.start('uno', artefactos);
    try {
      await hasta(() => log.filter((l) => l === 'Hola desde el Uno').length === 1);
      await emu.reset();
      await hasta(() => log.filter((l) => l === 'Hola desde el Uno').length === 2);
    } finally {
      await emu.stop();
    }
  });
});
