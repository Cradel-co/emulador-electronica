import path from 'node:path';
import type { FirmwareMessage, ModuleDef, Project } from '@emu/shared';
import { BOARD_MODULE_ID, nombreDePin } from '@emu/shared';
import type { BuildArtifacts, BuildResult } from '../buildService.js';
import type { EmulatorStatus } from '../emulator.js';
import type { Emulador } from '../emulatorBackend.js';
import type { ModuloCatalogo } from '../catalog.js';
import { analizarCircuito, type DireccionPin } from '../sim/analisis.js';
import { conPlaca, gpioDe } from '../diagramOps.js';
import { stripAnsi } from '../logParser.js';
import { AdaptadorAvr } from './adaptadorAvr.js';
import { AdaptadorEsp } from './adaptadorEsp.js';
import { AdaptadorMicropython, type CanalPuente } from './adaptadorMicropython.js';
import { DetectorErrores, type ErrorDetectado } from './errores.js';
import { ClienteGdb } from './gdbRsp.js';
import { Grabadora, type EventoTraza, type TipoEvento } from './grabadora.js';
import { cargarSimbolos, type Simbolos } from './simbolos.js';
import {
  NoSoportado,
  type AccionControl,
  type AdaptadorDepuracion,
  type Breakpoint,
  type Capacidades,
  type EstadoEjecucion,
  type EventosAdaptador,
  type PedidoBreakpoints,
  type ResultadoEvaluacion,
  type Scope,
  type StackFrame,
  type Thread,
  type Variable,
} from './tipos.js';

/**
 * El modo debug, siempre prendido. Junta:
 *  - la grabadora (todo lo que pasó en la corrida, con tiempo),
 *  - el detector de errores (tracebacks, pánicos, aborts),
 *  - un adaptador por motor para leer el estado del firmware (MicroPython por el
 *    puente, AVR sobre avr8js, ESP32 por el stub GDB de esp-emu),
 *  - la instantánea: todo el estado en un JSON pensado para que lo lea una IA.
 *
 * index.ts le avisa lo que pasa (logs, estados, pines, compilaciones) con los métodos
 * `al*`; la API REST (/api/debug, rutas.ts) y el MCP (mcpDepuracion.ts) le preguntan.
 */

export interface DependenciasDepurador {
  /** Evento para el WebSocket (broadcast). */
  emitir: (evento: { type: string } & Record<string, unknown>) => void;
  emulador: () => Emulador;
  catalogo: () => Promise<ModuloCatalogo[]>;
  leerProyecto: (nombre: string) => Promise<Project>;
  /** Cómo configura el programa cada pin (leído de su código), para el motor eléctrico. */
  direcciones?: (nombre: string) => Promise<Map<number, DireccionPin>>;
  boardId?: string;
  nivelesPorPlaca?: () => Map<string, Map<number, 0 | 1>>;
}

export interface CorridaDepuracion {
  proyecto: string;
  placa: string;
  lenguaje: string;
  motor: string;
  artefactos: BuildArtifacts;
}

const CAPACIDADES_NINGUNA: Capacidades = {
  motor: 'ninguno',
  variables: false,
  evaluate: false,
  pause: false,
  lineBreakpoints: false,
  functionBreakpoints: false,
  step: false,
  stackTrace: 'no',
  registros: false,
  memoria: false,
  notas: ['No hay nada corriendo con depurador: ejecutá el proyecto. La grabadora y la instantánea funcionan igual.'],
};

/** Cada cuánto se manda por WebSocket lo nuevo de la grabadora (debug.trace). */
const TRAZA_WS_MS = 250;
const TRAZA_WS_MAX = 300;

export class Depurador {
  readonly grabadora = new Grabadora();
  private readonly detector: DetectorErrores;
  private adaptador: AdaptadorDepuracion | null = null;
  private corrida: CorridaDepuracion | null = null;
  private simbolos: Simbolos | null = null;
  private motivoSinAdaptador = 'no hay nada corriendo';
  private ultimaCompilacion: { proyecto: string; t: string; ok: boolean; durationMs: number; errores: unknown[] } | null = null;
  private ultimoEstadoEmu: string | null = null;
  private ultimoTraceback: ErrorDetectado | null = null;
  /** Breakpoints por proyecto: se aplican solos cada vez que arranca. */
  private readonly breakpoints = new Map<string, { lineas: Map<string, number[]>; funciones: string[] }>();
  private ultimosBreakpoints: Breakpoint[] = [];
  private proyectoCache: { p: Project; buscar: (t: string) => ModuleDef | undefined; direcciones?: Map<number, DireccionPin> } | null = null;
  private avisosElectricos = new Set<string>();
  private estadoLeds = new Map<string, string>();
  private timerElectrico: NodeJS.Timeout | null = null;
  private timerTraza: NodeJS.Timeout | null = null;
  private seqTrazaEnviada = 0;
  private dejarDeEscucharPuente: (() => void) | null = null;
  /** ESPHome: mapa de líneas main.sim.yaml → main.yaml de la última compilación, por proyecto. */
  private readonly mapasYaml = new Map<string, { toSource: (n: number) => number | null }>();

