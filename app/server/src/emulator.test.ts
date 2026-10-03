import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** "esp-emu" falso: un solo proceso que ignora SIGTERM (el `exec` conserva la señal ignorada). */
function binarioQueIgnoraSigterm(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'emu-fake-'));
  const bin = path.join(dir, 'esp-emu');
  writeFileSync(bin, "#!/bin/sh\ntrap '' TERM\necho 'ESP-ROM:esp32s3'\nexec sleep 60\n");
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * "esp-emu" falso que sí implementa --uart-tcp: abre un server TCP ahí (como hace el real con
 * la consola/REPL redirigida) y contesta un banner + hace eco de lo que se le escribe.
 */
function binarioConReplTcp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'emu-fake-repl-'));
  const bin = path.join(dir, 'esp-emu');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const net = require('node:net');
const args = process.argv.slice(2);
const [host, port] = args[args.indexOf('--uart-tcp') + 1].split(':');
console.log('ESP-ROM:esp32s3'); // por stdout, como el real antes de redirigir la consola
const server = net.createServer((socket) => {
  socket.write('MicroPython v1.29.0 on ESP32-S3\\n>>> \\n');
  socket.on('data', (d) => socket.write('echo:' + d));
});
server.listen(Number(port), host);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('EmulatorManager: consola redirigida (--uart-tcp, MicroPython)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('se conecta al puerto REPL: sin esto, no llega ni una línea y el watchdog lo marca "colgado" solo', async () => {
    vi.stubEnv('ESP_EMU_BIN', binarioConReplTcp());
    const { EmulatorManager } = await import('./emulator.js');
    const lineas: string[] = [];
    const emu = new EmulatorManager({
      onLog: (l) => lineas.push(l),
      onState: () => {},
      onBridgeMessage: () => {},
      onBridgeState: () => {},
    });
    await emu.start('p', { firmware: '/dev/null', elf: null, usesWebServer: false, usesApi: false, needsRepl: true });

    // El banner de MicroPython solo llega si el server se conectó de verdad al --uart-tcp.
    await expect.poll(() => lineas.some((l) => l.includes('MicroPython v1.29.0')), { timeout: 5000 }).toBe(true);

    // Lo que se escribe en la consola tiene que llegar por el mismo socket (REPL interactivo).
    const antes = lineas.length;
    emu.writeConsole('1+1\n');
    await expect.poll(() => lineas.slice(antes).some((l) => l.includes('echo:1+1')), { timeout: 5000 }).toBe(true);

    await emu.stop();
  });
});

/**
 * "esp-emu" falso que entiende el REPL en crudo como MicroPython de verdad: no ejecuta
 * Python, pero contesta el mismo protocolo y vuelca lo recibido a un archivo para
 * verificar qué mandó `uploadMicroPython`.
 *
 * Reproduce las dos cosas que rompieron la versión anterior contra esp-emu real:
 * - el banner de arranque ("...>>> ", con su propio ">") llega DESPUÉS del Ctrl-A;
 * - el buffer de entrada es chico (BUFFER bytes): lo que llega sin haber sido pedido se
 *   PIERDE, como en el UART real. Mandar el código de un saque pierde el Ctrl-D y cuelga.
 * `rawPaste`: si el firmware falso soporta el modo raw-paste (con control de flujo).
 */
function binarioConReplCrudo(volcado: string, rawPaste = true, runningAtStart = false): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'emu-fake-raw-'));
  const bin = path.join(dir, 'esp-emu');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const net = require('node:net');
