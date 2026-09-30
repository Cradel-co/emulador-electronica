import { avrInstruction } from 'avr8js';
import type { AvrSimulador, RelojAvr } from '../avrSim.js';

/**
 * Depuración del Arduino Uno del lado del emulador (avr8js): vive donde vive la CPU
 * (el worker_thread de avrWorker.ts, o el hilo principal en modo local). Lee la SRAM y
 * los registros directo de avr8js — sin frenar nada: el worker atiende los mensajes
 * entre tramo y tramo de simulación, así que la lectura ya es atómica —, y maneja
 * breakpoints por PC, pausa y paso de a una instrucción.
 *
 * Direcciones como en el .elf de avr-gcc: datos (SRAM/registros de E/S) en
 * 0x800000 + dirección; código (flash) en bytes. avr8js cuenta el PC en palabras de
 * 16 bits: acá se convierte.
 */

export const BASE_DATOS_AVR = 0x800000;

export type PedidoAvr =
  | { op: 'leer'; dir: number; largo: number }
  | { op: 'registros' }
  | { op: 'pausar' }
  | { op: 'continuar'; temporales?: number[] }
  | { op: 'paso' }
  | { op: 'breakpoints'; dirs: number[] }
  | { op: 'estado' };

export interface RegistrosAvr {
  /** PC en bytes (como en el .elf). */
  pc: number;
  sp: number;
  sreg: number;
  r: number[];
  ciclos: number;
}

export type RespuestaAvr =
  | { ok: true; datos?: number[]; registros?: RegistrosAvr; detenido: boolean; pc: number }
  | { ok: false; error: string };

export type EventoAvr = { t: 'detenido'; razon: 'breakpoint' | 'pause' | 'step'; pc: number } | { t: 'continuado' };

export interface AccesoAvr {
  sim(): AvrSimulador | null;
  reloj(): RelojAvr | null;
}

export class ControlDepuracionAvr {
  /** Breakpoints (PC en palabras). */
  private permanentes = new Set<number>();
  /** Breakpoints de un "next"/"step out": se borran en la próxima parada. */
  private temporales = new Set<number>();
  detenido = false;

  constructor(
    private readonly acceso: AccesoAvr,
    private readonly emitir: (e: EventoAvr) => void,
  ) {}

  private aplicar(sim: AvrSimulador | null = this.acceso.sim()): void {
    if (!sim) return;
    const todos = new Set([...this.permanentes, ...this.temporales]);
    sim.puntosDeParada = todos.size > 0 ? todos : null;
  }

  /** Se creó (o se reseteó) la CPU: vuelve a poner los breakpoints; un reset la deja corriendo. */
  alCrearSim(sim: AvrSimulador): void {
    this.temporales.clear();
    this.aplicar(sim);
    if (this.detenido) {
      this.detenido = false;
      this.emitir({ t: 'continuado' });
    }
  }

  /** Después de cada tramo de simulación: ¿frenó en un breakpoint? */
  alTerminarTramo(): void {
    const sim = this.acceso.sim();
    if (!sim || sim.frenadoEn === null) return;
    const pc = sim.frenadoEn;
    sim.frenadoEn = null;
    this.acceso.reloj()?.parar();
    this.detenido = true;
    const razon = this.temporales.has(pc) && !this.permanentes.has(pc) ? 'step' : 'breakpoint';
    this.temporales.clear();
    this.aplicar(sim);
    this.emitir({ t: 'detenido', razon, pc: pc * 2 });
  }

  atender(p: PedidoAvr): RespuestaAvr {
    const sim = this.acceso.sim();
    if (!sim) return { ok: false, error: 'el Arduino no está corriendo' };
    const cpu = sim.cpu;
    const base = { detenido: this.detenido, pc: cpu.pc * 2 };
    switch (p.op) {
      case 'estado':
        return { ok: true, ...base };
      case 'leer': {
        const largo = Math.max(0, Math.min(p.largo, 65536));
        if (p.dir >= BASE_DATOS_AVR) {
          const off = p.dir - BASE_DATOS_AVR;
          if (off < 0 || off >= cpu.data.length) return { ok: false, error: `dirección de datos fuera de la SRAM: 0x${p.dir.toString(16)}` };
          return { ok: true, ...base, datos: [...cpu.data.subarray(off, Math.min(off + largo, cpu.data.length))] };
        }
        // Flash (PROGMEM, tablas const): bytes del programa.
        if (p.dir >= cpu.progBytes.length) return { ok: false, error: `dirección fuera de la flash: 0x${p.dir.toString(16)}` };
        return { ok: true, ...base, datos: [...cpu.progBytes.subarray(p.dir, Math.min(p.dir + largo, cpu.progBytes.length))] };
      }
      case 'registros':
        return {
          ok: true,
          ...base,
          registros: {
            pc: cpu.pc * 2,
            sp: cpu.data[0x5d]! | (cpu.data[0x5e]! << 8),
            sreg: cpu.data[0x5f]!,
            r: [...cpu.data.subarray(0, 32)],
            ciclos: cpu.cycles,
          },
        };
      case 'breakpoints':
        this.permanentes = new Set(p.dirs.map((d) => d >> 1));
        this.aplicar(sim);
        return { ok: true, ...base };
      case 'pausar':
        if (!this.detenido) {
          this.acceso.reloj()?.parar();
          this.detenido = true;
          this.emitir({ t: 'detenido', razon: 'pause', pc: cpu.pc * 2 });
        }
        return { ok: true, ...base, detenido: true };
      case 'continuar':
        if (this.detenido) {
          this.temporales = new Set((p.temporales ?? []).map((d) => d >> 1));
          this.aplicar(sim);
          // La instrucción donde quedó frenado se ejecuta sin volver a frenar ahí.
          sim.saltarParadaEn = cpu.pc;
          this.detenido = false;
          this.emitir({ t: 'continuado' });
          this.acceso.reloj()?.arrancar();
        }
        return { ok: true, ...base, detenido: false };
      case 'paso':
        if (!this.detenido) return { ok: false, error: 'primero hay que pausar' };
        avrInstruction(cpu);
        cpu.tick();
        sim.reportarSalidas();
        this.emitir({ t: 'detenido', razon: 'step', pc: cpu.pc * 2 });
        return { ok: true, detenido: true, pc: cpu.pc * 2 };
    }
  }
}