  constructor(private readonly deps: DependenciasDepurador) {
    this.detector = new DetectorErrores((e) => this.alError(e));
  }

  // --- Avisos desde index.ts ------------------------------------------------------------

  /** Antes de arrancar el emulador: corrida nueva (la grabadora vuelve a 0). */
  alIniciarCorrida(c: CorridaDepuracion): void {
    this.cerrarAdaptador();
    this.detector.cerrarBloque();
    this.corrida = c;
    this.simbolos = null;
    this.ultimoTraceback = null;
    this.avisosElectricos.clear();
    this.estadoLeds.clear();
    this.ultimoEstadoEmu = null;
    this.grabadora.reiniciar({ proyecto: c.proyecto, placa: c.placa, lenguaje: c.lenguaje, motor: c.motor });
    this.seqTrazaEnviada = this.grabadora.totalEventos;
    const comp = this.ultimaCompilacion;
    if (comp && comp.proyecto === c.proyecto) {
      this.grabadora.registrar('compilacion', { ok: comp.ok, durationMs: comp.durationMs, errores: comp.errores, nota: 'compilación previa al arranque' });
    }
    this.grabadora.registrar('app', { mensaje: `corrida nueva: ${c.proyecto} (${c.placa}, ${c.lenguaje}, motor ${c.motor})` });
    this.motivoSinAdaptador = 'arrancando…';
    void this.cargarProyecto(c.proyecto);
  }

  private async cargarProyecto(nombre: string): Promise<void> {
    try {
      const [p, catalogo, direcciones] = await Promise.all([
        this.deps.leerProyecto(nombre), this.deps.catalogo(), this.deps.direcciones?.(nombre),
      ]);
      const mapa = new Map(catalogo.map((m) => [m.type, m]));
      this.proyectoCache = { p: conPlaca(p), buscar: (t) => mapa.get(t), direcciones };
      void this.revisarElectrico();
    } catch {
      this.proyectoCache = null;
    }
  }

