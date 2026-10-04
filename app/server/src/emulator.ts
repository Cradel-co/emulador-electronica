import net from 'node:net';
import { promises as fs } from 'node:fs';
import type { EmulatorState, FirmwareMessage, SalidaChip } from '@emu/shared';
import { PuenteChips } from './bus/puenteChips.js';
import type { ChipEnBus } from './bus/proyectoChips.js';
import { BridgeClient } from './bridgeClient.js';
import { lineIterator, which } from './dockerRunner.js';
import { detectState, extractIp, HANG_TIMEOUT_MS, HangWatchdog, stripAnsi } from './logParser.js';
import { reservePorts, releasePorts, PORTS_PER_INSTANCE } from './ports.js';
import type { BuildArtifacts } from './buildService.js';
import type { Emulador, OpcionesArranque } from './emulatorBackend.js';

export const ESP_EMU_BIN = process.env.ESP_EMU_BIN ?? 'esp-emu';
export const ESP_EMU_VERSION = '0.44.0';
/** Cuánto se espera a que esp-emu termine con SIGTERM antes de mandar SIGKILL. */
const STOP_GRACE_MS = 3000;
/** Reintentos para conectar al REPL (--uart-tcp): esp-emu tarda un instante en abrir el puerto. */
const REPL_RECONNECT_DELAYS_MS = [100, 200, 400, 800, 1500, 3000];

export interface EmuPorts {
  bridge: number;
  control: number;
  api: number;
  web: number;
}

export interface EmulatorStatus {
  state: EmulatorState;
  running: boolean;
  pid: number | null;
  project: string | null;
  ports: EmuPorts | null;
  ip: string | null;
  startedAt: number | null;
  exitInfo: string | null;
}

export interface EmulatorEvents {
  onLog: (line: string) => void;
  onState: (status: EmulatorStatus) => void;
  onBridgeMessage: (msg: FirmwareMessage) => void;
  onBridgeState: (connected: boolean) => void;
}

/**
 * Gestor del emulador (sección 9). Una instancia a la vez (9.4).
 * Nunca usa pkill -f (mata la shell, verificado): guarda el PID.
 */
export class EmulatorManager implements Emulador {
  private child: ReturnType<typeof import('node:child_process').spawn> | null = null;
  private heldPorts: number[] = [];
  private bridge: BridgeClient | null = null;
  private watchdog: HangWatchdog | null = null;
  private status: EmulatorStatus = EmulatorManager.emptyStatus();
  private stdoutLines: string[] = [];
  private replSocket: net.Socket | null = null;
  /** Subiendo archivos por el REPL en crudo: lo que llega es protocolo, no se loguea. */
  private subiendoRepl = false;
  /** Puerto del stub GDB (`--gdb`) de la corrida actual, para el modo debug. */
  private gdbPort: number | null = null;
  /** Chips del dibujo (MicroPython: machine.I2C/SPI por el puente). Ver bus/puenteChips.ts. */
  private chips: PuenteChips | null = null;
  private readonly salidasChips = new Map<string, SalidaChip>();
  private readonly entornos = new Map<string, Record<string, number>>();
  /** Lo que publica un chip (una pantalla) va a la UI. Lo conecta index.ts. */
  oyenteChips: ((id: string, salida: SalidaChip) => void) | null = null;
  /** Memoria no volátil de un chip (EEPROM, la hora con pila): index.ts la guarda en el proyecto. */
  oyenteGuardado: ((id: string, datos: unknown) => void) | null = null;

  constructor(private readonly events: EmulatorEvents) {}

  getGdbPort(): number | null {
    return this.status.running ? this.gdbPort : null;
  }

  private static emptyStatus(): EmulatorStatus {
    return {
      state: 'stopped',
      running: false,
      pid: null,
      project: null,
      ports: null,
      ip: null,
      startedAt: null,
      exitInfo: null,
    };
  }

  getStatus(): EmulatorStatus {
    return { ...this.status };
  }

  async available(): Promise<boolean> {
    return which(ESP_EMU_BIN);
  }

