import path from 'node:path';
import type { Simbolos } from './simbolos.js';
import type { FuncionDwarf, VariableDwarf } from './dwarf.js';
import { esDelUsuario, FormateadorC, MemoriaConCache, type Memoria } from './valoresC.js';
import {
  hex,
  NoSoportado,
  Referencias,
  type AccionControl,
  type AdaptadorDepuracion,
  type Breakpoint,
  type Capacidades,
  type EstadoEjecucion,
  type EventosAdaptador,
  type RazonParada,
  type ResultadoEvaluacion,
  type Scope,
  type StackFrame,
  type Thread,
  type Variable,
} from './tipos.js';

/**
 * Base de los adaptadores de firmware compilado con .elf (AVR sobre avr8js y ESP32 por
 * el stub GDB de esp-emu): todo lo que sale del .elf/DWARF es igual para los dos —
 * globales con tipo, evaluate, breakpoints por línea/función, "next"/"step" por línea
 * (con breakpoints temporales), nombres de función y archivo:línea de cada marco. Cada
 * motor pone lo suyo: cómo leer memoria y registros, cómo frenar/seguir, cómo
 * desenrollar la pila.
 *
 * Direcciones de código: siempre en bytes (como en el .elf). El adaptador AVR convierte
 * de/a palabras (el PC de avr8js cuenta palabras de 16 bits).
 */

export interface Registros {
  pc: number;
  sp: number;
  /** Para el ámbito "Registros" y para evaluate ($nombre). */
  lista: [string, number][];
}

export interface MarcoCrudo {
  pc: number;
  sp?: number;
  aproximado?: boolean;
}

/** Tope de globales "del framework" que se listan (el .elf de ESPHome trae ~2000). */
const MAX_OTRAS = 200;

export abstract class AdaptadorConElf implements AdaptadorDepuracion {
  abstract readonly capacidades: Capacidades;
  protected readonly refs = new Referencias();
  protected estadoActual: EstadoEjecucion = { status: 'running' };
  protected breakpoints: Breakpoint[] = [];
  /** Dirección (bytes) → ids de los breakpoints puestos ahí. */
  protected dirsBp = new Map<number, number[]>();
  private siguienteBp = 1;
  private marcosCache: { pcs: MarcoCrudo[]; frames: StackFrame[] } | null = null;

  constructor(
    protected readonly sim: Simbolos,
    protected readonly eventos: EventosAdaptador,
  ) {}

  // --- Lo que pone cada motor ----------------------------------------------------------

  /** Memoria del chip (sin caché). */
  protected abstract memoria(): Memoria;
  /** Corre `fn` con el chip frenado (si está corriendo, lo frena un instante y lo suelta). */
  protected abstract conDetenido<T>(fn: () => Promise<T>): Promise<T>;
  protected abstract leerRegistros(): Promise<Registros>;
  protected abstract desenrollar(regs: Registros, mem: Memoria): Promise<MarcoCrudo[]>;
  /** Deja puestos exactamente estos breakpoints (direcciones en bytes). */
  protected abstract sincronizarBreakpoints(dirs: number[]): Promise<void>;
  /** Sigue corriendo; frena solo en un breakpoint o en alguna de las direcciones temporales. */
  protected abstract correr(temporales: number[]): Promise<void>;
  protected abstract frenar(): Promise<void>;
  protected abstract pasoInstruccion(): Promise<void>;

  // --- Estado --------------------------------------------------------------------------

  estado(): EstadoEjecucion {
    return { ...this.estadoActual };
  }

  /** Lo llama el motor cuando el chip frenó (breakpoint, pausa, fin de un paso). */
  protected alDetenerse(pc: number, razon: RazonParada, extra: { threadId?: number; nota?: string } = {}): void {
    const ids = this.dirsBp.get(pc);
    const r: RazonParada = ids && razon !== 'pause' && razon !== 'step' ? 'breakpoint' : razon;
    const fila = this.sim.dwarf?.lineaEn(pc) ?? null;
    const fn = this.nombreFuncion(pc);
    this.marcosCache = null;
    const descripcion = describirParada(r, fn, fila ? `${path.posix.basename(fila.archivo)}:${fila.linea}` : null);
    this.estadoActual = {
      status: 'stopped',
      reason: r,
      threadId: extra.threadId ?? 1,
      pc: hex(pc),
      ...(fn ? { function: fn } : {}),
      ...(fila ? { source: fuente(fila.archivo), line: fila.linea } : {}),
      ...(ids && r === 'breakpoint' ? { hitBreakpointIds: ids } : {}),
      description: extra.nota ? `${descripcion} — ${extra.nota}` : descripcion,
    };
    this.eventos.detenido(this.estado());
  }

