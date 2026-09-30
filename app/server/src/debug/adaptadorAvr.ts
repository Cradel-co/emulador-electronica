import type { AvrEmulator } from '../avrEmulator.js';
import { AdaptadorConElf, type MarcoCrudo, type Registros } from './adaptadorC.js';
import { BASE_DATOS_AVR, type PedidoAvr, type RespuestaAvr } from './avrControl.js';
import type { Simbolos } from './simbolos.js';
import type { VariableDwarf } from './dwarf.js';
import type { Memoria } from './valoresC.js';
import { NoSoportado, type Capacidades, type EventosAdaptador, type Scope, type Thread } from './tipos.js';

/** Fin de la SRAM del ATmega328P (RAMEND), en el espacio de datos. */
const RAMEND = 0x8ff;
/** Registros de E/S (PORTB, DDRB, PINB...) en el espacio de datos: 0x20-0xFF. */
const ES_DESDE = BASE_DATOS_AVR + 0x20;
const ES_HASTA = BASE_DATOS_AVR + 0x100;

/**
 * Depurador del Arduino Uno (avr8js). La CPU es nuestra, así que casi todo es exacto:
 * SRAM y registros se leen directo (sin frenar), los breakpoints se chequean contra el
 * PC en cada instrucción (solo si hay alguno puesto) y el paso es de a una instrucción.
 * Lo aproximado: la pila de llamadas (no hay frame pointer; se escanea la pila buscando
 * direcciones de retorno que apunten justo después de un CALL/RCALL/ICALL).
 */
export class AdaptadorAvr extends AdaptadorConElf {
  readonly capacidades: Capacidades = {
    motor: 'avr8js',
    variables: true,
    evaluate: true,
    pause: true,
    lineBreakpoints: true,
    functionBreakpoints: true,
    step: true,
    stackTrace: 'aproximado',
    registros: true,
    memoria: true,
    notas: [
      'Globales, static y registros de E/S (PORTB, DDRB, PINB...) con su tipo, leídos de la SRAM real de avr8js sin frenar el programa.',
      'Variables locales: no (el compilador las deja en registros r0-r31; se ven en "Registros").',
      'Pila de llamadas aproximada: escaneo de la pila buscando direcciones de retorno válidas.',
      'arduino-cli compila con LTO: setup() y loop() quedan dentro de main(). Los breakpoints por línea en sketch.cpp andan; por nombre de función setup/loop, no.',
      'next/stepIn/stepOut son por línea (con breakpoints temporales); si no hay línea conocida, avanza una instrucción.',
    ],
  };

  constructor(
    sim: Simbolos,
    private readonly emu: AvrEmulator,
    eventos: EventosAdaptador,
  ) {
    super(sim, eventos);
    emu.oyenteDepuracion = this.oyente;
  }

  private readonly oyente = (e: import('./avrControl.js').EventoAvr): void => {
    if (e.t === 'detenido') this.alDetenerse(e.pc, e.razon);
    else this.alContinuar();
  };

  private async pedir(p: PedidoAvr): Promise<Extract<RespuestaAvr, { ok: true }>> {
    const r = await this.emu.depurar(p);
    if (!r.ok) throw new NoSoportado(r.error);
    return r;
  }

  /** Sincroniza el estado (por si el adaptador se creó con la CPU ya frenada). */
  async iniciar(): Promise<void> {
    const r = await this.pedir({ op: 'estado' });
    if (r.detenido) this.alDetenerse(r.pc, 'pause');
  }

  protected memoria(): Memoria {
    return {
      tamPuntero: 2,
      // Un puntero del AVR apunta a la SRAM (el espacio de datos empieza en 0x800000 en el .elf).
      desdePuntero: (v) => BASE_DATOS_AVR + (v & 0xffff),
      leer: async (dir, largo) => Uint8Array.from((await this.pedir({ op: 'leer', dir, largo })).datos ?? []),
    };
  }

  /** No hace falta frenar: el worker atiende el pedido entre dos tramos de simulación. */
  protected conDetenido<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  protected async leerRegistros(): Promise<Registros> {
    const r = (await this.pedir({ op: 'registros' })).registros!;
    const banderas = 'ITHSVNZC'
      .split('')
      .filter((_, i) => r.sreg & (0x80 >> i))
      .join('');
    const lista: [string, number][] = [
      ['PC', r.pc],
      ['SP', r.sp],
      ['SREG', r.sreg],
      ...r.r.map((v, i): [string, number] => [`r${i}`, v]),
      // X, Y (frame pointer de avr-gcc), Z: pares de registros.
      ['X', r.r[26]! | (r.r[27]! << 8)],
      ['Y', r.r[28]! | (r.r[29]! << 8)],
      ['Z', r.r[30]! | (r.r[31]! << 8)],
      ['ciclos', r.ciclos],
    ];
    this.ultimasBanderas = banderas;
    return { pc: r.pc, sp: r.sp, lista };
  }