  /** Arranca (o rearranca) el emulador con el firmware ya compilado. */
  async start(projectName: string, artifacts: BuildArtifacts, opts: OpcionesArranque = {}): Promise<EmulatorStatus> {
    if (this.status.running) await this.stop();

    const ports = await this.pickPorts(artifacts);
    const args = [
      '--chip',
      // El chip sale del registro de placas (boards.ts): esp32s3, esp32c3, esp32c6.
      opts.chip ?? 'esp32s3',
      '--firmware',
      artifacts.firmware,
      '--log-color',
      'never',
      '--wifi-ssid',
      'sim-wifi',
      '--wifi-password',
      'sim-password',
      '--uart1-tcp',
      `127.0.0.1:${ports.bridge}`,
      '--control-tcp',
      `127.0.0.1:${ports.control}`,
    ];
    if (artifacts.elf) args.push('--elf', artifacts.elf);
    // Modo debug (debug/adaptadorEsp.ts): stub GDB siempre que haya .elf (EMU_DEBUG_GDB=0 lo apaga).
    // esp-emu lo abre en 0.0.0.0 (solo acepta el número): el depurador se conecta enseguida y lo
    // deja ocupado (atiende un cliente a la vez). Base 30000 para no chocar con los de arriba.
    this.gdbPort = artifacts.elf && process.env.EMU_DEBUG_GDB !== '0' ? ((await reservePorts(1, 30000))[0] ?? null) : null;
    if (this.gdbPort) this.heldPorts.push(this.gdbPort);
    if (this.gdbPort) args.push('--gdb', String(this.gdbPort));

    // Web/API del dispositivo emulado: solo si el proyecto las usa (9.1).
    const hostfwd: string[] = [];
    if (artifacts.usesApi) hostfwd.push(`hostfwd=tcp:127.0.0.1:${ports.api}-:6053`);
    if (artifacts.usesWebServer) hostfwd.push(`hostfwd=tcp:127.0.0.1:${ports.web}-:80`);
    args.push('--net', ['user', ...hostfwd].join(','));
    if (artifacts.needsRepl) args.push('--uart-tcp', `127.0.0.1:${ports.web}`);
    if (opts.rmtLoopback && opts.rmtLoopback.length > 0) args.push('--rmt-loopback', opts.rmtLoopback.join(','));

    const { spawn } = await import('node:child_process');
    const child = spawn(ESP_EMU_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.stdoutLines = [];

    this.status = {
      ...this.status,
      state: 'starting',
      running: true,
      pid: child.pid ?? null,
      project: projectName,
      ports,
      ip: null,
      startedAt: Date.now(),
      exitInfo: null,
    };
    this.emitState();
    this.events.onLog(`$ ${ESP_EMU_BIN} ${args.join(' ')}`);

    const flush = lineIterator(child.stdout!, (line) => this.onUartLine(line));
    lineIterator(child.stderr!, (line) => this.onUartLine(line));
    child.on('close', (code, signal) => {
      for (const line of flush()) this.onUartLine(line);
      this.events.onLog(`[emu] el emulador terminó (code=${code} signal=${signal ?? '-'})`);
      this.teardown(`terminó con código ${code ?? 'null'}${signal ? ` (${signal})` : ''}`);
    });
    child.on('error', (err) => {
      this.events.onLog(`[emu] no se pudo arrancar: ${err.message}`);
      this.teardown(err.message);
    });

    this.watchdog = new HangWatchdog(HANG_TIMEOUT_MS);
    const timer = setInterval(() => {
      if (this.status.running && this.watchdog?.shouldHang(this.status.state)) {
        this.setState('hung');
        this.events.onLog('[emu] 60 s sin una sola línea nueva: marcado como colgado (9.2).');
      }
    }, 5000);
    timer.unref();

    this.bridge = new BridgeClient(ports.bridge, '127.0.0.1', {
      onMessage: (line) => this.events.onBridgeMessage(line),
      onState: (connected) => this.events.onBridgeState(connected),
      onRawLine: (line) => this.events.onLog(`[bridge] ${line}`),
    });
    this.bridge.connect();
    if (artifacts.needsRepl) this.armarChips(opts.chips ?? []);

    // MicroPython (y cualquier --uart-tcp): la consola del chip deja de salir por stdout y
    // pasa a este puerto — sin conectarnos acá, no llega ni una línea (y el watchdog lo marca "colgado" solo).
    if (artifacts.needsRepl) this.conectarRepl(child, ports.web, 0);

    return this.getStatus();
  }

  /**
   * MicroPython: el puente reemplaza machine.I2C/SPI y cada transacción llega acá. Se arma aunque
   * el dibujo no tenga chips, para que el programa reciba un NACK (como en una placa sin nada
   * cableado) en vez de esperar una respuesta que no llega.
   */
  private armarChips(chips: ChipEnBus[]): void {
    const bridge = this.bridge;
    if (!bridge) return;
    this.salidasChips.clear();
    this.entornos.clear();
    for (const c of chips) this.entornos.set(c.id, { ...c.entorno });
    const puente = new PuenteChips(chips, {
      enviar: (l) => bridge.enviarLinea(l),
      alSalida: (id, s) => { this.salidasChips.set(id, s); this.oyenteChips?.(id, s); },
      alLog: (l) => this.events.onLog(l),
      alGuardar: (id, d) => this.oyenteGuardado?.(id, d),
      // INT, SQW...: entran al programa como las entradas del dibujo (@IN). Soltada, vale su pull-up.
      alPin: (id, pin, nivel) => {
        const c = chips.find((x) => x.id === id);
        const g = c?.pinesGpio[pin];
        if (c && g !== undefined) bridge.setInput(g, nivel ?? (c.pullUps.includes(pin) ? 1 : 0));
      },
    });
    this.chips = puente;
    bridge.escucharLineas((l) => { if (this.chips === puente) puente.recibir(l); });
  }

  actualizarCamaras(chips: ChipEnBus[]): void { this.chips?.actualizarCamaras(chips); }

  entradaCamara(instancia: string, datos: import('./bus/chipSandbox.js').EntradaChip): void { this.chips?.entradaCamara(instancia, datos); }

  chipsEnCorrida(): { id: string; instancia: string; chip: string; nombre: string; alimentado: boolean; entorno: Record<string, number>; salida?: SalidaChip }[] {
    return (this.chips?.chips ?? []).map((c) => ({
      id: c.id, instancia: c.instancia, chip: c.chip, nombre: c.nombre, alimentado: c.alimentado,
      entorno: { ...this.entornos.get(c.id) }, salida: this.salidasChips.get(c.id),
    }));
  }

  /** El usuario movió el entorno de una instancia: cada chip de esa placa toma lo que mide. */
  ponerEntorno(instancia: string, valores: Record<string, number>): boolean {
    let alguno = false;
    for (const c of this.chips?.chips ?? []) {
      if (c.instancia !== instancia) continue;
      alguno = true;
      const actual = this.entornos.get(c.id)!;
      const suyos = Object.fromEntries(Object.entries(valores).filter(([k]) => k in actual));
      if (Object.keys(suyos).length === 0) continue;
      Object.assign(actual, suyos);
      this.chips?.ponerEntorno(c.id, suyos);
    }
    return alguno;
  }

  /** Se conecta al UART redirigido por --uart-tcp (REPL/Serial); reintenta hasta que esp-emu abra el puerto. */
  private conectarRepl(child: ReturnType<typeof import('node:child_process').spawn>, port: number, intento: number): void {
    if (this.child !== child) return; // se paró o se reinició mientras tanto: este intento ya no vale
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let conectado = false;
    socket.on('connect', () => {
      conectado = true;
      if (this.child !== child) {
        socket.destroy();
        return;
      }
      // Sin Nagle: es una consola interactiva, y la subida en trozos de 256 bytes
      // (REPL en crudo sin raw-paste) depende de que no se junten en un solo paquete.
      socket.setNoDelay(true);
      this.replSocket = socket;
      lineIterator(socket, (line) => {
        if (!this.subiendoRepl) this.onUartLine(line);
      });
    });
    socket.on('error', () => {
      /* se reintenta en 'close' */
    });
    socket.on('close', () => {
      if (this.replSocket === socket) this.replSocket = null;
      if (this.child !== child) return;
      const espera = REPL_RECONNECT_DELAYS_MS[Math.min(intento, REPL_RECONNECT_DELAYS_MS.length - 1)]!;
      setTimeout(() => this.conectarRepl(child, port, intento + 1), espera);
      if (!conectado && intento === 0) this.events.onLog('[emu] conectando a la consola (REPL)…');
    });
  }

  /** Espera a que el socket del REPL (--uart-tcp) esté conectado, o null si se agota el tiempo. */
  private async waitReplSocket(timeoutMs: number): Promise<net.Socket | null> {
    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
      if (this.replSocket && !this.replSocket.destroyed) return this.replSocket;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.replSocket && !this.replSocket.destroyed ? this.replSocket : null;
  }

  /**
   * Ejecuta código en el REPL en crudo de MicroPython, con el mismo protocolo que mpremote
   * (no es específico de esta app). Ctrl-A entra al REPL en crudo; después:
   *
   * - **raw-paste** (Ctrl-E "A" Ctrl-A → el dispositivo contesta "R\x01" + tamaño de ventana):
   *   control de flujo real — se manda como mucho una ventana y el dispositivo pide más con
   *   \x01 a medida que procesa. Hace falta porque el buffer de entrada del UART de MicroPython
   *   es de ~256 bytes: mandar el puente entero (~5 KB en base64) de un saque lo desborda, se
   *   pierde el Ctrl-D final y queda colgado en "raw REPL; CTRL-B to exit" para siempre.
   * - si no lo soporta ("R\x00" o firmware viejo): REPL en crudo clásico, en trozos de 256
   *   bytes con una pausa entre cada uno (lo mismo que hace mpremote en ese caso).
   *
   * Termina con stdout + \x04 + stderr + \x04 (en el clásico, precedido de "OK").
   */
  private sendRawRepl(socket: net.Socket, code: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    const datos = Buffer.from(code, 'utf8');
    return new Promise((resolve, reject) => {
      type Fase = 'entrando' | 'negociando' | 'reentrando' | 'pegando' | 'esperando-fin' | 'salida' | 'salida-ok';
      let fase: Fase = 'entrando';
      let buf = ''; // latin1: 1 byte = 1 char, así \x01/\x04 y los bytes de la ventana se leen tal cual
      let pos = 0;
      let ventana = 0;
      let incremento = 0;
      let terminado = false;
      const limpiar = (): void => {
        terminado = true;
        clearTimeout(timer);
        socket.off('data', onData);
      };
      const timer = setTimeout(() => {
        limpiar();
        reject(new Error(`el REPL no respondió a tiempo (fase: ${fase})`));
      }, timeoutMs);

      /** raw-paste: manda lo que permita la ventana; al final, Ctrl-D. */
      const enviarVentana = (): void => {
        while (ventana > 0 && pos < datos.length) {
          const trozo = datos.subarray(pos, pos + ventana);
          socket.write(trozo);
          pos += trozo.length;
          ventana -= trozo.length;
        }
        if (pos >= datos.length && fase === 'pegando') {
          socket.write('\x04');
          fase = 'esperando-fin';
        }
      };

      /** REPL en crudo clásico, sin control de flujo: trozos chicos con pausa. */
      const enviarEnTrozos = async (): Promise<void> => {
        fase = 'salida-ok';
        buf = '';
        for (let i = 0; i < datos.length && !terminado; i += 256) {
          socket.write(datos.subarray(i, i + 256));
          await new Promise((r) => setTimeout(r, 10));
        }
        if (!terminado) socket.write('\x04');
      };

      const terminarSiCompleto = (desde: number): void => {
        const resto = buf.slice(desde);
        const partes = resto.split('\x04');
        if (partes.length < 3) return;
        limpiar();
        resolve({ stdout: partes[0] ?? '', stderr: partes[1] ?? '' });
      };

      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('latin1');
        // El "\r\n>" final confirma el REPL en crudo. Ojo: el ">>> " del prompt normal también
        // tiene ">", y el banner de arranque llega solo: no alcanza con buscar ">".
        if (fase === 'entrando' || fase === 'reentrando') {
          const i = buf.indexOf('raw REPL; CTRL-B to exit\r\n>');
          if (i < 0) return;
          buf = buf.slice(i + 'raw REPL; CTRL-B to exit\r\n>'.length);
          if (fase === 'reentrando') {
            void enviarEnTrozos();
            return;
          }
          fase = 'negociando';
          socket.write('\x05A\x01'); // pide raw-paste
        }
        if (fase === 'negociando') {
          if (buf.length < 2) return;
          if (buf.startsWith('R\x01')) {
            if (buf.length < 4) return;
            incremento = buf.charCodeAt(2) | (buf.charCodeAt(3) << 8);
            ventana = incremento;
            buf = buf.slice(4);
            fase = 'pegando';
            enviarVentana();
          } else if (buf.startsWith('R\x00')) {
            void enviarEnTrozos(); // lo entiende pero lo tiene deshabilitado: sigue en crudo
            return;
          } else {
            // Firmware sin raw-paste: tomó el Ctrl-A del pedido como un reingreso al REPL en crudo.
            fase = 'reentrando';
            buf = '';
            return;
          }
        }
        if (fase === 'pegando') {
          // Mientras se pega, el dispositivo solo manda \x01 (pedí más) o \x04 (cortá).
          while (buf.length && fase === 'pegando') {
            const c = buf[0];
            buf = buf.slice(1);
            if (c === '\x01') ventana += incremento;
            else if (c === '\x04') {
              socket.write('\x04');
              fase = 'esperando-fin';
            }
          }
          if (fase === 'pegando') enviarVentana();
        }
        if (fase === 'esperando-fin') {
          const i = buf.indexOf('\x04'); // el dispositivo confirma el fin de los datos
          if (i < 0) return;
          buf = buf.slice(i + 1);
          fase = 'salida';
        }
        if (fase === 'salida') terminarSiCompleto(0);
        else if (fase === 'salida-ok') {
          const i = buf.indexOf('OK');
          if (i >= 0) terminarSiCompleto(i + 2);
        }
      };
      socket.on('data', onData);
      socket.write('\x01'); // Ctrl-A: entra al REPL en crudo
    });
  }