  /**
   * true si no se conocen los registros del código que frenó (ESP32-S3: el stub solo
   * muestra el CPU0 y frenó el CPU1). Entonces "next" pone un solo breakpoint temporal
   * (la línea siguiente) para saber exactamente dónde frena, y stepOut no se puede.
   */
  protected pasoSecuencial(): boolean {
    return false;
  }

  protected alContinuar(): void {
    this.marcosCache = null;
    this.estadoActual = { status: 'running' };
    this.eventos.continuado();
  }

  // --- DAP ---------------------------------------------------------------------------------

  async threads(): Promise<Thread[]> {
    return [{ id: 1, name: 'CPU' }];
  }

  protected nombreFuncion(pc: number): string | null {
    const f = this.sim.dwarf?.funcionEn(pc);
    if (f) return f.nombre;
    const s = this.sim.elf.funcionEn(pc);
    return s ? s.legible : null;
  }

  async stackTrace(): Promise<StackFrame[]> {
    const crudos = await this.conDetenido(async () => {
      const regs = await this.leerRegistros();
      return this.desenrollar(regs, new MemoriaConCache(this.memoria()));
    });
    const frames = crudos.map((m, i): StackFrame => {
      // En los marcos de más arriba, el pc es la dirección de retorno: la línea es la de la llamada.
      const dirLinea = i === 0 ? m.pc : Math.max(0, m.pc - 1);
      const fila = this.sim.dwarf?.lineaEn(dirLinea) ?? null;
      return {
        id: i,
        name: this.nombreFuncion(m.pc) ?? `?? (${hex(m.pc)})`,
        line: fila?.linea ?? 0,
        column: 0,
        instructionPointerReference: hex(m.pc),
        ...(fila ? { source: fuente(fila.archivo) } : {}),
        ...(m.aproximado ? { aproximado: true } : {}),
      };
    });
    this.marcosCache = { pcs: crudos, frames };
    return frames;
  }

  // --- Globales ------------------------------------------------------------------------------

  private variablesCache: VariableDwarf[] | null = null;

  protected variablesDwarf(): VariableDwarf[] {
    if (this.variablesCache) return this.variablesCache;
    const dw = this.sim.dwarf;
    if (!dw) return [];
    this.variablesCache = [...dw.variables, ...this.idsDeEsphome()];
    return this.variablesCache;
  }

  /**
   * ESPHome: cada `id:` del YAML es un puntero const (sin dirección en DWARF, el compilador
   * lo reemplazó) al objeto que vive en `<dominio>__<id>__pstorage`. Se reconstruye como una
   * variable con el nombre del id y el tipo del objeto: `id(contador)` → `contador.value_`.
   */
  private idsDeEsphome(): VariableDwarf[] {
    const dw = this.sim.dwarf;
    if (!dw) return [];
    const almacenes = new Map<string, VariableDwarf>();
    for (const v of dw.variables) {
      const m = /^(?:.*?__)?([A-Za-z0-9_]+?)__pstorage$/.exec(v.nombre);
      if (m) almacenes.set(m[1]!, v);
    }
    if (almacenes.size === 0) return [];
    const out: VariableDwarf[] = [];
    // La aplicación misma: esphome::App vive en `app_storage` (un char[]) y es un esphome::Application.
    const app = dw.variables.find((v) => v.nombreCompleto === 'esphome::app_storage');
    const tipoApp = dw.buscarStruct('esphome::Application');
    if (app && tipoApp !== undefined) out.push({ ...app, nombre: 'App', nombreCompleto: 'esphome::App', tipo: tipoApp });
    for (const s of dw.sinUbicacion) {
      const alm = almacenes.get(s.nombre);
      if (!alm) continue;
      const { t } = dw.resolver(s.tipo);
      if (t.k !== 'puntero' || t.destino === null) continue;
      out.push({ ...s, dir: alm.dir, tipo: t.destino, archivo: alm.archivo ?? s.archivo, cu: alm.cu });
    }
    return out;
  }

  /** Globales del código del usuario (sketch.cpp, main/, src/main.cpp de ESPHome). */
  protected globalesDelUsuario(): VariableDwarf[] {
    const vistas = new Set<string>();
    return this.variablesDwarf()
      .filter((v) => esDelUsuario(v) && !/__pstorage$/.test(v.nombre))
      .filter((v) => {
        const clave = `${v.nombreCompleto}@${v.dir}`;
        if (vistas.has(clave)) return false;
        vistas.add(clave);
        return true;
      })
      .sort((a, b) => (a.archivo ?? '').localeCompare(b.archivo ?? '') || (a.linea ?? 0) - (b.linea ?? 0));
  }