  /** El emulador ya arrancó: se engancha el depurador que corresponda al motor. */
  async alArrancado(): Promise<void> {
    const c = this.corrida;
    if (!c) return;
    const emu = this.deps.emulador();
    const eventos = this.eventosAdaptador();
    try {
      if (c.artefactos.needsRepl) {
        const puente = (emu.getBridge() as unknown as Partial<CanalPuente> | null) ?? null;
        if (!puente || typeof puente.enviarLinea !== 'function' || typeof puente.escucharLineas !== 'function') {
          this.motivoSinAdaptador = 'el puente de MicroPython no expone el canal de depuración';
          return;
        }
        this.engancharTrazaPuente(puente as CanalPuente);
        this.adaptador = new AdaptadorMicropython(puente as CanalPuente, () => this.ultimoTraceback, () => this.deps.emulador().getStatus().state === 'bridge');
        this.aplicarBreakpointsGuardados().catch(() => undefined);
        return;
      }
      const elf = c.artefactos.elf;
      if (!elf) {
        this.motivoSinAdaptador = 'el toolchain no dejó un .elf: sin símbolos no se pueden leer variables';
        return;
      }
      if (c.motor === 'avr8js') {
        const avr = emu as unknown as import('../avrEmulator.js').AvrEmulator;
        if (typeof avr.depurar !== 'function') {
          this.motivoSinAdaptador = 'el emulador AVR no tiene canal de depuración';
          return;
        }
        this.simbolos = await cargarSimbolos(elf);
        this.ponerResolvedor();
        if (this.corrida !== c) return;
        const a = new AdaptadorAvr(this.simbolos, avr, eventos);
        this.adaptador = a;
        await a.iniciar().catch(() => undefined);
        await this.aplicarBreakpointsGuardados();
        return;
      }
      if (c.motor === 'esp-emu') {
        const puerto = (emu as unknown as { getGdbPort?: () => number | null }).getGdbPort?.() ?? null;
        const puente = emu.getBridge() as unknown as Partial<CanalPuente> | null;
        if (puente && typeof puente.escucharLineas === 'function') this.engancharTrazaPuente(puente as CanalPuente);
        if (!puerto) {
          this.motivoSinAdaptador = 'esp-emu arrancó sin stub GDB (EMU_DEBUG_GDB=0 o falta el .elf)';
          this.simbolos = await cargarSimbolos(elf).catch(() => null);
          this.ponerResolvedor();
          return;
        }
        // Primero se conecta (el stub frena el chip al aceptar): así, mientras se leen los
        // símbolos, el firmware no avanza y los breakpoints quedan puestos antes de setup().
        const cliente = new ClienteGdb({ puerto, timeoutMs: 3000 });
        let conectado = false;
        for (const espera of [0, 100, 200, 400, 800, 1500]) {
          if (espera) await new Promise((r) => setTimeout(r, espera));
          if (this.corrida !== c) return;
          try {
            await cliente.conectar(2000);
            conectado = true;
            break;
          } catch {
            /* esp-emu todavía no abrió el puerto */
          }
        }
        if (!conectado) {
          this.motivoSinAdaptador = `no se pudo conectar al stub GDB de esp-emu (puerto ${puerto})`;
          return;
        }
        try {
          this.simbolos = await cargarSimbolos(elf);
          this.ponerResolvedor();
        } catch (err) {
          await cliente.continuar().catch(() => undefined);
          cliente.cerrar();
          this.motivoSinAdaptador = `no se pudo leer el .elf: ${(err as Error).message}`;
          return;
        }
        if (this.corrida !== c) {
          cliente.cerrar();
          return;
        }
        const a = new AdaptadorEsp(this.simbolos, cliente, eventos);
        this.adaptador = a;
        await a.iniciar(() => this.aplicarBreakpointsGuardados());
        return;
      }
      this.motivoSinAdaptador = `el motor "${c.motor}" todavía no tiene depurador`;
    } catch (err) {
      this.motivoSinAdaptador = `no se pudo enganchar el depurador: ${(err as Error).message}`;
      this.grabadora.registrar('debug', { evento: 'error', mensaje: this.motivoSinAdaptador });
    }
  }

  /** Traduce direcciones de los backtraces a función/archivo:línea. */
  private ponerResolvedor(): void {
    const s = this.simbolos;
    if (!s) return;
    this.detector.ponerResolvedor((pc) => {
      const f = s.dwarf?.funcionEn(pc)?.nombre ?? s.elf.funcionEn(pc)?.legible;
      const l = s.dwarf?.lineaEn(pc);
      if (!f && !l) return null;
      return { ...(f ? { funcion: f } : {}), ...(l ? { archivo: l.archivo, linea: l.linea } : {}) };
    });
  }

  /** Líneas crudas del puente (en los dos sentidos) a la grabadora, salvo las del propio depurador. */
  private engancharTrazaPuente(canal: CanalPuente): void {
    this.dejarDeEscucharPuente?.();
    const b = canal as CanalPuente & { escucharEnvios?: (fn: (l: string) => void) => () => void };
    const quitar1 = canal.escucharLineas((l) => {
      if (l.startsWith('@VARS ') || l.startsWith('@OUT ')) return; // @OUT ya se registra como cambio de pin
      if (l.startsWith('@')) this.grabadora.registrar('puente', { direccion: 'fw→app', linea: l });
    });
    const quitar2 = b.escucharEnvios?.((l) => {
      if (l.startsWith('@DUMP') || l.startsWith('@EVAL')) return;
      this.grabadora.registrar('puente', { direccion: 'app→fw', linea: l });
    });
    this.dejarDeEscucharPuente = () => {
      quitar1();
      quitar2?.();
    };
  }

  alLog(linea: string): void {
    if (!this.corrida) return;
    if (linea.startsWith('[bridge] ')) return; // ya se registra por el puente
    const limpia = stripAnsi(linea);
    const deLaApp = /^(\[emu\]|\[avr\]|\[debug\]|\$ )/.test(limpia);
    if (deLaApp) {
      if (!/^\[emu\] estado:/.test(limpia)) this.grabadora.registrar('app', { mensaje: limpia });
      return;
    }
    this.grabadora.registrar('serial', { linea: limpia });
    this.detector.linea(limpia, this.grabadora.ahora());
    this.programarTraza();
  }