  /**
   * Sube archivos al filesystem de MicroPython por el REPL (8.8) y resetea por
   * software para que arranque boot.py → main.py con los archivos ya puestos.
   * Se manda todo en un solo bloque, codificado en base64 (evita lidiar con
   * comillas/saltos de línea del contenido real).
   */
  async uploadMicroPython(files: { path: string; content: string }[]): Promise<{ ok: boolean; output: string }> {
    const socket = await this.waitReplSocket(15000);
    if (!socket) return { ok: false, output: 'no se pudo conectar al REPL en 15 s' };
    const escrituras = files
      .map((f) => `_w(${JSON.stringify(f.path)}, b'${Buffer.from(f.content, 'utf8').toString('base64')}')`)
      .join('\n');
    const code = `import ubinascii\nimport uos\ndef _w(p,b):\n d=''\n for part in p.split('/')[:-1]:\n  d=(d+'/' if d else '')+part\n  try:\n   uos.mkdir(d)\n  except OSError:\n   pass\n f=open(p,'wb')\n f.write(ubinascii.a2b_base64(b))\n f.close()\n${escrituras}\n`;
    let resultado: { stdout: string; stderr: string };
    // Lo que va y viene durante la subida son bytes del protocolo (ventanas de raw-paste,
    // \x01, \x04): no es salida del programa, así que no se muestra en la consola.
    this.subiendoRepl = true;
    try {
      // Ctrl-A sólo abre el REPL cuando no hay un programa ejecutándose. Interrumpir
      // primero el main.py permite recargar bucles while True sin reiniciar QEMU.
      socket.write('\x03\x03');
      await new Promise(resolve => setTimeout(resolve, 150));
      if (socket.destroyed || this.replSocket !== socket || !this.status.running) throw new Error('La ejecución se detuvo durante la subida.');
      resultado = await this.sendRawRepl(socket, code, 15000);
    } catch (err) {
      this.subiendoRepl = false;
      return { ok: false, output: (err as Error).message };
    }
    if (resultado.stderr.trim()) {
      this.subiendoRepl = false;
      return { ok: false, output: stripAnsi(resultado.stderr) };
    }
    // Vuelve al REPL amigable (su salto de línea cierra la línea de protocolo, que se descarta)
    // y Ctrl-D ahí = soft reboot: relee boot.py y main.py del filesystem.
    socket.write('\x02');
    await new Promise((r) => setTimeout(r, 150));
    this.subiendoRepl = false;
    const chips = this.chips?.chips ?? [];
    this.chips?.apagar();
    this.armarChips(chips);
    socket.write('\x04');
    return { ok: true, output: `${files.length} archivo(s) subido(s)` };
  }

