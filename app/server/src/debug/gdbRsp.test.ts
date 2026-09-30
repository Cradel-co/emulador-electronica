import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checksum, ClienteGdb, desescapar, escapar, parsearParada, type ParadaGdb } from './gdbRsp.js';
import { ArchivoElf } from './elf.js';
import { InfoDwarf } from './dwarf.js';
import { AdaptadorEsp } from './adaptadorEsp.js';
import type { EstadoEjecucion } from './tipos.js';

/**
 * Stub GDB de mentira con el comportamiento que se verificó en esp-emu 0.44:
 * frena el chip al aceptar la conexión, QStartNoAckMode, `g` con el orden de Xtensa
 * (pc, ar0..ar63, ..., windowbase=69, windowstart=70, ps=73; 236 registros), Z0/z0,
 * `c` que frena en un breakpoint (T05swbreak:) o con Ctrl-C (T02), `s`.
 */
class StubFalso {
  readonly server: net.Server;
  puerto = 0;
  memoria = new Map<number, number>();
  regs = Buffer.alloc(236 * 4);
  bps = new Set<number>();
  corriendo = false;
  pedidos: string[] = [];
  /** Adónde "llega" el programa al seguir: si hay breakpoint ahí, frena. */
  proximoPc: number | null = null;
  private socket: net.Socket | null = null;
  private sinAck = false;
  private buf = '';

  constructor(private readonly tamPaquete = 400) {
    this.server = net.createServer((s) => this.atender(s));
  }

  async escuchar(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.puerto = (this.server.address() as net.AddressInfo).port;
  }

  cerrar(): void {
    this.socket?.destroy();
    this.server.close();
  }

  set pc(v: number) {
    this.regs.writeUInt32LE(v, 0);
  }

  get pc(): number {
    return this.regs.readUInt32LE(0);
  }

  cargar(dir: number, datos: Uint8Array): void {
    datos.forEach((b, i) => this.memoria.set(dir + i, b));
  }

  private enviar(p: string): void {
    this.socket?.write(`$${p}#${checksum(p)}`);
  }