  alEstado(status: EmulatorStatus): void {
    if (status.state !== this.ultimoEstadoEmu) {
      this.ultimoEstadoEmu = status.state;
      if (this.corrida) this.grabadora.registrar('estado', { estado: status.state, ...(status.exitInfo && status.state === 'stopped' ? { salida: status.exitInfo } : {}) });
      this.programarTraza();
    }
    if (!status.running) {
      this.detector.cerrarBloque();
      if (this.adaptador) {
        this.cerrarAdaptador();
        this.motivoSinAdaptador = 'el emulador se detuvo';
      }
    }
  }

  alMensajePuente(msg: FirmwareMessage): void {
    if (!this.corrida) return;
    if (msg.type === 'OUT') {
      if (this.grabadora.pin(msg.pin, msg.level, 'salida', 'firmware')) this.programarElectrico();
    } else if (msg.type === 'READY' && msg.esphomeVersion === 'avr8js') {
      this.grabadora.registrar('puente', { direccion: 'fw→app', linea: '@READY (avr8js: pines nativos)' });
    }
  }

  /** La app puso un nivel en una entrada (botón de la UI, MCP...). */
  alEntrada(pin: number, nivel: 0 | 1, origen: string): void {
    if (!this.corrida) return;
    if (this.grabadora.pin(pin, nivel, 'entrada', origen)) this.programarTraza();
  }

  alCompilacion(proyecto: string, r: BuildResult): void {
    const errores = r.errors.slice(0, 20).map((e) => ({ ...(e.file ? { archivo: e.file } : {}), ...(e.line ? { linea: e.line } : {}), mensaje: e.message }));
    this.ultimaCompilacion = { proyecto, t: new Date().toISOString(), ok: r.ok, durationMs: r.durationMs, errores };
    if (r.lineMap) this.mapasYaml.set(proyecto, r.lineMap);
    if (this.corrida?.proyecto === proyecto) this.grabadora.registrar('compilacion', { ok: r.ok, durationMs: r.durationMs, errores });
    // Se indexa el .elf en segundo plano: cuando arranque, los símbolos ya están listos.
    if (r.ok && r.artifacts?.elf) void cargarSimbolos(r.artifacts.elf).catch(() => undefined);
  }

  private alError(e: ErrorDetectado): void {
    if (e.tipo === 'traceback') this.ultimoTraceback = e;
    const { tipo, t, ...resto } = e;
    this.grabadora.registrar('error', { tipoError: tipo, tError: t, ...resto });
    if (e.tipo !== 'error-log') this.deps.emitir({ type: 'debug.exception', error: e as unknown as Record<string, unknown> });
    this.programarTraza();
  }

  // --- Eléctrico ----------------------------------------------------------------------------

  private programarElectrico(): void {
    this.programarTraza();
    if (this.timerElectrico) return;
    this.timerElectrico = setTimeout(() => {
      this.timerElectrico = null;
      void this.revisarElectrico();
    }, 200);
    this.timerElectrico.unref?.();
  }

  private nivelesActuales(): Map<number, 0 | 1> {
    const niveles = this.grabadora.nivelesSalida();
    const pc = this.proyectoCache;
    // En una corrida, una salida que el firmware nunca reportó está en 0 (los pines arrancan
    // así), no en el "peor caso" que usa el chequeo antes de ejecutar.
    if (pc && this.corrida) {
      for (const inst of pc.p.modules) {
        const def = pc.buscar(inst.type);
        if (def?.bridge?.role !== 'output') continue;
        const g = gpioDe(pc.p, inst.id, def.bridge.pin, pc.buscar, this.deps.boardId ?? BOARD_MODULE_ID);
        if (g !== null && !niveles.has(g)) niveles.set(g, 0);
      }
    }
    return niveles;
  }

  private async revisarElectrico(): Promise<void> {
    const pc = this.proyectoCache;
    if (!pc || !this.corrida) return;
    try {
      const { avisos, leds } = await analizarCircuito(pc.p, pc.buscar, { niveles: this.nivelesActuales(), nivelesPorPlaca: this.deps.nivelesPorPlaca?.(), direcciones: pc.direcciones });
      for (const a of avisos) {
        if (this.avisosElectricos.has(a.mensaje)) continue;
        this.avisosElectricos.add(a.mensaje);
        this.grabadora.registrar('electrico', { severidad: a.severidad, pin: a.pin, mensaje: a.mensaje });
      }
      for (const l of leds) {
        const antes = this.estadoLeds.get(l.id);
        if (antes === l.estado) continue;
        this.estadoLeds.set(l.id, l.estado);
        if (antes !== undefined || l.estado !== 'ok') this.grabadora.registrar('led', { id: l.id, estado: l.estado, mA: l.mA });
      }
    } catch {
      /* un circuito a medio armar no rompe la grabadora */
    }
  }