  /** Otras globales (framework, núcleo), con tope. */
  protected otrasGlobales(): VariableDwarf[] {
    const usuario = new Set(this.globalesDelUsuario());
    const vistas = new Set<string>();
    return this.variablesDwarf()
      .filter((v) => !usuario.has(v) && this.esVariableDeDatos(v))
      .filter((v) => {
        if (vistas.has(v.nombreCompleto)) return false;
        vistas.add(v.nombreCompleto);
        return true;
      })
      .sort((a, b) => a.nombreCompleto.localeCompare(b.nombreCompleto))
      .slice(0, MAX_OTRAS);
  }

  /** ¿La variable vive en RAM leíble? (AVR descarta registros de E/S y PROGMEM; los manejan aparte). */
  protected esVariableDeDatos(_v: VariableDwarf): boolean {
    return true;
  }

  /** Globales sin DWARF: solo nombre, dirección y tamaño (de la tabla de símbolos). */
  protected globalesDeSimbolos(): Variable[] {
    return this.sim.elf.variables().slice(0, MAX_OTRAS).map((s) => ({
      name: s.legible,
      value: `(${s.tam} bytes en ${hex(s.dir)})`,
      variablesReference: 0,
      memoryReference: hex(s.dir),
    }));
  }

  async scopes(): Promise<Scope[]> {
    const alcances: Scope[] = [];
    if (this.sim.dwarf) {
      const usuario = this.globalesDelUsuario();
      alcances.push({
        name: 'Globales del programa',
        presentationHint: 'globals',
        variablesReference: this.refs.crear(() => this.leerGlobales(usuario)),
        expensive: false,
      });
      alcances.push(...this.alcancesExtra());
      const otras = this.otrasGlobales();
      if (otras.length > 0) {
        alcances.push({
          name: `Otras globales (framework${otras.length >= MAX_OTRAS ? `, primeras ${MAX_OTRAS}` : ''})`,
          presentationHint: 'globals',
          variablesReference: this.refs.crear(() => this.leerGlobales(otras)),
          expensive: true,
        });
      }
    } else {
      alcances.push({
        name: 'Símbolos (sin información de tipos)',
        presentationHint: 'globals',
        variablesReference: this.refs.crear(async () => this.globalesDeSimbolos()),
        expensive: false,
      });
    }
    alcances.push({
      name: 'Registros',
      presentationHint: 'registers',
      variablesReference: this.refs.crear(() => this.variablesRegistros()),
      expensive: false,
    });
    return alcances;
  }

  /** Ámbitos propios del motor (p. ej. registros de E/S del AVR). */
  protected alcancesExtra(): Scope[] {
    return [];
  }

  protected async leerGlobales(vars: VariableDwarf[]): Promise<Variable[]> {
    const dw = this.sim.dwarf;
    if (!dw) return this.globalesDeSimbolos();
    return this.conDetenido(() => new FormateadorC(dw, new MemoriaConCache(this.memoria()), this.refs).globales(vars));
  }

  private async variablesRegistros(): Promise<Variable[]> {
    const regs = await this.conDetenido(() => this.leerRegistros());
    return regs.lista.map(([nombre, v]) => ({
      name: nombre,
      value: hex(v, nombre === 'SREG' || /^r\d+$/.test(nombre) ? 2 : nombre === 'SP' ? 4 : 8),
      type: 'registro',
      variablesReference: 0,
      evaluateName: `$${nombre}`,
    }));
  }

  async variables(ref: number, start?: number, count?: number): Promise<Variable[]> {
    return this.refs.hijos(ref, start, count);
  }

  // --- Evaluate --------------------------------------------------------------------------------

  protected buscarVariable(nombre: string): VariableDwarf | undefined {
    const vars = this.variablesDwarf();
    const usuario = new Set(this.globalesDelUsuario());
    const directa =
      vars.find((v) => v.nombreCompleto === nombre && usuario.has(v)) ??
      vars.find((v) => v.nombreCompleto === nombre) ??
      vars.find((v) => v.nombre === nombre && usuario.has(v)) ??
      vars.find((v) => v.nombre === nombre && !v.estaticaLocal) ??
      vars.find((v) => v.nombreCompleto.endsWith(`::${nombre}`));
    if (directa) return directa;
    // Por el nombre del enlazador (p. ej. esphome::App, que en DWARF se llama app_storage).
    const s = this.sim.elf
      .simbolos()
      .find((x) => x.tipo === 'objeto' && (x.legible === nombre || x.nombre === nombre || x.legible.endsWith(`::${nombre}`)));
    return s ? vars.find((v) => v.dir === s.dir) : undefined;
  }