  private atender(s: net.Socket): void {
    this.socket = s;
    this.corriendo = false; // frena al conectarse, como esp-emu
    const procesar = (): void => {
      for (;;) {
        this.buf = this.buf.replace(/^[+-]+/, '');
        const m = /^\$([^#]*)#([0-9a-f]{2})/.exec(this.buf);
        if (!m) break;
        this.buf = this.buf.slice(m[0].length);
        if (!this.sinAck) s.write('+');
        this.paquete(desescapar(m[1]!));
      }
    };
    s.on('data', (d) => {
      // En orden: un Ctrl-C que llega pegado a un `c` se atiende después del `c`.
      for (const c of d.toString('latin1')) {
        if (c === '\x03') {
          procesar();
          if (this.corriendo) {
            this.corriendo = false;
            this.enviar('T02');
          }
          continue;
        }
        this.buf += c;
      }
      procesar();
    });
  }

  private paquete(p: string): void {
    this.pedidos.push(p);
    if (p.startsWith('qSupported')) return this.enviar(`PacketSize=${this.tamPaquete.toString(16)};swbreak+;QStartNoAckMode+`);
    if (p === 'QStartNoAckMode') {
      this.enviar('OK');
      this.sinAck = true;
      return;
    }
    if (p === '?') return this.enviar('S05');
    if (p === 'g') return this.enviar(this.regs.toString('hex'));
    if (p.startsWith('p')) {
      const n = parseInt(p.slice(1), 16);
      return this.enviar(n < 236 ? this.regs.subarray(n * 4, n * 4 + 4).toString('hex') : 'E01');
    }
    if (p.startsWith('m')) {
      const [d, l] = p.slice(1).split(',').map((x) => parseInt(x, 16)) as [number, number];
      if (l * 2 + 4 > this.tamPaquete) return this.enviar('E02');
      let out = '';
      for (let i = 0; i < l; i++) {
        const b = this.memoria.get(d + i);
        if (b === undefined) return this.enviar('E14');
        out += b.toString(16).padStart(2, '0');
      }
      return this.enviar(out);
    }
    if (p.startsWith('M')) {
      const [cab, datos] = p.slice(1).split(':') as [string, string];
      const d = parseInt(cab.split(',')[0]!, 16);
      this.cargar(d, Buffer.from(datos, 'hex'));
      return this.enviar('OK');
    }
    if (p.startsWith('Z0,')) {
      this.bps.add(parseInt(p.split(',')[1]!, 16));
      return this.enviar('OK');
    }
    if (p.startsWith('z0,')) {
      this.bps.delete(parseInt(p.split(',')[1]!, 16));
      return this.enviar('OK');
    }
    if (p === 'c') {
      this.corriendo = true;
      const destino = this.proximoPc;
      if (destino !== null && this.bps.has(destino)) {
        setTimeout(() => {
          if (!this.corriendo) return;
          this.corriendo = false;
          this.pc = destino;
          this.enviar('T05swbreak:;');
        }, 30);
      }
      return;
    }
    if (p === 's') {
      this.pc = this.pc + 3;
      return this.enviar('T05');
    }
    this.enviar('');
  }
}

const stubs: StubFalso[] = [];
const clientes: ClienteGdb[] = [];
afterEach(() => {
  for (const c of clientes.splice(0)) c.cerrar();
  for (const s of stubs.splice(0)) s.cerrar();
});

async function nuevoStub(tam?: number): Promise<StubFalso> {
  const s = new StubFalso(tam);
  await s.escuchar();
  stubs.push(s);
  return s;
}

describe('protocolo GDB (paquetes)', () => {
  it('checksum, escapes y run-length', () => {
    expect(checksum('OK')).toBe('9a');
    expect(checksum('')).toBe('00');
    expect(escapar('a$b#c}d*')).toBe('a}\x04b}\x03c}]d}\x0a');
    expect(desescapar(escapar('a$b#c}d*'))).toBe('a$b#c}d*');
    // "0* " = '0' repetido 32-29 = 3 veces más
    expect(desescapar('0* ')).toBe('0000');
  });

  it('respuestas de parada', () => {
    expect(parsearParada('S05')).toMatchObject({ senal: 5 });
    expect(parsearParada('T05swbreak:;thread:1;')).toMatchObject({ senal: 5, campos: { swbreak: '', thread: '1' } });
    expect(parsearParada('T02')).toMatchObject({ senal: 2 });
    expect(parsearParada('W00')).toMatchObject({ termino: true });
    expect(parsearParada('OK')).toBeNull();
  });
});

describe('ClienteGdb contra un stub', () => {
  it('se conecta (sin acks), lee memoria en bloques y registros', async () => {
    const stub = await nuevoStub(64); // paquetes chicos: fuerza a partir la lectura
    stub.cargar(0x3fc80000, Uint8Array.from({ length: 100 }, (_, i) => i));
    stub.pc = 0x40379e66;
    const c = new ClienteGdb({ puerto: stub.puerto });
    clientes.push(c);
    const parada = await c.conectar();
    expect(parada?.senal).toBe(5);
    expect(stub.pedidos).toContain('QStartNoAckMode');
    const mem = await c.leerMemoria(0x3fc80000, 100);
    expect([...mem]).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(stub.pedidos.filter((p) => p.startsWith('m')).length).toBeGreaterThan(3);
    expect(await c.leerRegistro(0)).toBe(0x40379e66);
    expect((await c.leerRegistros()).length).toBe(944);
    await expect(c.leerMemoria(0x10, 4)).rejects.toThrow(/no se puede leer/);
    await c.escribirMemoria(0x3fc80000, Uint8Array.of(9, 9));
    expect([...(await c.leerMemoria(0x3fc80000, 3))]).toEqual([9, 9, 2]);
  });

  it('continuar → breakpoint (evento parada); continuar → Ctrl-C; paso', async () => {
    const stub = await nuevoStub();
    const c = new ClienteGdb({ puerto: stub.puerto });
    clientes.push(c);
    await c.conectar();
    expect(await c.ponerBreakpoint(0x4200eb1d)).toBe(true);
    stub.proximoPc = 0x4200eb1d;
    const llego = new Promise<ParadaGdb>((r) => c.once('parada', r));
    await c.continuar();
    expect(c.corriendo).toBe(true);
    await expect(c.leerRegistro(0)).rejects.toThrow(/corriendo/);
    const p = await llego;
    expect(p).toMatchObject({ senal: 5, campos: { swbreak: '' } });
    expect(await c.leerRegistro(0)).toBe(0x4200eb1d);

    await c.quitarBreakpoint(0x4200eb1d);
    await c.continuar();
    const i = await c.interrumpir();
    expect(i.senal).toBe(2);
    expect(c.corriendo).toBe(false);

    const antes = await c.leerRegistro(0);
    const s = await c.paso();
    expect(s.senal).toBe(5);
    expect(await c.leerRegistro(0)).toBe(antes + 3);
  });
});

describe('AdaptadorEsp contra el stub (con el .elf DWARF 5 de Xtensa)', () => {
  const elf = new ArchivoElf(readFileSync(fileURLToPath(new URL('../fixtures/depuracion/dw5-xtensa.elf', import.meta.url))));
  const sim = { ruta: 'dw5-xtensa.elf', elf, dwarf: new InfoDwarf(elf) };

  async function preparar(): Promise<{ stub: StubFalso; a: AdaptadorEsp; paradas: EstadoEjecucion[]; seguidas: number[] }> {
    const stub = await nuevoStub();
    // La RAM del "chip": el contenido inicial de .data/.rodata del .elf, .bss en cero.
    for (const s of elf.secciones) {
      if (!s.dir || s.tam === 0 || s.tam > 65536) continue;
      stub.cargar(s.dir, s.tipo === 8 ? new Uint8Array(s.tam) : elf.datos.subarray(s.offset, s.offset + s.tam));
    }
    stub.pc = 0x40009a;
    stub.regs.writeUInt32LE(0, 69 * 4); // windowbase
    stub.regs.writeUInt32LE(1, 70 * 4); // windowstart
    stub.regs.writeUInt32LE(0x3fcaf000, 2 * 4); // a1 (sp) = ar1
    const cliente = new ClienteGdb({ puerto: stub.puerto });
    clientes.push(cliente);
    await cliente.conectar();
    const paradas: EstadoEjecucion[] = [];
    const seguidas: number[] = [];
    const a = new AdaptadorEsp(sim, cliente, {
      detenido: (e) => paradas.push(e),
      continuado: () => seguidas.push(Date.now()),
      aviso: () => undefined,
    });
    await a.iniciar(async () => undefined);
    return { stub, a, paradas, seguidas };
  }

  it('lee globales con tipo frenando el chip un instante y lo suelta', async () => {
    const { stub, a } = await preparar();
    await new Promise((r) => setTimeout(r, 30)); // que le llegue el `c`
    expect(stub.corriendo).toBe(true);
    const r = await a.evaluate('estado.pos[1].y + matriz[1][2]');
    expect(r.result).toBe('10');
    // Se frenó (Ctrl-C) y se volvió a soltar (c).
    await new Promise((res) => setTimeout(res, 30));
    expect(stub.corriendo).toBe(true);
    expect(stub.pedidos.slice(-1)).toEqual(['c']);
    expect(a.estado().status).toBe('running');
    const scopes = await a.scopes();
    expect(scopes.map((s) => s.name)).toContain('Registros');
  });

  it('breakpoint por línea → frena ahí, con pila y continuar', async () => {
    const { stub, a, paradas } = await preparar();
    const bps = await a.setBreakpoints(new Map([['dw5.c', [19]]]), []);
    expect(bps[0]).toMatchObject({ verified: true, line: 19, instructionReference: ['0x0040009d'] });
    expect(stub.bps.has(0x40009d)).toBe(true);
    stub.proximoPc = 0x40009d;
    // El stub está corriendo; frena solo en 30 ms.
    for (let i = 0; i < 50 && a.estado().status !== 'stopped'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(a.estado()).toMatchObject({ status: 'stopped', reason: 'breakpoint', line: 19, function: '_start' });
    expect(paradas.at(-1)?.hitBreakpointIds).toEqual([bps[0]!.id]);
    const pila = await a.stackTrace();
    expect(pila[0]).toMatchObject({ name: '_start', line: 19 });
    // Seguir desde arriba de un breakpoint: z0, s, Z0, c (como gdb).
    stub.proximoPc = null;
    await a.control('continue');
    expect(a.estado().status).toBe('running');
    await new Promise((r) => setTimeout(r, 30));
    const ultimos = stub.pedidos.slice(-4);
    expect(ultimos).toEqual(['z0,40009d,4', 's', 'Z0,40009d,4', 'c']);
    // Pausa.
    const e = await a.control('pause');
    expect(e).toMatchObject({ status: 'stopped', reason: 'pause' });
    a.cerrar();
  });
});