  // --- WebSocket ------------------------------------------------------------------------------

  private programarTraza(): void {
    if (this.timerTraza) return;
    this.timerTraza = setTimeout(() => {
      this.timerTraza = null;
      const r = this.grabadora.desde(this.seqTrazaEnviada, { limite: TRAZA_WS_MAX });
      if (r.eventos.length === 0) return;
      this.seqTrazaEnviada = r.ultimoSeq;
      this.deps.emitir({ type: 'debug.trace', eventos: r.eventos as unknown as Record<string, unknown>[], ultimoSeq: r.ultimoSeq });
    }, TRAZA_WS_MS);
    this.timerTraza.unref?.();
  }

  private eventosAdaptador(): EventosAdaptador {
    return {
      detenido: (crudo) => {
        const e = this.desdeSim(crudo);
        this.grabadora.registrar('debug', { evento: 'detenido', razon: e.reason, pc: e.pc, funcion: e.function, linea: e.line, archivo: e.source?.name });
        this.deps.emitir({ type: 'debug.stopped', ...(e as unknown as Record<string, unknown>) });
        const st = this.deps.emulador().getStatus();
        this.deps.emitir({ type: 'emu.state', state: st.state, status: { ...st, paused: true } });
        this.programarTraza();
      },
      continuado: () => {
        this.grabadora.registrar('debug', { evento: 'continuado' });
        this.deps.emitir({ type: 'debug.continued', threadId: 1, allThreadsContinued: true });
        const st = this.deps.emulador().getStatus();
        this.deps.emitir({ type: 'emu.state', state: st.state, status: { ...st, paused: false } });
        this.programarTraza();
      },
      aviso: (m) => this.grabadora.registrar('debug', { evento: 'aviso', mensaje: m }),
    };
  }

  private cerrarAdaptador(): void {
    const a = this.adaptador;
    this.adaptador = null;
    this.ultimosBreakpoints = []; // vuelven a "pendientes": se ponen en la próxima corrida
    this.dejarDeEscucharPuente?.();
    this.dejarDeEscucharPuente = null;
    if (!a) return;
    const estaba = a.estado().status === 'stopped';
    a.cerrar();
    if (estaba) this.deps.emitir({ type: 'debug.continued', threadId: 1, allThreadsContinued: true });
  }

  // --- Consultas ------------------------------------------------------------------------------

  pausado(): boolean {
    return this.adaptador?.estado().status === 'stopped';
  }

  private requerir(): AdaptadorDepuracion {
    if (!this.adaptador) throw new NoSoportado(`Depurador no disponible: ${this.motivoSinAdaptador}.`);
    return this.adaptador;
  }

  capacidades(): Capacidades {
    return this.adaptador?.capacidades ?? { ...CAPACIDADES_NINGUNA, notas: [`Sin depurador: ${this.motivoSinAdaptador}.`, ...CAPACIDADES_NINGUNA.notas] };
  }

  estadoEjecucion(): EstadoEjecucion {
    return this.adaptador ? this.desdeSim(this.adaptador.estado()) : { status: 'unavailable', description: this.motivoSinAdaptador };
  }

  // --- ESPHome: las lambdas del YAML compilan con `#line N "main.sim.yaml"` ----------------------
  // El usuario ve y edita main.yaml: los breakpoints se piden en main.yaml y se traducen a
  // main.sim.yaml (el YAML que compila la app); las paradas se muestran de vuelta en main.yaml.

  private mapaYaml(): { toSource: (n: number) => number | null } | null {
    const p = this.corrida?.proyecto;
    return p ? (this.mapasYaml.get(p) ?? null) : null;
  }