const fs = require('node:fs');
const args = process.argv.slice(2);
const [host, port] = args[args.indexOf('--uart-tcp') + 1].split(':');
const BUFFER = 256;
const VENTANA = 128;
console.log('ESP-ROM:esp32s3');
const server = net.createServer((socket) => {
  setTimeout(() => socket.write('MicroPython v1.29.0 on ESP32-S3\\r\\n>>> '), 200);
  let modo = ${runningAtStart ? "'corriendo'" : "'normal'"}; // corriendo | normal | crudo | pegando
  let codigo = Buffer.alloc(0);
  let enVentana = 0; // bytes de la ventana actual todavía sin pedir más
  let pendiente = false;
  const terminar = () => {
    fs.writeFileSync(${JSON.stringify(volcado)}, codigo.toString('utf8'));
    socket.write((modo === 'crudo' ? 'OK' : '\\x04') + 'hecho\\x04\\x04>');
    codigo = Buffer.alloc(0);
    modo = 'crudo';
  };
  socket.on('data', (d) => {
    for (let i = 0; i < d.length; i++) {
      const b = d[i];
      if (modo === 'corriendo') {
        // El REPL de una placa ejecutando main.py ignora Ctrl-A; Ctrl-C sí interrumpe.
        if (b === 0x03) { modo = 'normal'; socket.write('KeyboardInterrupt\\r\\n>>> '); }
        continue;
      }
      if (modo === 'normal') {
        if (b === 0x01 && !pendiente) {
          pendiente = true;
          setTimeout(() => { pendiente = false; modo = 'crudo'; socket.write('raw REPL; CTRL-B to exit\\r\\n>'); }, 400);
        }
        continue;
      }
      if (modo === 'crudo') {
        if (b === 0x05 && d[i + 1] === 0x41 && d[i + 2] === 0x01) {
          i += 2;
          if (!${rawPaste}) { socket.write('R\\x00'); continue; }
          modo = 'pegando';
          enVentana = 0;
          socket.write(Buffer.from([0x52, 0x01, VENTANA & 0xff, VENTANA >> 8]));
          continue;
        }
        if (b === 0x04) { terminar(); continue; }
        if (b === 0x02) { modo = 'normal'; continue; }
        // Sin control de flujo: una tanda demasiado grande desborda y se pierde. El límite es
        // 4 buffers y no 1 porque, con la máquina cargada, TCP junta 2 o 3 trozos seguidos de
        // 256 (le pasaría igual a mpremote); mandar varios KB de un saque sí lo supera.
        if (d.length > BUFFER * 4) continue;
        codigo = Buffer.concat([codigo, Buffer.from([b])]);
        continue;
      }
      // pegando (raw-paste): más allá de la ventana concedida, los bytes se pierden.
      if (b === 0x04) { modo = 'pegando-fin'; terminar(); continue; }
      if (enVentana >= VENTANA) continue;
      codigo = Buffer.concat([codigo, Buffer.from([b])]);
      enVentana++;
      if (enVentana === VENTANA) setTimeout(() => { enVentana = 0; socket.write('\\x01'); }, 5); // "procesé, mandá más"
    }
  });
});
server.listen(Number(port), host);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('EmulatorManager.uploadMicroPython', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Un main.py grande (varios KB, como el puente real): de un saque desbordaría el buffer. */
  const grande = Array.from({ length: 120 }, (_, i) => `print("linea ${i} con bastante texto para ocupar lugar")`).join('\n') + '\n';

  async function subir(rawPaste: boolean, runningAtStart = false) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'emu-fake-raw-dump-'));
    const volcado = path.join(dir, 'recibido.py');
    vi.stubEnv('ESP_EMU_BIN', binarioConReplCrudo(volcado, rawPaste, runningAtStart));
    const { EmulatorManager } = await import('./emulator.js');
    const emu = new EmulatorManager({ onLog: () => {}, onState: () => {}, onBridgeMessage: () => {}, onBridgeState: () => {} });
    await emu.start('p', { firmware: '/dev/null', elf: null, usesWebServer: false, usesApi: false, needsRepl: true });
    const r = await emu.uploadMicroPython([
      { path: 'boot.py', content: 'import simbridge\nsimbridge.start()\n' },
      { path: 'main.py', content: grande },
      { path: 'lib/helpers.py', content: 'def valor():\n    return 42\n' },
    ]);
    await emu.stop();
    return { r, recibido: r.ok ? readFileSync(volcado, 'utf8') : '' };
  }

  function verificar(recibido: string) {
    expect(recibido).toContain('_w("boot.py"');
    expect(recibido).toContain('uos.mkdir(d)');
    expect(recibido).toContain('_w("lib/helpers.py"');
    // Lo que se mandó en base64 tiene que llegar entero y decodificar exactamente al original.
    const m = recibido.match(/_w\("main\.py", b'([^']+)'\)/);
    expect(Buffer.from(m![1]!, 'base64').toString('utf8')).toBe(grande);
  }

  it('sube varios KB sin desbordar el buffer del UART (raw-paste con control de flujo)', async () => {
    const { r, recibido } = await subir(true);
    expect(r).toMatchObject({ ok: true });
    verificar(recibido);
  });

  it('sin raw-paste, cae al REPL en crudo clásico en trozos chicos', async () => {
    const { r, recibido } = await subir(false);
    expect(r).toMatchObject({ ok: true });
    verificar(recibido);
  });
  it('interrumpe main.py antes de recargar sin reiniciar el proceso del emulador', async () => {
    const { r, recibido } = await subir(true, true);
    expect(r).toMatchObject({ ok: true });
    verificar(recibido);
  });
});

describe('EmulatorManager.stop', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('si el emulador ignora SIGTERM, lo mata con SIGKILL y queda en stopped', async () => {
    vi.stubEnv('ESP_EMU_BIN', binarioQueIgnoraSigterm());
    const { EmulatorManager } = await import('./emulator.js');
    const estados: string[] = [];
    const emu = new EmulatorManager({
      onLog: () => {},
      onState: (s) => estados.push(s.state),
      onBridgeMessage: () => {},
      onBridgeState: () => {},
    });
    await emu.start('p', { firmware: '/dev/null', elf: null, usesWebServer: false, usesApi: false, needsRepl: false });
    expect(emu.getStatus().running).toBe(true);

    const inicio = Date.now();
    await emu.stop();
    expect(emu.getStatus()).toMatchObject({ state: 'stopped', running: false, pid: null });
    expect(estados.at(-1)).toBe('stopped');
    expect(Date.now() - inicio).toBeLessThan(6000);
  });
});