  async evaluate(expresion: string): Promise<ResultadoEvaluacion> {
    const dw = this.sim.dwarf;
    if (!dw) throw new NoSoportado(`sin información de depuración: ${this.sim.sinDwarf ?? 'el .elf no tiene DWARF'}`);
    return this.conDetenido(async () => {
      let regs: Registros | null = null;
      if (expresion.includes('$')) regs = await this.leerRegistros();
      const mapaRegs = new Map((regs?.lista ?? []).map(([n, v]) => [n.toLowerCase(), v]));
      if (regs) {
        mapaRegs.set('pc', regs.pc);
        mapaRegs.set('sp', regs.sp);
      }
      const f = new FormateadorC(dw, new MemoriaConCache(this.memoria()), this.refs);
      return f.evaluar(expresion, (n) => this.buscarVariable(n), (n) => mapaRegs.get(n.toLowerCase()));
    });
  }

  async leerMemoria(dir: number, largo: number): Promise<Uint8Array> {
    return this.conDetenido(() => this.memoria().leer(dir, largo));
  }

  // --- Breakpoints ---------------------------------------------------------------------------

  /** Primera línea "de verdad" de una función (después del prólogo), como hace gdb. */
  protected despuesDelPrologo(f: FuncionDwarf): number {
    const filas = this.sim.dwarf?.comienzosDeLineaEn(f.bajo, f.alto) ?? [];
    const primera = filas[0];
    if (!primera) return f.bajo;
    const siguiente = filas.find((x) => x.dir > primera.dir && x.linea !== primera.linea);
    return siguiente?.dir ?? primera.dir;
  }

  async setBreakpoints(lineas: Map<string, number[]>, funciones: string[]): Promise<Breakpoint[]> {
    const nuevos: Breakpoint[] = [];
    const dw = this.sim.dwarf;
    for (const [archivo, ls] of lineas) {
      for (const linea of ls) {
        const id = this.siguienteBp++;
        const r = dw?.direccionesDeLinea(archivo, linea) ?? null;
        if (!r) {
          nuevos.push({
            id,
            verified: false,
            source: fuente(archivo),
            line: linea,
            message: dw ? `no hay código en ${archivo}:${linea} (ni en las 20 líneas siguientes), o el archivo no está en el programa` : 'sin DWARF: solo breakpoints por función',
          });
          continue;
        }
        nuevos.push({
          id,
          verified: true,
          source: fuente(r.archivo),
          line: r.linea,
          instructionReference: r.dirs.map((d) => hex(d)),
          ...(r.linea !== linea ? { message: `la línea ${linea} no tiene código: quedó en la ${r.linea}` } : {}),
        });
      }
    }
    for (const nombre of funciones) {
      const id = this.siguienteBp++;
      const fs = dw?.buscarFuncion(nombre) ?? [];
      let dirs = fs.map((f) => this.despuesDelPrologo(f));
      if (dirs.length === 0) {
        const s = this.sim.elf.simbolos().find((x) => x.tipo === 'funcion' && (x.legible === nombre || x.nombre === nombre || x.legible.endsWith(`::${nombre}`)));
        if (s) dirs = [s.dir];
      }
      if (dirs.length === 0) {
        nuevos.push({
          id,
          verified: false,
          function: nombre,
          message: `no hay una función "${nombre}" en el programa (¿el compilador la metió adentro de otra — inline/LTO? probá por línea)`,
        });
        continue;
      }
      const fila = dw?.lineaEn(dirs[0]!);
      nuevos.push({
        id,
        verified: true,
        function: nombre,
        instructionReference: dirs.map((d) => hex(d)),
        ...(fila ? { source: fuente(fila.archivo), line: fila.linea } : {}),
      });
    }
    this.breakpoints = nuevos;
    this.dirsBp = new Map();
    for (const b of nuevos) {
      for (const d of b.instructionReference ?? []) {
        const dir = parseInt(d, 16);
        this.dirsBp.set(dir, [...(this.dirsBp.get(dir) ?? []), b.id]);
      }
    }
    await this.sincronizarBreakpoints([...this.dirsBp.keys()]);
    return nuevos;
  }

  // --- Control ---------------------------------------------------------------------------------

