import net from 'node:net';
import { EventEmitter } from 'node:events';

/**
 * Cliente mínimo del GDB Remote Serial Protocol (el que habla `gdb` con un stub), para
 * el stub que sirve `esp-emu --gdb PUERTO`. Verificado contra esp-emu 0.44 (ESP32-S3):
 *
 *  - Al conectarse, el stub FRENA el chip (`?` → S05) hasta recibir `c`; al
 *    desconectarse, el chip sigue solo ("target resumes free-running").
 *  - Un cliente a la vez: un segundo cliente queda en espera hasta que el primero
 *    suelte la conexión. Por eso la app se queda conectada mientras corre.
 *  - Soporta `?`, `g`, `p`, `m`, `M`, `Z0`/`z0`, `c`, `s`, Ctrl-C (\x03) y
 *    QStartNoAckMode. Cada respuesta tarda ~40 ms: conviene pedir memoria en bloques.
 *  - OJO: escucha en 0.0.0.0 (no acepta host:puerto, solo el número).
 *
 * Paquetes: `$datos#cs` con cs = suma de bytes mod 256 en hex; escape `}` (xor 0x20)
 * y compresión run-length `*` en las respuestas.
 */

export interface ParadaGdb {
  /** Señal (5 = SIGTRAP: breakpoint/paso; 2 = SIGINT: interrupción). */
  senal: number;
  /** Pares "clave:valor" del paquete T (thread, swbreak, registros...). */
  campos: Record<string, string>;
  /** El programa terminó (W/X). */
  termino?: boolean;
  crudo: string;
}

export class ErrorGdb extends Error {}

export function checksum(datos: string): string {
  let s = 0;
  for (let i = 0; i < datos.length; i++) s = (s + datos.charCodeAt(i)) & 0xff;
  return s.toString(16).padStart(2, '0');
}

/** Escapa los caracteres especiales del protocolo ($ # } *) para un paquete saliente. */
export function escapar(datos: string): string {
  let out = '';
  for (const c of datos) {
    if (c === '$' || c === '#' || c === '}' || c === '*') out += '}' + String.fromCharCode(c.charCodeAt(0) ^ 0x20);
    else out += c;
  }
  return out;
}

/** Deshace escapes y run-length de un paquete entrante. */
export function desescapar(datos: string): string {
  let out = '';
  for (let i = 0; i < datos.length; i++) {
    const c = datos[i]!;
    if (c === '}') {
      out += String.fromCharCode(datos.charCodeAt(++i) ^ 0x20);
    } else if (c === '*') {
      const n = datos.charCodeAt(++i) - 29;
      out += out[out.length - 1]!.repeat(Math.max(0, n));
    } else out += c;
  }
  return out;
}

export function parsearParada(p: string): ParadaGdb | null {
  if (p.startsWith('S') && p.length >= 3) return { senal: parseInt(p.slice(1, 3), 16), campos: {}, crudo: p };
  if (p.startsWith('T') && p.length >= 3) {
    const campos: Record<string, string> = {};
    for (const par of p.slice(3).split(';')) {
      if (!par) continue;
      const i = par.indexOf(':');
      campos[i < 0 ? par : par.slice(0, i)] = i < 0 ? '' : par.slice(i + 1);
    }
    return { senal: parseInt(p.slice(1, 3), 16), campos, crudo: p };
  }
  if (p.startsWith('W') || p.startsWith('X')) return { senal: parseInt(p.slice(1, 3), 16) || 0, campos: {}, termino: true, crudo: p };
  return null;
}

interface Pendiente {
  resolver: (r: string) => void;
  rechazar: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface OpcionesGdb {
  host?: string;
  puerto: number;
  /** Tiempo máximo por respuesta. */
  timeoutMs?: number;
}

/**
 * Eventos: 'parada' (ParadaGdb) cuando el chip frena solo (breakpoint) después de un
 * `c`; 'cerrado' cuando se corta la conexión.
 */
export class ClienteGdb extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = '';
  private sinAck = false;
  private pendiente: Pendiente | null = null;
  private cola: Promise<unknown> = Promise.resolve();
  private esperandoParada: { resolver: (p: ParadaGdb) => void; rechazar: (e: Error) => void; timer: NodeJS.Timeout | null } | null = null;
  private ultimoEnviado = '';
  /** Pedidos vencidos cuya respuesta puede llegar tarde (se descarta). */
  private huerfanas = 0;
  /** true entre un `c` y la parada: en ese lapso solo se puede interrumpir. */
  corriendo = false;
  tamPaquete = 4000;