  private ultimasBanderas = '';

  protected async desenrollar(regs: Registros, mem: Memoria): Promise<MarcoCrudo[]> {
    const marcos: MarcoCrudo[] = [{ pc: regs.pc, sp: regs.sp }];
    const desde = regs.sp + 1;
    if (desde > RAMEND) return marcos;
    const pila = await mem.leer(BASE_DATOS_AVR + desde, RAMEND - desde + 1);
    const flash = await mem.leer(0, 0x8000);
    const palabra = (w: number): number => (flash[w * 2] ?? 0) | ((flash[w * 2 + 1] ?? 0) << 8);
    const esLlamada = (ret: number): boolean => {
      if (ret < 2 || ret * 2 >= flash.length) return false;
      const w2 = palabra(ret - 2);
      if ((w2 & 0xfe0e) === 0x940e) return true; // CALL k (32 bits)
      const w1 = palabra(ret - 1);
      return (w1 & 0xf000) === 0xd000 || w1 === 0x9509 || w1 === 0x9519; // RCALL, ICALL, EICALL
    };
    // CALL guarda el retorno (en palabras) con el byte alto más abajo en la pila.
    for (let i = 0; i + 1 < pila.length && marcos.length < 16; i++) {
      const ret = (pila[i]! << 8) | pila[i + 1]!;
      if (!esLlamada(ret)) continue;
      const pc = ret * 2;
      if (!this.nombreFuncion(pc)) continue;
      marcos.push({ pc, sp: desde + i + 1, aproximado: true });
      i++; // los dos bytes ya se usaron
    }
    return marcos;
  }

  protected async sincronizarBreakpoints(dirs: number[]): Promise<void> {
    await this.pedir({ op: 'breakpoints', dirs });
  }

  protected async correr(temporales: number[]): Promise<void> {
    await this.pedir({ op: 'continuar', temporales });
  }

  protected async frenar(): Promise<void> {
    await this.pedir({ op: 'pausar' });
  }

  protected async pasoInstruccion(): Promise<void> {
    await this.pedir({ op: 'paso' });
  }

  async threads(): Promise<Thread[]> {
    return [{ id: 1, name: 'ATmega328P' }];
  }

  /** Los registros de E/S y PROGMEM van aparte; "otras globales" son solo las de RAM. */
  protected esVariableDeDatos(v: VariableDwarf): boolean {
    return v.dir >= ES_HASTA;
  }

  protected globalesDelUsuario(): VariableDwarf[] {
    return super.globalesDelUsuario().filter((v) => v.dir >= ES_HASTA || v.dir < BASE_DATOS_AVR);
  }

  protected alcancesExtra(): Scope[] {
    const vistas = new Set<string>();
    const es = this.variablesDwarf()
      .filter((v) => v.dir >= ES_DESDE && v.dir < ES_HASTA)
      .filter((v) => {
        if (vistas.has(v.nombre)) return false;
        vistas.add(v.nombre);
        return true;
      })
      .sort((a, b) => a.dir - b.dir);
    if (es.length === 0) return [];
    return [
      {
        name: 'Registros de E/S (PORTx, DDRx, PINx, timers...)',
        presentationHint: 'registers',
        variablesReference: this.refs.crear(() => this.leerGlobales(es)),
        expensive: false,
      },
    ];
  }

  async resumen(): Promise<unknown> {
    const base = (await super.resumen()) as Record<string, unknown>;
    const regs = await this.leerRegistros();
    const fila = this.sim.dwarf?.lineaEn(regs.pc);
    return {
      ...base,
      cpu: {
        pc: `0x${regs.pc.toString(16)}`,
        funcion: this.nombreFuncion(regs.pc),
        ...(fila ? { linea: `${fila.archivo.split('/').pop()}:${fila.linea}` } : {}),
        sp: `0x${regs.sp.toString(16)}`,
        sreg: this.ultimasBanderas || '-',
        tiempoSimuladoMs: Math.round(((regs.lista.find(([n]) => n === 'ciclos')?.[1] ?? 0) / 16_000_000) * 1000),
      },
    };
  }

  cerrar(): void {
    if (this.emu.oyenteDepuracion === this.oyente) this.emu.oyenteDepuracion = null;
  }
}