  async control(accion: AccionControl): Promise<EstadoEjecucion> {
    if (accion === 'pause') {
      if (this.estadoActual.status === 'stopped') return this.estado();
      await this.frenar();
      return this.estado();
    }
    if (this.estadoActual.status !== 'stopped') {
      if (accion === 'continue') return this.estado();
      throw new NoSoportado('el programa está corriendo: primero pausalo (pause) o esperá un breakpoint');
    }
    if (accion === 'continue') {
      await this.correr([]);
      return this.estado();
    }
    const pc = parseInt(this.estadoActual.pc ?? '0', 16);
    if (this.pasoSecuencial()) {
      if (accion === 'stepOut') throw new NoSoportado('stepOut no se puede acá: el código frenó en el otro núcleo (CPU1) y el stub no da sus registros; usá next o continue');
      const dw = this.sim.dwarf;
      const f = dw?.funcionEn(pc);
      const actual = dw?.lineaEn(pc);
      if (!dw || !f || !actual) throw new NoSoportado('no hay información de líneas para avanzar desde acá: usá continue');
      const siguientes = dw.comienzosDeLineaEn(pc + 1, f.alto).filter((x) => x.linea !== actual.linea);
      const siguiente = siguientes.find((x) => x.archivo === actual.archivo) ?? siguientes[0];
      await this.correr(siguiente ? [siguiente.dir] : []);
      return this.estado();
    }
    if (accion === 'stepOut') {
      const marcos = this.marcosCache?.pcs ?? (await this.stackTrace(), this.marcosCache?.pcs ?? []);
      const ret = marcos[1]?.pc;
      if (ret === undefined) throw new NoSoportado('no se sabe a dónde vuelve esta función (pila desconocida)');
      await this.correr([ret]);
      return this.estado();
    }
    const dw = this.sim.dwarf;
    const f = dw?.funcionEn(pc);
    const actual = dw?.lineaEn(pc);
    if (!dw || !f || !actual) {
      // Sin línea conocida (código del sistema, sin DWARF): una instrucción.
      await this.pasoInstruccion();
      return this.estado();
    }
    const destinos = new Set<number>();
    const filas = dw.comienzosDeLineaEn(f.bajo, f.alto).filter((x) => x.linea !== actual.linea || x.archivo !== actual.archivo);
    // "next" pasa por encima del código inline de otros archivos (digitalRead adentro de loop con
    // LTO): solo frena en líneas del mismo archivo, si las hay. stepIn sí entra.
    const mismoArchivo = filas.filter((x) => x.archivo === actual.archivo);
    for (const fila of accion === 'next' && mismoArchivo.length > 0 ? mismoArchivo : filas) destinos.add(fila.dir);
    // Al terminar la función, vuelve a quien la llamó.
    try {
      const marcos = this.marcosCache?.pcs ?? (await this.stackTrace(), this.marcosCache?.pcs ?? []);
      if (marcos[1]) destinos.add(marcos[1].pc);
    } catch {
      /* sin pila: solo las líneas de la función */
    }
    if (accion === 'stepIn') {
      // Entrar a las funciones del usuario que se llamen desde acá.
      for (const fn of dw.funciones) if (esDelUsuario({ archivo: fn.archivo, cu: fn.cu }) && fn !== f) destinos.add(this.despuesDelPrologo(fn));
    }
    destinos.delete(pc);
    if (destinos.size === 0) {
      await this.pasoInstruccion();
      return this.estado();
    }
    await this.correr([...destinos]);
    return this.estado();
  }

  async resumen(): Promise<unknown> {
    if (!this.sim.dwarf) {
      return { nota: `sin DWARF (${this.sim.sinDwarf ?? '?'}): solo símbolos`, simbolos: this.globalesDeSimbolos().slice(0, 50) };
    }
    const vars = await this.leerGlobales(this.globalesDelUsuario());
    return {
      // Resumen: cada valor recortado (un objeto de ESPHome puede tener decenas de miembros);
      // el detalle completo, con debug_variables / evaluate.
      globales: Object.fromEntries(
        vars.map((v) => {
          const valor = v.value.length > 240 ? `${v.value.slice(0, 240)}…` : v.value;
          return [v.name, v.type ? `${valor}  (${v.type})` : valor];
        }),
      ),
    };
  }

  abstract cerrar(): void;
}

function fuente(ruta: string): { name: string; path: string } {
  return { name: path.posix.basename(ruta), path: ruta };
}

function describirParada(r: RazonParada, fn: string | null, donde: string | null): string {
  const lugar = [fn, donde ? `(${donde})` : null].filter(Boolean).join(' ');
  const que = r === 'breakpoint' ? 'Breakpoint' : r === 'step' ? 'Paso' : r === 'pause' ? 'Pausado' : r === 'exception' ? 'Excepción' : 'Detenido';
  return lugar ? `${que} en ${lugar}` : que;
}
