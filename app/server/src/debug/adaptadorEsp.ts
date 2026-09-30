import { AdaptadorConElf, type MarcoCrudo, type Registros } from './adaptadorC.js';
import type { ClienteGdb, ParadaGdb } from './gdbRsp.js';
import type { Simbolos } from './simbolos.js';
import { FormateadorC, MemoriaConCache, type Memoria } from './valoresC.js';
import { hex, NoSoportado, type Capacidades, type EstadoEjecucion, type EventosAdaptador, type Thread } from './tipos.js';

/** Nombres de los registros x0..x31 de RISC-V (ABI). */
const NOMBRES_RISCV = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
];

/**
 * Orden del paquete `g` de esp-emu para Xtensa (ESP32-S3), verificado contra el stub:
 * pc, ar0..ar63, lbeg, lend, lcount, sar, windowbase, windowstart, configid0/1, ps,
 * threadptr, ... (236 registros de 4 bytes). OJO: el stub anuncia un target.xml de
 * RISC-V aunque el chip sea Xtensa; se decide por el `e_machine` del .elf.
 */
const XT = { pc: 0, ar0: 1, lbeg: 65, lend: 66, lcount: 67, sar: 68, windowbase: 69, windowstart: 70, ps: 73, threadptr: 74 } as const;

const esCodigo = (pc: number): boolean => pc >= 0x40000000 && pc < 0x50000000;

/**
 * Depurador de firmware compilado para ESP32 (ESPHome, ESP-IDF C/C++, Arduino sobre
 * IDF) usando el stub GDB de `esp-emu --gdb`. La app se queda conectada durante toda
 * la corrida (el stub atiende un cliente a la vez y frena el chip al conectarse): así
 * los breakpoints están listos siempre y nadie más de la red puede engancharse.
 *
 * Leer variables con el programa corriendo = frenarlo un instante (Ctrl-C), leer en
 * bloques y soltarlo (`c`): ~100-300 ms de pausa, sin tocar el puente ni la consola.
 */
export class AdaptadorEsp extends AdaptadorConElf {
  readonly capacidades: Capacidades;
  private readonly cliente: ClienteGdb;
  private cola: Promise<unknown> = Promise.resolve();
  private instalados = new Set<number>();
  private temporales = new Set<number>();
  private conectado = false;
  private cerrado = false;
  private readonly arq: 'xtensa' | 'riscv';

  /** `cliente` ya conectado (el Depurador se conecta antes de leer el .elf, con el chip frenado). */
  constructor(
    sim: Simbolos,
    cliente: ClienteGdb,
    eventos: EventosAdaptador,
  ) {
    super(sim, eventos);
    this.arq = sim.elf.arquitectura === 'riscv' ? 'riscv' : 'xtensa';
    this.capacidades = {
      motor: 'esp-gdb',
      variables: true,
      evaluate: true,
      pause: true,
      lineBreakpoints: true,
      functionBreakpoints: true,
      step: true,
      stackTrace: this.arq === 'xtensa' ? 'exacto' : 'aproximado',
      registros: true,
      memoria: true,
      notas: [
        'Stub GDB de esp-emu: leer variables frena el chip un instante (~100-300 ms) y lo suelta; el puente y la consola siguen andando.',
        'Globales y static con su tipo (DWARF del .elf); variables locales: no (hace falta un gdb de Xtensa/RISC-V, que no está instalado).',
        this.arq === 'xtensa'
          ? 'Pila de llamadas: se desenrolla con las ventanas de registros de Xtensa (como esp_backtrace).'
          : 'Pila de llamadas en RISC-V: solo el PC y el registro ra (aproximado: sin CFI).',
        'El stub de esp-emu solo muestra los registros del CPU0. En el ESP32-S3 (2 núcleos) ESPHome y Arduino corren loop() en el CPU1: ' +
          'un breakpoint ahí frena igual y la ubicación se deduce del breakpoint (exacta si hay uno solo activo), pero la pila muestra solo ' +
          'ese lugar, "next" avanza a la línea siguiente en orden y stepOut no se puede. ESP-IDF (app_main) corre en el CPU0: ahí todo es exacto.',
        'Hilos: uno por núcleo, con el nombre de la tarea FreeRTOS que corre en cada uno (pxCurrentTCBs).',
        'esp-emu abre el stub GDB en todas las interfaces (0.0.0.0): la app lo mantiene ocupado mientras corre para que nadie más se conecte.',
      ],
    };
    this.cliente = cliente;
    this.conectado = cliente.conectado;
    this.cliente.on('parada', (p: ParadaGdb) => void this.encolar(() => this.alParadaSola(p)).catch(() => undefined));
    this.cliente.on('cerrado', () => {
      this.conectado = false;
      if (!this.cerrado) {
        this.estadoActual = { status: 'unavailable', description: 'se cortó la conexión con el stub GDB' };
        this.eventos.aviso('[debug] se cortó la conexión con el stub GDB de esp-emu');
      }
    });
    this.estadoActual = { status: 'unavailable', description: 'conectando al stub GDB…' };
  }

