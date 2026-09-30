import net from 'node:net';
import { BridgeLineParser, type EmulatorState, type FirmwareMessage } from '@emu/shared';

export interface BridgeEvents {
  onMessage: (msg: FirmwareMessage) => void;
  onState: (connected: boolean) => void;
  onRawLine: (line: string) => void;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000];

/** Reconstruye la línea de texto de un mensaje del firmware (para el log). */
function encodeFirmware(msg: FirmwareMessage): string {
  switch (msg.type) {
    case 'READY':
      return `@READY ${msg.version}${msg.esphomeVersion ? ' ' + msg.esphomeVersion : ''}`;
    case 'OUT':
      return `@OUT ${msg.pin} ${msg.level}`;
    case 'TX':
      return `@TX ${msg.bits} ${msg.protocol}`;
    case 'PONG':
      return `@PONG ${msg.n}`;
    case 'ERR':
      return `@ERR ${msg.code} ${msg.message}`;
  }
}

/**
 * Cliente del puente UART1 (7.1). Es un cliente TCP: el emulador escucha
 * (--uart1-tcp) y nos conectamos nosotros. Al reconectar manda @HELLO, y si
 * el firmware se resetea y vuelve a mandar @READY reenvía los @WATCH.
 */
export class BridgeClient {
  private socket: net.Socket | null = null;
  private readonly parser = new BridgeLineParser();
  private readonly watches = new Set<number>();
  private readonly inputs = new Map<number, number>();
  private closed = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  connected = false;

  constructor(
    private readonly port: number,
    private readonly host = '127.0.0.1',
    private readonly events: BridgeEvents,
  ) {}

  connect(): void {
    if (this.closed) return;
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.setEncoding('utf8');
    this.socket.setNoDelay(true);
    this.socket.on('connect', () => {
      this.attempt = 0;
      this.setConnected(true);
      this.send('HELLO', 1);
    });
    this.socket.on('data', (chunk: string) => {
      if (this.oyentesCrudos.size > 0) this.lineasCrudas(chunk);
      for (const msg of this.parser.push(chunk)) {
        this.events.onRawLine(encodeFirmware(msg));
        if (msg.type === 'READY') {
          // El puente se reinició: hay que re-vigilar los pines (7.1).
          this.resendWatches();
        }
        this.events.onMessage(msg);
      }
    });
    this.socket.on('error', () => {
      /* se maneja con close */
    });
    this.socket.on('close', () => {
      this.setConnected(false);
      this.scheduleReconnect();
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    this.events.onState(v);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** @WATCH: queda registrado para poder reenviarlo tras un reset. */
  watch(pin: number): void {
    this.watches.add(pin);
    this.send('WATCH', pin);
  }

  /** @IN: queda registrado para reenviar el estado tras un reset (7.1). */
  setInput(pin: number, level: number): void {
    this.inputs.set(pin, level);
    this.send('IN', pin, level);
  }

  sendRf(bits: string, protocol: number): void {
    this.send('RF', bits, protocol);
  }

  ping(n = 1): void {
    this.send('PING', n);
  }

  private resendWatches(): void {
    for (const pin of this.watches) this.send('WATCH', pin);
    for (const [pin, level] of this.inputs) this.send('IN', pin, level);
  }

  private send(tag: string, ...fields: (string | number)[]): void {
    const line = `@${tag} ${fields.join(' ')}\n`;
    if (this.socket && !this.socket.destroyed) this.socket.write(line);
    for (const o of this.oyentesEnvio) o(line.trimEnd());
  }

  // --- Modo debug (server/src/debug): líneas crudas del puente, en los dos sentidos ---------
  // El parser de arriba descarta lo que no conoce (p. ej. @VARS del depurador de MicroPython).

  private readonly oyentesCrudos = new Set<(linea: string) => void>();
  private readonly oyentesEnvio = new Set<(linea: string) => void>();
  private restoCrudo = '';

  private lineasCrudas(chunk: string): void {
    this.restoCrudo += chunk;
    let i: number;
    while ((i = this.restoCrudo.indexOf('\n')) !== -1) {
      const linea = this.restoCrudo.slice(0, i).replace(/\r$/, '');
      this.restoCrudo = this.restoCrudo.slice(i + 1);
      for (const o of this.oyentesCrudos) o(linea);
    }
    if (this.restoCrudo.length > 4096) this.restoCrudo = '';
  }

  /** Cada línea que manda el firmware (todas, también las que el parser ignora). Devuelve cómo dejar de escuchar. */
  escucharLineas(fn: (linea: string) => void): () => void {
    this.oyentesCrudos.add(fn);
    return () => this.oyentesCrudos.delete(fn);
  }

  /** Cada línea que la app le manda al firmware. */
  escucharEnvios(fn: (linea: string) => void): () => void {
    this.oyentesEnvio.add(fn);
    return () => this.oyentesEnvio.delete(fn);
  }

  /** Manda una línea tal cual (sin validar): la usa el depurador (@DUMP, @EVAL). */
  enviarLinea(linea: string): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(linea.endsWith('\n') ? linea : `${linea}\n`);
    for (const o of this.oyentesEnvio) o(linea.trimEnd());
    return true;
  }
}

export const EMU_STATES: EmulatorState[] = [
  'stopped',
  'starting',
  'booted',
  'wifi',
  'bridge',
  'crashed',
  'hung',
];