  /** main.sim.yaml:N → main.yaml:M en cualquier cosa con source/line (estado, marco, breakpoint). */
  private desdeSim<T extends { source?: { name: string; path: string }; line?: number; description?: string }>(x: T): T {
    const mapa = this.mapaYaml();
    if (!mapa || !x.source || !/main\.sim\.yaml$/.test(x.source.name) || !x.line) return x;
    const linea = mapa.toSource(x.line) ?? x.line;
    return {
      ...x,
      source: { name: 'main.yaml', path: 'main.yaml' },
      line: linea,
      ...(x.description ? { description: x.description.replace(/main\.sim\.yaml:(\d+)/g, (_m, n: string) => `main.yaml:${mapa.toSource(Number(n)) ?? n}`) } : {}),
    };
  }

  /** main.yaml → main.sim.yaml para pedirle los breakpoints al adaptador. */
  private haciaSim(lineas: Map<string, number[]>): Map<string, number[]> {
    const mapa = this.mapaYaml();
    if (!mapa) return lineas;
    const out = new Map<string, number[]>();
    for (const [archivo, ls] of lineas) {
      if (!/(^|\/)main\.yaml$/.test(archivo)) {
        out.set(archivo, ls);
        continue;
      }
      const sim: number[] = [];
      for (const l of ls) {
        let encontrada = l; // si no aparece en el mapa, se prueba la misma línea
        for (let n = 1; n <= 20_000; n++) {
          if (mapa.toSource(n) === l) {
            encontrada = n;
            break;
          }
        }
        sim.push(encontrada);
      }
      out.set('main.sim.yaml', sim);
    }
    return out;
  }

  estado(): { capabilities: Capacidades; state: EstadoEjecucion; breakpoints: Breakpoint[]; corrida: Record<string, unknown> } {
    return {
      capabilities: this.capacidades(),
      state: this.estadoEjecucion(),
      breakpoints: this.ultimosBreakpoints.length ? this.ultimosBreakpoints : this.breakpointsPendientes(),
      corrida: this.grabadora.corrida,
    };
  }

  threads(): Promise<Thread[]> {
    return this.requerir().threads();
  }

  async stackTrace(threadId?: number): Promise<StackFrame[]> {
    return (await this.requerir().stackTrace(threadId)).map((f) => this.desdeSim(f));
  }

  scopes(frameId?: number): Promise<Scope[]> {
    return this.requerir().scopes(frameId);
  }

  variables(ref: number, start?: number, count?: number): Promise<Variable[]> {
    return this.requerir().variables(ref, start, count);
  }

  evaluate(expresion: string, frameId?: number): Promise<ResultadoEvaluacion> {
    return this.requerir().evaluate(expresion, frameId);
  }

  async memoria(dir: number, largo: number): Promise<Uint8Array> {
    const a = this.requerir();
    if (!a.leerMemoria) throw new NoSoportado('este motor no permite leer memoria cruda');
    return a.leerMemoria(dir, largo);
  }

  async control(accion: AccionControl): Promise<EstadoEjecucion> {
    return this.requerir().control(accion);
  }

  /** Espera a que el programa frene (breakpoint/paso) o se cumpla el tiempo. */
  async esperarParada(timeoutMs: number): Promise<EstadoEjecucion> {
    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
      const e = this.estadoEjecucion();
      if (e.status !== 'running') return e;
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.estadoEjecucion();
  }

  // --- Breakpoints ------------------------------------------------------------------------------

  private guardados(proyecto: string): { lineas: Map<string, number[]>; funciones: string[] } {
    let g = this.breakpoints.get(proyecto);
    if (!g) {
      g = { lineas: new Map(), funciones: [] };
      this.breakpoints.set(proyecto, g);
    }
    return g;
  }

  /**
   * Breakpoints de un proyecto: los verificados si es el que está corriendo, si no los guardados
   * (la UI los pide al abrir cada proyecto; sin esto mostraría los del que corre en otro archivo
   * que se llame igual, p. ej. main.yaml).
   */
  breakpointsDe(proyecto: string): Breakpoint[] {
    if (this.corrida?.proyecto === proyecto) return this.estado().breakpoints;
    return this.breakpointsPendientes(proyecto);
  }

  private breakpointsPendientes(proyecto = this.corrida?.proyecto): Breakpoint[] {
    const p = proyecto;
    if (!p) return [];
    const g = this.guardados(p);
    let id = 1;
    const msg = 'se pone al ejecutar';
    return [
      ...[...g.lineas].flatMap(([archivo, ls]) => ls.map((line) => ({ id: id++, verified: false, source: { name: path.posix.basename(archivo), path: archivo }, line, message: msg }))),
      ...g.funciones.map((f) => ({ id: id++, verified: false, function: f, message: msg })),
    ];
  }