  /** Mutex: una operación sobre el stub a la vez. */
  private encolar<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.cola.then(fn);
    this.cola = job.catch(() => undefined);
    return job;
  }

  /**
   * Pone los breakpoints que ya hubiera y deja correr el chip (el stub lo frenó al
   * aceptar la conexión). Pase lo que pase, el chip queda corriendo.
   */
  async iniciar(breakpoints: () => Promise<unknown>): Promise<void> {
    try {
      await breakpoints();
    } finally {
      await this.encolar(async () => {
        if (!this.cliente.conectado) return;
        await this.cliente.continuar();
        this.estadoActual = { status: 'running' };
      });
    }
  }

  private asegurarConexion(): void {
    if (!this.conectado || !this.cliente.conectado) {
      throw new NoSoportado(this.estadoActual.description ?? 'sin conexión con el stub GDB (¿el emulador está corriendo?)');
    }
  }

  private async leerPc(): Promise<number> {
    return this.cliente.leerRegistro(0);
  }

  private async alParadaSola(p: ParadaGdb): Promise<void> {
    if (p.termino) return;
    const pc0 = await this.leerPc();
    const temporales = new Set(this.temporales);
    await this.quitarTemporales();
    await this.detenerAtribuido(pc0, p.senal, temporales);
  }

  /** true si la última parada fue en el CPU1 (ver atribuir). */
  private otroNucleo = false;

  protected pasoSecuencial(): boolean {
    return this.otroNucleo && this.estadoActual.status === 'stopped';
  }

  /**
   * ¿Dónde frenó de verdad? El stub de esp-emu solo muestra los registros del CPU0. En un
   * ESP32-S3 (2 núcleos) ESPHome y Arduino corren su loop en el CPU1: si el chip frenó por
   * un breakpoint (SIGTRAP) y el PC del CPU0 no es ninguno, lo tocó el CPU1 — la ubicación
   * sale del breakpoint (exacta si había uno solo activo).
   */
  private async detenerAtribuido(pc0: number, senal: number, temporales: Set<number>): Promise<void> {
    this.otroNucleo = false;
    if (senal === 2) return this.alDetenerse(pc0, 'pause', { nota: this.arq === 'xtensa' ? 'registros y pila del CPU0' : undefined });
    if (this.dirsBp.has(pc0)) return this.alDetenerse(pc0, 'breakpoint');
    if (temporales.has(pc0)) return this.alDetenerse(pc0, 'step');
    const candidatos = [...new Set([...temporales, ...this.instalados])];
    if (senal === 5 && candidatos.length > 0) {
      this.otroNucleo = true;
      const pc = candidatos[0]!;
      const tarea = await this.tareaDe(1).catch(() => null);
      const donde = candidatos.length === 1 ? '' : ` (uno de ${candidatos.length} breakpoints: ${candidatos.map((d) => this.lugar(d)).join(', ')})`;
      return this.alDetenerse(pc, temporales.has(pc) && !this.dirsBp.has(pc) ? 'step' : 'breakpoint', {
        threadId: 2,
        nota: `en el CPU1${tarea ? ` (tarea "${tarea}")` : ''}${donde}; el stub de esp-emu solo da los registros del CPU0`,
      });
    }
    this.alDetenerse(pc0, 'exception', { nota: `el chip frenó solo (señal ${senal}): ¿excepción o instrucción break?` });
  }

  private lugar(dir: number): string {
    const l = this.sim.dwarf?.lineaEn(dir);
    return l ? `${l.archivo.split('/').pop()}:${l.linea}` : hex(dir);
  }

  private async quitarTemporales(): Promise<void> {
    for (const d of this.temporales) {
      if (!this.instalados.has(d)) await this.cliente.quitarBreakpoint(d).catch(() => false);
    }
    this.temporales.clear();
  }

  protected conDetenido<T>(fn: () => Promise<T>): Promise<T> {
    return this.encolar(async () => {
      this.asegurarConexion();
      if (!this.cliente.corriendo) return fn();
      const p = await this.cliente.interrumpir();
      const pc = await this.leerPc();
      // Si justo coincidió con un breakpoint, se queda frenado ahí (como corresponde).
      // Si justo coincidió con un breakpoint (en cualquier núcleo), se queda frenado ahí.
      if (p.senal === 5 && (this.instalados.size > 0 || this.temporales.size > 0)) {
        const r = await fn();
        const temporales = new Set(this.temporales);
        await this.quitarTemporales();
        await this.detenerAtribuido(pc, 5, temporales);
        return r;
      }
      try {
        return await fn();
      } finally {
        await this.cliente.continuar();
      }
    });
  }

  protected memoria(): Memoria {
    return {
      tamPuntero: 4,
      desdePuntero: (v) => v >>> 0,
      leer: async (dir, largo) => new Uint8Array(await this.cliente.leerMemoria(dir, largo)),
    };
  }

  protected async leerRegistros(): Promise<Registros> {
    const b = await this.cliente.leerRegistros();
    const r = (i: number): number => (i * 4 + 4 <= b.length ? b.readUInt32LE(i * 4) : 0);
    if (this.arq === 'riscv') {
      const lista: [string, number][] = [['pc', r(32)], ...NOMBRES_RISCV.map((n, i): [string, number] => [n, r(i)])];
      return { pc: r(32), sp: r(2), lista };
    }
    const wb = r(XT.windowbase) & 15;
    const a = (i: number): number => r(XT.ar0 + ((wb * 4 + i) & 63));
    const lista: [string, number][] = [
      ['pc', r(XT.pc)],
      ...Array.from({ length: 16 }, (_, i): [string, number] => [`a${i}`, a(i)]),
      ['ps', r(XT.ps)],
      ['sar', r(XT.sar)],
      ['windowbase', r(XT.windowbase)],
      ['windowstart', r(XT.windowstart)],
      ['lbeg', r(XT.lbeg)],
      ['lend', r(XT.lend)],
      ['lcount', r(XT.lcount)],
      ...Array.from({ length: 64 }, (_, i): [string, number] => [`ar${i}`, r(XT.ar0 + i)]),
    ];
    this.ultimosRegistros = b;
    return { pc: r(XT.pc), sp: a(1), lista };
  }

  private ultimosRegistros: Buffer | null = null;

  protected async desenrollar(regs: Registros, mem: Memoria): Promise<MarcoCrudo[]> {
    // Frenó el CPU1: sus registros no se ven; queda solo el lugar del breakpoint.
    if (this.otroNucleo && this.estadoActual.status === 'stopped') return [{ pc: parseInt(this.estadoActual.pc ?? '0', 16), aproximado: true }];
    if (this.arq === 'riscv') {
      const ra = regs.lista.find(([n]) => n === 'ra')?.[1] ?? 0;
      const marcos: MarcoCrudo[] = [{ pc: regs.pc, sp: regs.sp }];
      if (esCodigo(ra) && ra !== regs.pc) marcos.push({ pc: ra, aproximado: true });
      return marcos;
    }
    const b = this.ultimosRegistros;
    if (!b) return [{ pc: regs.pc, sp: regs.sp }];
    const r = (i: number): number => b.readUInt32LE(i * 4);
    const ar = (i: number): number => r(XT.ar0 + (i & 63));
    const ws = r(XT.windowstart);
    let wb = r(XT.windowbase) & 15;
    let pc = regs.pc;
    let sp = regs.sp;
    let ra = ar(wb * 4);
    let enRegistros = true;
    const marcos: MarcoCrudo[] = [{ pc, sp }];
    for (let n = 0; n < 48; n++) {
      // Los 2 bits altos de a0 dicen con qué call (4/8/12) se llamó: cuántas ventanas rotó.
      const callinc = ra >>> 30;
      if (callinc === 0 || ra === 0) break;
      const pcLlamador = ((ra & 0x3fffffff) | (pc & 0xc0000000)) >>> 0;
      let raLlamador: number;
      let spLlamador: number;
      const wbLlamador = (wb - callinc) & 15;
      if (enRegistros && (ws >> wbLlamador) & 1 && wbLlamador !== (r(XT.windowbase) & 15)) {
        // La ventana del que llamó sigue viva en los registros físicos.
        raLlamador = ar(wbLlamador * 4);
        spLlamador = ar(wbLlamador * 4 + 1);
        wb = wbLlamador;
      } else {
        // Ya volcada a la pila: a0/a1 del que llamó están en el "base save area", 16 bytes bajo este sp.
        enRegistros = false;
        try {
          const bsa = await mem.leer(sp - 16, 8);
          const dv = new DataView(bsa.buffer, bsa.byteOffset, 8);
          raLlamador = dv.getUint32(0, true);
          spLlamador = dv.getUint32(4, true);
        } catch {
          marcos.push({ pc: pcLlamador, aproximado: true });
          break;
        }
      }
      if (!esCodigo(pcLlamador)) break;
      marcos.push({ pc: pcLlamador, sp: spLlamador });
      if (spLlamador === 0 || spLlamador <= sp) break;
      pc = pcLlamador;
      sp = spLlamador;
      ra = raLlamador;
    }
    return marcos;
  }

  protected async sincronizarBreakpoints(dirs: number[]): Promise<void> {
    await this.conDetenido(() => this.aplicarBreakpoints(new Set(dirs)));
  }

  private async aplicarBreakpoints(quiero: Set<number>): Promise<void> {
    for (const d of this.instalados) {
      if (!quiero.has(d)) await this.cliente.quitarBreakpoint(d).catch(() => false);
    }
    const fallidos: number[] = [];
    for (const d of quiero) {
      if (this.instalados.has(d)) continue;
      if (!(await this.cliente.ponerBreakpoint(d).catch(() => false))) fallidos.push(d);
    }
    this.instalados = new Set([...quiero].filter((d) => !fallidos.includes(d)));
    if (fallidos.length) this.eventos.aviso(`[debug] el stub no aceptó breakpoints en ${fallidos.map((d) => hex(d)).join(', ')}`);
  }

  protected async correr(temporales: number[]): Promise<void> {
    await this.encolar(async () => {
      this.asegurarConexion();
      if (this.cliente.corriendo) return;
      const pc = await this.leerPc();
      // Salir de arriba de un breakpoint del CPU0: se quita, un paso, y se vuelve a poner (como gdb).
      if (this.instalados.has(pc)) {
        await this.cliente.quitarBreakpoint(pc);
        await this.cliente.paso();
        await this.cliente.ponerBreakpoint(pc);
      }
      // Frenado en el CPU1 sobre un breakpoint: `s` solo mueve el CPU0 (verificado), así que se
      // quita el breakpoint, se suelta el chip un instante para que el CPU1 lo pase, y se vuelve a poner.
      const enCpu1 = this.otroNucleo ? parseInt(this.estadoActual.pc ?? '0', 16) : null;
      const saltar = enCpu1 !== null && this.instalados.has(enCpu1) ? enCpu1 : null;
      for (const d of temporales) {
        if (this.instalados.has(d) || d === pc || d === enCpu1) continue;
        if (await this.cliente.ponerBreakpoint(d).catch(() => false)) this.temporales.add(d);
      }
      this.otroNucleo = false;
      if (saltar !== null) {
        await this.cliente.quitarBreakpoint(saltar);
        await this.cliente.continuar();
        this.alContinuar();
        await new Promise((r) => setTimeout(r, 60));
        if (!this.cliente.corriendo) {
          // Frenó en otro breakpoint mientras tanto: se vuelve a poner y lo atiende alParadaSola.
          await this.cliente.ponerBreakpoint(saltar);
          return;
        }
        const p = await this.cliente.interrumpir();
        await this.cliente.ponerBreakpoint(saltar);
        if (p.senal === 5) {
          const temps = new Set(this.temporales);
          await this.quitarTemporales();
          await this.detenerAtribuido(await this.leerPc(), 5, temps);
          return;
        }
        await this.cliente.continuar();
        return;
      }
      await this.cliente.continuar();
      this.alContinuar();
    });
  }

  protected async frenar(): Promise<void> {
    await this.encolar(async () => {
      this.asegurarConexion();
      if (!this.cliente.corriendo) return;
      const p = await this.cliente.interrumpir();
      const pc = await this.leerPc();
      const temporales = new Set(this.temporales);
      await this.quitarTemporales();
      await this.detenerAtribuido(pc, p.senal, temporales);
    });
  }

  protected async pasoInstruccion(): Promise<void> {
    await this.encolar(async () => {
      this.asegurarConexion();
      const pc = await this.leerPc();
      const habia = this.instalados.has(pc);
      if (habia) await this.cliente.quitarBreakpoint(pc);
      await this.cliente.paso();
      if (habia) await this.cliente.ponerBreakpoint(pc);
      this.otroNucleo = false;
      this.alDetenerse(await this.leerPc(), 'step', { nota: 'una instrucción del CPU0' });
    });
  }

  estado(): EstadoEjecucion {
    return { ...this.estadoActual };
  }

  /** Nombre de la tarea FreeRTOS que corre en un núcleo (pxCurrentTCBs[n] o pxCurrentTCB). */
  private async tareaDe(nucleo: number): Promise<string | null> {
    const dw = this.sim.dwarf;
    if (!dw) return null;
    const exprs = nucleo === 0 ? ['pxCurrentTCBs[0]->pcTaskName', 'pxCurrentTCB->pcTaskName'] : [`pxCurrentTCBs[${nucleo}]->pcTaskName`];
    for (const expr of exprs) {
      try {
        // Se lee con el chip ya frenado (lo llama quien ya tiene el stub), sin pasar por la cola.
        const r = await new FormateadorC(dw, new MemoriaConCache(this.memoria()), this.refs).evaluar(expr, (n) => this.buscarVariable(n));
        return r.result.replace(/^"|"$/g, '');
      } catch {
        /* ese nombre no existe en esta versión de FreeRTOS, o ese núcleo no existe */
      }
    }
    return null;
  }

  /** Un hilo por núcleo, con la tarea FreeRTOS que está corriendo en cada uno. */
  async threads(): Promise<Thread[]> {
    if (!this.sim.dwarf || !this.conectado) return [{ id: 1, name: 'CPU0' }];
    const [t0, t1] = await this.conDetenido(async () => [await this.tareaDe(0), this.arq === 'xtensa' ? await this.tareaDe(1) : null]);
    const hilos: Thread[] = [{ id: 1, name: t0 ? `CPU0 · tarea "${t0}"` : 'CPU0' }];
    if (t1) hilos.push({ id: 2, name: `CPU1 · tarea "${t1}" (sin registros: el stub solo muestra el CPU0)` });
    return hilos;
  }

  cerrar(): void {
    this.cerrado = true;
    this.cliente.cerrar();
  }
}