  constructor(private readonly opts: OpcionesGdb) {
    super();
  }

  get conectado(): boolean {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  /** Se conecta; devuelve la parada inicial (el stub de esp-emu frena el chip al aceptar). */
  async conectar(timeoutMs = 3000): Promise<ParadaGdb | null> {
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: this.opts.host ?? '127.0.0.1', port: this.opts.puerto });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new ErrorGdb(`no se pudo conectar al stub GDB en el puerto ${this.opts.puerto}`));
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        s.setNoDelay(true);
        this.socket = s;
        resolve();
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const s = this.socket!;
    s.on('data', (d: Buffer) => this.recibir(d.toString('latin1')));
    s.on('close', () => this.alCerrar());
    s.on('error', () => {
      /* se maneja en close */
    });
    const soportado = await this.pedir('qSupported:swbreak+;hwbreak+');
    const m = /PacketSize=([0-9a-fA-F]+)/.exec(soportado);
    if (m) this.tamPaquete = parseInt(m[1]!, 16);
    if (soportado.includes('QStartNoAckMode+')) {
      const r = await this.pedir('QStartNoAckMode');
      if (r === 'OK') this.sinAck = true;
    }
    const parada = parsearParada(await this.pedir('?'));
    this.corriendo = false;
    return parada;
  }

  private alCerrar(): void {
    this.socket = null;
    this.corriendo = false;
    const err = new ErrorGdb('se cerró la conexión con el stub GDB');
    if (this.pendiente) {
      clearTimeout(this.pendiente.timer);
      this.pendiente.rechazar(err);
      this.pendiente = null;
    }
    if (this.esperandoParada) {
      if (this.esperandoParada.timer) clearTimeout(this.esperandoParada.timer);
      this.esperandoParada.rechazar(err);
      this.esperandoParada = null;
    }
    this.emit('cerrado');
  }

  cerrar(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private escribir(paquete: string): void {
    if (!this.socket || this.socket.destroyed) throw new ErrorGdb('sin conexión con el stub GDB');
    const cuerpo = escapar(paquete);
    this.ultimoEnviado = `$${cuerpo}#${checksum(cuerpo)}`;
    this.socket.write(this.ultimoEnviado, 'latin1');
  }

  private recibir(texto: string): void {
    this.buffer += texto;
    for (;;) {
      // Acks sueltos
      while (this.buffer.startsWith('+') || this.buffer.startsWith('-')) {
        if (this.buffer[0] === '-' && this.ultimoEnviado && this.socket) this.socket.write(this.ultimoEnviado, 'latin1'); // pidió reenvío
        this.buffer = this.buffer.slice(1);
      }
      const ini = this.buffer.indexOf('$');
      if (ini < 0) {
        this.buffer = '';
        return;
      }
      const fin = this.buffer.indexOf('#', ini);
      if (fin < 0 || fin + 3 > this.buffer.length) {
        if (ini > 0) this.buffer = this.buffer.slice(ini);
        return;
      }
      const cuerpo = this.buffer.slice(ini + 1, fin);
      const cs = this.buffer.slice(fin + 1, fin + 3);
      this.buffer = this.buffer.slice(fin + 3);
      if (!this.sinAck && this.socket) {
        if (checksum(cuerpo).toLowerCase() !== cs.toLowerCase()) {
          this.socket.write('-');
          continue;
        }
        this.socket.write('+');
      }
      this.alPaquete(desescapar(cuerpo));
    }
  }

  private alPaquete(p: string): void {
    // Salida de consola del programa (O...): no es respuesta de nada.
    if (p.startsWith('O') && p.length > 1 && /^O[0-9a-fA-F]+$/.test(p)) return;
    const parada = parsearParada(p);
    if (parada && (this.corriendo || this.esperandoParada) && !this.pendiente) {
      this.corriendo = false;
      if (this.esperandoParada) {
        const e = this.esperandoParada;
        this.esperandoParada = null;
        if (e.timer) clearTimeout(e.timer);
        e.resolver(parada);
      } else this.emit('parada', parada);
      return;
    }
    if (this.huerfanas > 0 && !parada) {
      // Respuesta tardía de un pedido que ya se dio por vencido: no es de este pedido.
      this.huerfanas--;
      return;
    }
    if (this.pendiente) {
      const pen = this.pendiente;
      this.pendiente = null;
      clearTimeout(pen.timer);
      pen.resolver(p);
      return;
    }
    if (parada) this.emit('parada', parada);
  }

  /** Manda un paquete y espera la respuesta. Se serializan: uno a la vez. */
  pedir(paquete: string, timeoutMs = this.opts.timeoutMs ?? 3000): Promise<string> {
    const job = this.cola.then(
      () =>
        new Promise<string>((resolver, rechazar) => {
          if (this.corriendo) {
            rechazar(new ErrorGdb('el chip está corriendo: primero hay que frenarlo'));
            return;
          }
          const timer = setTimeout(() => {
            this.pendiente = null;
            this.huerfanas++;
            rechazar(new ErrorGdb(`el stub GDB no respondió a "${paquete.slice(0, 20)}"`));
          }, timeoutMs);
          this.pendiente = { resolver, rechazar, timer };
          try {
            this.escribir(paquete);
          } catch (err) {
            clearTimeout(timer);
            this.pendiente = null;
            rechazar(err as Error);
          }
        }),
    );
    this.cola = job.catch(() => undefined);
    return job;
  }

  private esperarParada(timeoutMs: number | null): Promise<ParadaGdb> {
    return new Promise((resolver, rechazar) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.esperandoParada = null;
        rechazar(new ErrorGdb('el chip no frenó a tiempo'));
      }, timeoutMs);
      this.esperandoParada = { resolver, rechazar, timer };
    });
  }

  /** `c`: sigue corriendo. La próxima parada (breakpoint) llega por el evento 'parada'. */
  async continuar(): Promise<void> {
    await this.cola;
    if (this.corriendo) return;
    this.corriendo = true;
    this.escribir('c');
  }

  /** Ctrl-C: frena el chip y espera la parada (T02). */
  async interrumpir(timeoutMs = 3000): Promise<ParadaGdb> {
    if (!this.corriendo) throw new ErrorGdb('el chip ya está frenado');
    const p = this.esperarParada(timeoutMs);
    this.socket?.write('\x03', 'latin1');
    return p;
  }

  /** `s`: una instrucción. */
  async paso(timeoutMs = 3000): Promise<ParadaGdb> {
    await this.cola;
    if (this.corriendo) throw new ErrorGdb('el chip está corriendo');
    const p = this.esperarParada(timeoutMs);
    this.corriendo = true;
    this.escribir('s');
    return p;
  }

  // --- Memoria y registros -------------------------------------------------------------

  async leerMemoria(dir: number, largo: number): Promise<Buffer> {
    const partes: Buffer[] = [];
    // Cada byte vuelve como 2 caracteres hex; se deja margen para la cabecera del paquete.
    const maxPorPaquete = Math.max(16, Math.floor((this.tamPaquete - 16) / 2));
    for (let off = 0; off < largo; off += maxPorPaquete) {
      const n = Math.min(maxPorPaquete, largo - off);
      const r = await this.pedir(`m${(dir + off).toString(16)},${n.toString(16)}`);
      if (/^E[0-9a-fA-F]{2}$/.test(r)) throw new ErrorGdb(`no se puede leer ${n} bytes en 0x${(dir + off).toString(16)} (${r})`);
      partes.push(Buffer.from(r, 'hex'));
    }
    return Buffer.concat(partes);
  }

  async escribirMemoria(dir: number, datos: Uint8Array): Promise<void> {
    const r = await this.pedir(`M${dir.toString(16)},${datos.length.toString(16)}:${Buffer.from(datos).toString('hex')}`);
    if (r !== 'OK') throw new ErrorGdb(`no se pudo escribir en 0x${dir.toString(16)} (${r})`);
  }

  /** Todos los registros (paquete `g`), en bytes crudos (little-endian, 4 bytes cada uno). */
  async leerRegistros(): Promise<Buffer> {
    const r = await this.pedir('g');
    if (/^E[0-9a-fA-F]{2}$/.test(r)) throw new ErrorGdb(`no se pudieron leer los registros (${r})`);
    return Buffer.from(r, 'hex');
  }

  async leerRegistro(n: number): Promise<number> {
    const r = await this.pedir(`p${n.toString(16)}`);
    if (/^E[0-9a-fA-F]{2}$/.test(r)) throw new ErrorGdb(`registro ${n}: ${r}`);
    return Buffer.from(r.padEnd(8, '0').slice(0, 8), 'hex').readUInt32LE(0);
  }

  async ponerBreakpoint(dir: number, tipo = 0, kind = 4): Promise<boolean> {
    const r = await this.pedir(`Z${tipo},${dir.toString(16)},${kind}`);
    return r === 'OK';
  }

  async quitarBreakpoint(dir: number, tipo = 0, kind = 4): Promise<boolean> {
    const r = await this.pedir(`z${tipo},${dir.toString(16)},${kind}`);
    return r === 'OK';
  }
}