  /**
   * setBreakpoints de DAP: con `source`, reemplaza los de ese archivo; con `functions`,
   * reemplaza todos los de función. Quedan guardados para el proyecto y se aplican
   * cada vez que arranca.
   */
  async setBreakpoints(pedido: PedidoBreakpoints, proyecto?: string): Promise<Breakpoint[]> {
    const nombre = proyecto ?? this.corrida?.proyecto;
    if (!nombre) throw new NoSoportado('indicá el proyecto (no hay ninguno corriendo)');
    const g = this.guardados(nombre);
    if (pedido.source !== undefined) {
      const archivo = pedido.source.replace(/^\.?\//, '');
      const lineas = [...new Set((pedido.lines ?? []).filter((l) => Number.isInteger(l) && l > 0))].sort((a, b) => a - b);
      if (lineas.length) g.lineas.set(archivo, lineas);
      else g.lineas.delete(archivo);
    }
    if (pedido.functions !== undefined) g.funciones = [...new Set(pedido.functions.map((f) => f.trim()).filter(Boolean))];
    if (this.corrida?.proyecto === nombre && this.adaptador) return this.aplicarBreakpointsGuardados();
    return this.breakpointsPendientes();
  }

  private async aplicarBreakpointsGuardados(): Promise<Breakpoint[]> {
    const a = this.adaptador;
    const p = this.corrida?.proyecto;
    if (!a || !p) return [];
    const g = this.guardados(p);
    this.ultimosBreakpoints = (await a.setBreakpoints(this.haciaSim(g.lineas), g.funciones)).map((b) => this.desdeSim(b));
    if (this.ultimosBreakpoints.length) this.grabadora.registrar('debug', { evento: 'breakpoints', cantidad: this.ultimosBreakpoints.length, verificados: this.ultimosBreakpoints.filter((b) => b.verified).length });
    return this.ultimosBreakpoints;
  }

  limpiarBreakpoints(proyecto: string): void {
    this.breakpoints.delete(proyecto);
  }

  // --- Traza e instantánea -------------------------------------------------------------------------

  traza(desde = 0, tipos?: TipoEvento[], limite = 500): ReturnType<Grabadora['desde']> & { corrida: Record<string, unknown> } {
    return { ...this.grabadora.desde(desde, { tipos, limite }), corrida: this.grabadora.corrida };
  }

  /** Todo el estado actual, en un JSON para que lo lea (y razone) una IA. */
  async instantanea(opciones: { variables?: boolean; lineasSerial?: number; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const emu = this.deps.emulador();
    const st = emu.getStatus();
    const c = this.corrida;
    const lineasSerial = opciones.lineasSerial ?? 40;
    const pc = this.proyectoCache;
    const desc = pc?.p.board ? pc.buscar(pc.p.board)?.board : undefined;

    // Pines: estado de cada GPIO y qué módulo está en cada uno.
    const pines: Record<string, Record<string, unknown>> = {};
    const modulos: Record<string, unknown>[] = [];
    const asegurarPin = (g: number): Record<string, unknown> => {
      const clave = String(g);
      pines[clave] ??= { nombre: nombreDePin(desc, g), salida: null, entrada: null, modulos: [] as string[] };
      return pines[clave]!;
    };
    for (const [g, e] of this.grabadora.pines) {
      const p = asegurarPin(g);
      p.salida = e.salida;
      p.entrada = e.entrada;
      p.cambios = e.cambios;
      p.ultimoCambioMs = e.tCambio;
      if (e.origenEntrada) p.origenEntrada = e.origenEntrada;
    }
    if (pc) {
      for (const inst of pc.p.modules) {
        if (inst.id === (this.deps.boardId ?? BOARD_MODULE_ID)) continue;
        const def = pc.buscar(inst.type);
        const pinesMod = (def?.pins ?? []).map((pin) => {
          const ref = `${inst.id}.${pin.name}`;
          const cables = pc.p.wires.filter((w) => w.from === ref || w.to === ref).map((w) => (w.from === ref ? w.to : w.from));
          let g: number | null = null;
          try {
            g = gpioDe(pc.p, inst.id, pin.name, pc.buscar, this.deps.boardId ?? BOARD_MODULE_ID);
          } catch {
            g = null;
          }
          if (g !== null) (asegurarPin(g).modulos as string[]).push(ref);
          return { pin: pin.name, tipo: pin.kind, conectadoA: cables, ...(g !== null ? { gpio: g, nombreGpio: nombreDePin(desc, g) } : {}) };
        });
        const rol = def?.bridge?.role ?? null;
        const gpioRol = def?.bridge ? pinesMod.find((x) => x.pin === def.bridge!.pin)?.gpio : undefined;
        const nivel = gpioRol !== undefined ? this.grabadora.pines.get(gpioRol) : undefined;
        modulos.push({
          id: inst.id,
          tipo: inst.type,
          nombre: def?.name ?? '(no está en el catálogo)',
          rol,
          props: inst.props,
          pines: pinesMod,
          ...(rol === 'output' && gpioRol !== undefined ? { encendido: nivel?.salida === 1 } : {}),
          ...(rol === 'input' && gpioRol !== undefined ? { nivelEntrada: nivel?.entrada ?? null } : {}),
        });
      }
    }

    // Ley de Ohm con los niveles de la simulación.
    let electrico: Record<string, unknown> | null = null;
    if (pc) {
      try {
        const r = await analizarCircuito(pc.p, pc.buscar, { niveles: this.nivelesActuales(), nivelesPorPlaca: this.deps.nivelesPorPlaca?.(), direcciones: pc.direcciones });
        // Lo que mediría un tester: tensión de cada pin, y corriente/potencia de cada elemento físico.
        const redondear = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
        electrico = {
          tensionesV: Object.fromEntries(Object.entries(r.tensiones).map(([k, v]) => [k, redondear(v, 3)])),
          elementos: r.elementos
            .filter((e) => !e.local.startsWith('prot_') || Math.abs(e.i) > 1e-4)
            .map((e) => ({ elemento: e.id, corrienteMa: redondear(e.i * 1000, 3), potenciaMw: redondear(e.p * 1000, 3) })),
          chipEncendido: r.chipEncendido,
          alimentacion: r.alimentacion,
          fuentes: r.fuentes,
          leds: r.leds,
          avisos: r.avisos,
        };
      } catch (err) {
        electrico = { error: (err as Error).message };
      }
    }

    let variables: unknown = null;
    if (opciones.variables !== false && this.adaptador) {
      variables = await conTiempo(this.adaptador.resumen(), opciones.timeoutMs ?? 6000).catch((err: Error) => ({ error: err.message }));
    } else if (!this.adaptador) variables = { nota: `sin depurador: ${this.motivoSinAdaptador}` };

    let pila: StackFrame[] | undefined;
    const est = this.estadoEjecucion();
    if (est.status === 'stopped' && this.adaptador) pila = await conTiempo(this.stackTrace(), 4000).catch(() => undefined);

    const errores = this.grabadora.ultimosErrores();
    return {
      generado: new Date().toISOString(),
      tiempoCorridaMs: c ? this.grabadora.ahora() : null,
      proyecto: c ? { nombre: c.proyecto, placa: c.placa, lenguaje: c.lenguaje, motor: c.motor, firmware: path.basename(c.artefactos.firmware), elf: c.artefactos.elf ? path.basename(c.artefactos.elf) : null } : null,
      emulador: {
        estado: st.state,
        corriendo: st.running,
        pausadoPorDepurador: this.pausado(),
        pid: st.pid,
        uptimeMs: st.startedAt ? Date.now() - st.startedAt : null,
        ip: st.ip,
        salida: st.exitInfo,
      },
      depuracion: {
        motor: this.capacidades().motor,
        capacidades: this.capacidades(),
        estado: est,
        breakpoints: this.estado().breakpoints,
        ...(pila ? { pila } : {}),
      },
      pines,
      circuito: pc ? { placa: pc.p.board, modulos, cables: pc.p.wires } : null,
      electrico,
      consola: this.grabadora.ultimasLineas(lineasSerial),
      errores: errores.map((e) => {
        const { seq: _s, tipo: _t, t: _tt, tipoError, tError, lineas, ...resto } = e;
        return { tipo: tipoError, t: tError, ...resto, lineas: (lineas as string[] | undefined)?.slice(0, 25) };
      }),
      compilacion: this.ultimaCompilacion,
      variables,
      traza: {
        eventosTotales: this.grabadora.totalEventos,
        enMemoria: this.grabadora.enBuffer,
        ultimoSeq: this.grabadora.totalEventos,
        ayuda: 'GET /api/debug/trace?since=<seq> (o la herramienta MCP debug_trace) para ver qué pasó y cuándo',
      },
    };
  }
}

function conTiempo<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no respondió en ${ms / 1000} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export type { EventoTraza };