  private async pickPorts(artifacts: BuildArtifacts): Promise<EmuPorts> {
    // 4 puertos por instancia (9.3); el REPL de MicroPython reutiliza el de web.
    const reserved = await reservePorts(PORTS_PER_INSTANCE);
    this.heldPorts = reserved;
    const [bridge = 0, control = 0, api = 0, web = 0] = reserved;
    return { bridge, control, api, web };
  }

  private onUartLine(raw: string): void {
    const line = stripAnsi(raw);
    this.stdoutLines.push(line);
    if (this.stdoutLines.length > 2000) this.stdoutLines.shift();
    this.events.onLog(line);
    this.watchdog?.feed(line);
    const ip = extractIp(line);
    if (ip) this.status.ip = ip;
    const next = detectState(line, this.status.state);
    // 'bridge' no se baja a 'booted'/'wifi': es el estado más avanzado.
    if (next && !(this.status.state === 'bridge' && next !== 'crashed')) this.setState(next);
  }

  private setState(state: EmulatorState): void {
    if (this.status.state === state) return;
    this.status.state = state;
    this.events.onLog(`[emu] estado: ${state}`);
    this.emitState();
  }

  private emitState(): void {
    this.events.onState(this.getStatus());
  }

  markBridgeReady(): void {
    this.setState('bridge');
  }

  getBridge(): BridgeClient | null {
    return this.bridge;
  }

  getRecentLog(limit = 200): string[] {
    return this.stdoutLines.slice(-limit);
  }

  /** Envía texto a la entrada del emulador (REPL de MicroPython, Serial). */
  writeConsole(data: string): boolean {
    if (this.replSocket && !this.replSocket.destroyed) {
      this.replSocket.write(data);
      return true;
    }
    if (this.child?.stdin && !this.child.stdin.destroyed) {
      this.child.stdin.write(data);
      return true;
    }
    return false;
  }

  /** Canal de control: reset, erase-flash, ping (9.4). */
  async control(command: string, ports: EmuPorts, timeoutMs = 4000): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: ports.control });
      let out = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`el canal de control no respondió a "${command}"`));
      }, timeoutMs);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(command + '\n'));
      socket.on('data', (chunk: string) => {
        out += chunk;
        if (out.includes('\n')) {
          clearTimeout(timer);
          socket.end();
          resolve(out.trim());
        }
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async reset(): Promise<string> {
    if (!this.status.ports) throw new Error('El emulador no está corriendo');
    const chips = this.chips?.chips ?? [];
    this.chips?.apagar();
    this.armarChips(chips);
    return this.control('reset', this.status.ports);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.teardown('parado');
      return;
    }
    // Antes de cortar: los chips guardan lo último (la hora del RTC, lo grabado en la EEPROM).
    this.chips?.apagar();
    this.events.onLog('[emu] detenido por la app (SIGTERM)');
    child.kill('SIGTERM');
    // `child.killed` solo dice que la señal se *envió*: vivo = todavía sin código ni señal de salida.
    const vivo = (): boolean => child.exitCode === null && child.signalCode === null;
    await new Promise<void>((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      child.once('close', () => {
        timers.forEach(clearTimeout);
        resolve();
      });
      timers.push(
        setTimeout(() => {
          if (!vivo()) return;
          this.events.onLog('[emu] no terminó con SIGTERM en 3 s: SIGKILL');
          child.kill('SIGKILL');
        }, STOP_GRACE_MS),
        // Si ni así llega 'close', se libera la UI igual (el PID ya no es nuestro problema).
        setTimeout(() => {
          if (this.child === child) this.teardown('no respondió al parar');
          resolve();
        }, STOP_GRACE_MS + 2000),
      );
    });
  }

  private teardown(exitInfo: string): void {
    releasePorts(this.heldPorts); this.heldPorts = [];
    this.gdbPort = null;
    this.chips?.apagar();
    this.chips = null;
    this.bridge?.close();
    this.bridge = null;
    this.replSocket?.destroy();
    this.replSocket = null;
    this.status = { ...this.status, state: 'stopped', running: false, pid: null, exitInfo };
    this.child = null;
    this.emitState();
  }

  /** Mata los emuladores hijos al cerrar el backend (9.4). */
  async shutdown(): Promise<void> {
    await this.stop();
  }
}

/** ¿Existe un firmware compilado para este proyecto? */
export async function findBuildOutputs(buildDir: string, projectName: string): Promise<BuildArtifacts | null> {
  const base = `${buildDir}/.esphome/build/${projectName}/build`;
  const firmware = `${base}/firmware.factory.bin`;
  try {
    await fs.stat(firmware);
  } catch {
    return null;
  }
  let elf: string | null = null;
  try {
    await fs.stat(`${base}/firmware.elf`);
    elf = `${base}/firmware.elf`;
  } catch {
    elf = null;
  }
  return { firmware, elf, usesWebServer: true, usesApi: true, needsRepl: false };
}
