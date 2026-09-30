import { DW_ATE, type InfoDwarf, type TipoC, type VariableDwarf } from './dwarf.js';
import { hex, NoSoportado, type Referencias, type ResultadoEvaluacion, type Variable } from './tipos.js';

/**
 * Núcleo "de depurador de C" compartido por los motores con .elf (AVR y ESP32): lee
 * valores de memoria según su tipo DWARF, los muestra como lo haría gdb/VS Code
 * (`{x = 1, y = 2}`, `"hola"`, `0x3fc9a000`), arma los hijos perezosos para expandir
 * structs/arreglos/punteros, y evalúa expresiones simples de C.
 */

/** Acceso a la memoria del chip emulado (el motor sabe cómo: SRAM de avr8js, paquetes `m` de GDB). */
export interface Memoria {
  leer(dir: number, largo: number): Promise<Uint8Array>;
  /** Dirección (en el espacio de las variables DWARF) a la que apunta un puntero con este valor. */
  desdePuntero(valor: number): number;
  /** Tamaño de un puntero en el chip (2 en AVR, 4 en ESP32). */
  readonly tamPuntero: number;
}

/**
 * Envoltorio con caché para una sola consulta: se precargan de una vez los rangos que
 * se van a mirar (juntando los cercanos), así en ESP32 una lista de 40 globales son
 * 2-3 paquetes GDB y no 40 (cada paquete tarda ~40 ms con el stub de esp-emu).
 */
export class MemoriaConCache implements Memoria {
  private readonly bloques: { dir: number; datos: Uint8Array }[] = [];

  constructor(private readonly base: Memoria) {}

  get tamPuntero(): number {
    return this.base.tamPuntero;
  }

  desdePuntero(v: number): number {
    return this.base.desdePuntero(v);
  }

  async precargar(rangos: { dir: number; largo: number }[], hueco = 64, maxBloque = 4096): Promise<void> {
    const ordenados = rangos.filter((r) => r.largo > 0).sort((a, b) => a.dir - b.dir);
    const juntos: { dir: number; fin: number }[] = [];
    for (const r of ordenados) {
      const ult = juntos[juntos.length - 1];
      const fin = r.dir + r.largo;
      if (ult && r.dir <= ult.fin + hueco && fin - ult.dir <= maxBloque) ult.fin = Math.max(ult.fin, fin);
      else juntos.push({ dir: r.dir, fin });
    }
    for (const j of juntos) {
      try {
        this.bloques.push({ dir: j.dir, datos: await this.base.leer(j.dir, j.fin - j.dir) });
      } catch {
        // Un rango ilegible (periférico, dirección inválida) no tapa a los demás.
      }
    }
  }

  async leer(dir: number, largo: number): Promise<Uint8Array> {
    for (const b of this.bloques) {
      if (dir >= b.dir && dir + largo <= b.dir + b.datos.length) return b.datos.subarray(dir - b.dir, dir - b.dir + largo);
    }
    const datos = await this.base.leer(dir, largo);
    this.bloques.push({ dir, datos });
    return datos;
  }
}

/** Máximo que se lee de una variable para mostrar su resumen (un arreglo de 1 KB no hace falta entero). */
const MAX_VISTA = 256;
/** Hijos por página al expandir arreglos grandes. */
const PAGINA = 100;

export interface ValorC {
  tipo: number | null;
  /** Dirección si es un lvalue (variable, miembro, *p); null si es un valor calculado. */
  dir: number | null;
  bytes: Uint8Array;
  /** Para resultados numéricos sin tipo DWARF (literales, aritmética). */
  numero?: number;
  nombreTipo?: string;
}

export class FormateadorC {
  constructor(
    readonly dw: InfoDwarf,
    readonly mem: Memoria,
    private readonly refs: Referencias,
  ) {}

  // --- Lectura de números ---------------------------------------------------------------

  private entero(bytes: Uint8Array, tam: number, conSigno: boolean): number | bigint {
    if (tam > 6) {
      let v = 0n;
      for (let i = Math.min(tam, bytes.length) - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
      if (conSigno && tam === 8 && v >= 1n << 63n) v -= 1n << 64n;
      return v;
    }
    let v = 0;
    for (let i = Math.min(tam, bytes.length) - 1; i >= 0; i--) v = v * 256 + bytes[i]!;
    if (conSigno && tam > 0 && v >= 2 ** (tam * 8 - 1)) v -= 2 ** (tam * 8);
    return v;
  }

  numeroDe(v: ValorC): number {
    if (v.numero !== undefined) return v.numero;
    const { t } = this.dw.resolver(v.tipo);
    if (t.k === 'base') {
      if (t.codif === DW_ATE.float) return this.flotante(v.bytes, t.tam);
      const n = this.entero(v.bytes, t.tam, t.codif === DW_ATE.signed || t.codif === DW_ATE.signed_char);
      return Number(n);
    }
    if (t.k === 'enum') return Number(this.entero(v.bytes, t.tam, true));
    if (t.k === 'puntero') return Number(this.entero(v.bytes, t.tam, false));
    if (t.k === 'arreglo' && v.dir !== null) return v.dir; // un arreglo "decae" a su dirección
    throw new NoSoportado(`no es un número (${this.dw.nombreTipo(v.tipo)})`);
  }

  private flotante(bytes: Uint8Array, tam: number): number {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (tam === 4 && bytes.length >= 4) return dv.getFloat32(0, true);
    if (tam === 8 && bytes.length >= 8) return dv.getFloat64(0, true);
    return NaN;
  }

  // --- Formato --------------------------------------------------------------------------------

  /** Texto del valor (sin leer más memoria: con los bytes que ya hay). */
  texto(tipoOff: number | null, bytes: Uint8Array, dir: number | null, prof = 0): string {
    const { t } = this.dw.resolver(tipoOff);
    const tam = this.dw.tamano(tipoOff);
    if (tam > 0 && bytes.length < Math.min(tam, MAX_VISTA) && t.k !== 'arreglo' && t.k !== 'struct') return '<no se pudo leer>';
    switch (t.k) {
      case 'base':
        return this.textoBase(t, bytes);
      case 'enum': {
        const n = Number(this.entero(bytes, t.tam, true));
        const e = t.valores.find((x) => x.valor === n);
        return e ? `${e.nombre} (${n})` : String(n);
      }
      case 'puntero': {
        const n = Number(this.entero(bytes, t.tam, false));
        if (n === 0) return 'NULL';
        return hex(n, t.tam * 2);
      }
      case 'arreglo': {
        const elemOff = t.elem;
        const elemTam = this.dw.tamano(elemOff);
        const n = t.dims[0] ?? 0;
        const { t: te } = this.dw.resolver(elemOff);
        if (te.k === 'base' && te.tam === 1 && (te.codif === DW_ATE.signed_char || te.codif === DW_ATE.unsigned_char) && t.dims.length === 1) {
          return cadenaC(bytes.subarray(0, Math.min(n || bytes.length, bytes.length)));
        }
        if (prof > 1) return `[${n}]`;
        const partes: string[] = [];
        const subTipo = t.dims.length > 1 ? this.dw.sintetico({ k: 'arreglo', elem: elemOff, dims: t.dims.slice(1) }) : elemOff;
        const subTam = t.dims.length > 1 ? this.dw.tamano(subTipo) : elemTam;
        for (let i = 0; i < Math.min(n, 8) && subTam > 0; i++) {
          const b = bytes.subarray(i * subTam, (i + 1) * subTam);
          if (b.length < subTam) break;
          partes.push(this.texto(subTipo, b, dir === null ? null : dir + i * subTam, prof + 1));
        }
        return `[${n}] {${partes.join(', ')}${n > partes.length ? ', …' : ''}}`;
      }
      case 'struct': {
        if (t.incompleto) return `{…} (${t.nombre || 'tipo incompleto'})`;
        if (prof > 1) return '{…}';
        const partes: string[] = [];
        for (const m of t.miembros.slice(0, 6)) {
          const mt = this.dw.tamano(m.tipo);
          const b = bytes.subarray(m.offset, m.offset + Math.max(mt, 1));
          if (b.length < Math.min(mt, 1)) break;
          partes.push(`${m.nombre} = ${m.bitTam !== undefined ? this.bitfield(b, m.bitDesde ?? 0, m.bitTam) : this.texto(m.tipo, b, dir === null ? null : dir + m.offset, prof + 1)}`);
        }
        return `{${partes.join(', ')}${t.miembros.length > partes.length ? ', …' : ''}}`;
      }
      case 'void':
        return 'void';
      case 'funcion':
        return dir === null ? 'función' : `función @ ${hex(dir)}`;
      default:
        return `<${t.k}>`;
    }
  }

  private textoBase(t: Extract<TipoC, { k: 'base' }>, bytes: Uint8Array): string {
    switch (t.codif) {
      case DW_ATE.boolean:
        return bytes[0] ? 'true' : 'false';
      case DW_ATE.float: {
        const f = this.flotante(bytes, t.tam);
        return Number.isInteger(f) ? f.toFixed(1) : String(t.tam === 4 ? Number(f.toPrecision(7)) : f);
      }
      case DW_ATE.signed_char:
      case DW_ATE.unsigned_char: {
        const n = Number(this.entero(bytes, 1, t.codif === DW_ATE.signed_char));
        const c = bytes[0]!;
        return c >= 32 && c < 127 ? `${n} '${String.fromCharCode(c)}'` : String(n);
      }
      case DW_ATE.signed:
      case DW_ATE.unsigned:
      case DW_ATE.UTF:
      case DW_ATE.address:
      default: {
        const n = this.entero(bytes, t.tam, t.codif === DW_ATE.signed);
        return String(n);
      }
    }
  }

  private bitfield(bytes: Uint8Array, desde: number, tam: number): string {
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
    return String((v >> BigInt(desde)) & ((1n << BigInt(tam)) - 1n));
  }

  // --- Variables (DAP) -----------------------------------------------------------------------

  /** Variable DAP a partir de un valor ya leído; los hijos se leen recién al expandir. */
  variable(nombre: string, v: ValorC, evaluateName?: string): Variable {
    const tipoTxt = v.nombreTipo ?? this.dw.nombreTipo(v.tipo);
    if (v.numero !== undefined) return { name: nombre, value: String(v.numero), type: tipoTxt, variablesReference: 0, evaluateName };
    const { t } = this.dw.resolver(v.tipo);
    const value = this.texto(v.tipo, v.bytes, v.dir);
    const base: Variable = {
      name: nombre,
      value,
      type: tipoTxt,
      variablesReference: 0,
      ...(evaluateName ? { evaluateName } : {}),
      ...(v.dir !== null ? { memoryReference: hex(v.dir) } : {}),
    };
    const expr = evaluateName ?? nombre;
    if (t.k === 'struct' && !t.incompleto && t.miembros.length > 0 && v.dir !== null) {
      const dir = v.dir;
      base.variablesReference = this.refs.crear(() => this.hijosStruct(t, dir, expr));
      base.indexedVariables = t.miembros.length;
    } else if (t.k === 'arreglo' && v.dir !== null && (t.dims[0] ?? 0) > 0) {
      const dir = v.dir;
      base.variablesReference = this.refs.crear((start, count) => this.hijosArreglo(t, dir, expr, start, count));
      base.indexedVariables = t.dims[0];
    } else if (t.k === 'puntero' && t.destino !== null) {
      const p = Number(this.entero(v.bytes, t.tam, false));
      const { t: td } = this.dw.resolver(t.destino);
      if (p !== 0 && td.k !== 'void' && td.k !== 'funcion' && this.dw.tamano(t.destino) > 0) {
        const destino = t.destino;
        base.variablesReference = this.refs.crear(async () => {
          const dir = this.mem.desdePuntero(p);
          const leido = await this.leerValor(destino, dir);
          return [this.variable(`*${nombre}`, leido, `*(${expr})`)];
        });
      }
      // char *: además del puntero, se muestra el texto (como gdb).
      if (p !== 0 && td.k === 'base' && td.tam === 1 && (td.codif === DW_ATE.signed_char || td.codif === DW_ATE.unsigned_char)) {
        base.value = `${value} (ver *${nombre})`;
      }
    }
    return base;
  }

  async leerValor(tipoOff: number | null, dir: number, maximo = MAX_VISTA): Promise<ValorC> {
    const tam = this.dw.tamano(tipoOff);
    const bytes = tam > 0 ? await this.mem.leer(dir, Math.min(tam, maximo)) : new Uint8Array(0);
    return { tipo: tipoOff, dir, bytes };
  }

  private async hijosStruct(t: Extract<TipoC, { k: 'struct' }>, dir: number, expr: string): Promise<Variable[]> {
    const bytes = await this.mem.leer(dir, Math.min(t.tam, 4096));
    const out: Variable[] = [];
    for (const m of t.miembros) {
      const mt = this.dw.tamano(m.tipo);
      const sub = bytes.subarray(m.offset, m.offset + mt);
      const ev = `${expr}.${m.nombre}`;
      if (m.bitTam !== undefined) {
        out.push({ name: m.nombre, value: this.bitfield(sub, m.bitDesde ?? 0, m.bitTam), type: `${this.dw.nombreTipo(m.tipo)} : ${m.bitTam}`, variablesReference: 0, evaluateName: ev });
        continue;
      }
      const v: ValorC = sub.length >= Math.min(mt, MAX_VISTA) ? { tipo: m.tipo, dir: dir + m.offset, bytes: sub } : await this.leerValor(m.tipo, dir + m.offset);
      out.push(this.variable(m.nombre, v, ev));
    }
    return out;
  }

  private async hijosArreglo(t: Extract<TipoC, { k: 'arreglo' }>, dir: number, expr: string, start = 0, count?: number): Promise<Variable[]> {
    const n = t.dims[0] ?? 0;
    const elem = t.dims.length > 1 ? this.dw.sintetico({ k: 'arreglo', elem: t.elem, dims: t.dims.slice(1) }) : t.elem;
    const elemTam = this.dw.tamano(elem);
    if (elemTam <= 0) return [];
    // Arreglos enormes sin paginar: se agrupan de a 100, como VS Code.
    if (count === undefined && n > PAGINA && start === 0) {
      const grupos: Variable[] = [];
      for (let g = 0; g < n; g += PAGINA) {
        const hasta = Math.min(n, g + PAGINA) - 1;
        grupos.push({
          name: `[${g}..${hasta}]`,
          value: '',
          variablesReference: this.refs.crear(() => this.hijosArreglo(t, dir, expr, g, hasta - g + 1)),
          indexedVariables: hasta - g + 1,
        });
      }
      return grupos;
    }
    const cuantos = Math.min(count ?? n - start, n - start, 1000);
    const bytes = await this.mem.leer(dir + start * elemTam, cuantos * elemTam);
    const out: Variable[] = [];
    for (let i = 0; i < cuantos; i++) {
      const idx = start + i;
      const sub = bytes.subarray(i * elemTam, (i + 1) * elemTam);
      out.push(this.variable(`[${idx}]`, { tipo: elem, dir: dir + idx * elemTam, bytes: sub }, `${expr}[${idx}]`));
    }
    return out;
  }

  // --- Globales ---------------------------------------------------------------------------------

  /** Variables DAP para una lista de globales, precargando la memoria de una vez. */
  async globales(vars: VariableDwarf[]): Promise<Variable[]> {
    const conCache = this.mem instanceof MemoriaConCache ? this.mem : null;
    if (conCache) await conCache.precargar(vars.map((v) => ({ dir: v.dir, largo: Math.min(this.dw.tamano(v.tipo), MAX_VISTA) })));
    const out: Variable[] = [];
    for (const v of vars) {
      try {
        const leido = await this.leerValor(v.tipo, v.dir);
        out.push(this.variable(v.nombreCompleto, leido, v.nombreCompleto));
      } catch (err) {
        out.push({ name: v.nombreCompleto, value: `<no se pudo leer: ${(err as Error).message}>`, type: this.dw.nombreTipo(v.tipo), variablesReference: 0 });
      }
    }
    return out;
  }

  // --- Evaluación de expresiones ---------------------------------------------------------------

  async evaluar(expresion: string, buscar: (nombre: string) => VariableDwarf | undefined, registro?: (nombre: string) => number | undefined): Promise<ResultadoEvaluacion> {
    const v = await new EvaluadorC(this, buscar, registro).evaluar(expresion);
    const variable = this.variable(expresion, v, expresion);
    return {
      result: variable.value,
      ...(variable.type ? { type: variable.type } : {}),
      variablesReference: variable.variablesReference,
      ...(variable.memoryReference ? { memoryReference: variable.memoryReference } : {}),
    };
  }
}

/** Texto de un char[]: hasta el primer \0, con escapes. */
export function cadenaC(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    if (b === 0x22) s += '\\"';
    else if (b === 0x5c) s += '\\\\';
    else if (b === 0x0a) s += '\\n';
    else if (b === 0x0d) s += '\\r';
    else if (b === 0x09) s += '\\t';
    else if (b >= 32 && b < 127) s += String.fromCharCode(b);
    else s += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return `"${s}"`;
}

// --- Evaluador de expresiones C (subconjunto) ------------------------------------------------------

type Token = { t: 'id' | 'num' | 'op' | 'fin'; v: string };

function tokenizar(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const resto = src.slice(i);
    const num = /^(0x[0-9a-fA-F]+|0b[01]+|\d+(\.\d+)?([eE][-+]?\d+)?)[uUlLfF]*/.exec(resto);
    if (num) {
      out.push({ t: 'num', v: num[1]! });
      i += num[0].length;
      continue;
    }
    const id = /^\$?[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_~][A-Za-z0-9_]*)*/.exec(resto);
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(->|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^!~<>()[\].])/.exec(resto);
    if (op) {
      out.push({ t: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    throw new NoSoportado(`carácter inesperado "${c}" en la expresión`);
  }
  out.push({ t: 'fin', v: '' });
  return out;
}

const PRECEDENCIA: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
};

/**
 * Evaluador de expresiones C de solo lectura, como el "Watch" de un IDE: variables
 * globales (y `func::estatica`), `a.b`, `p->b`, `x[3]`, `*p`, `&x`, números, aritmética
 * y comparaciones, y registros con `$pc`, `$sp`... No llama funciones ni escribe memoria.
 */
class EvaluadorC {
  private toks: Token[] = [];
  private i = 0;

  constructor(
    private readonly f: FormateadorC,
    private readonly buscar: (nombre: string) => VariableDwarf | undefined,
    private readonly registro?: (nombre: string) => number | undefined,
  ) {}

  async evaluar(src: string): Promise<ValorC> {
    if (src.length > 300) throw new NoSoportado('expresión demasiado larga (máximo 300 caracteres)');
    this.toks = tokenizar(src);
    this.i = 0;
    const v = await this.binaria(0);
    if (this.ver().t !== 'fin') throw new NoSoportado(`sobra "${this.ver().v}" en la expresión`);
    return v;
  }

  private ver(): Token {
    return this.toks[this.i]!;
  }

  private tomar(): Token {
    return this.toks[this.i++]!;
  }

  private esperar(v: string): void {
    const t = this.tomar();
    if (t.v !== v) throw new NoSoportado(`se esperaba "${v}" y vino "${t.v || 'el final'}"`);
  }

  private num(n: number, nombreTipo = 'int'): ValorC {
    return { tipo: null, dir: null, bytes: new Uint8Array(0), numero: n, nombreTipo };
  }

  private async binaria(minPrec: number): Promise<ValorC> {
    let izq = await this.unaria();
    for (;;) {
      const op = this.ver();
      const p = op.t === 'op' ? PRECEDENCIA[op.v] : undefined;
      if (p === undefined || p < minPrec) break;
      this.tomar();
      const der = await this.binaria(p + 1);
      const a = this.f.numeroDe(izq);
      const b = this.f.numeroDe(der);
      izq = this.num(operar(op.v, a, b), ['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(op.v) ? 'bool' : 'long');
    }
    return izq;
  }

  private async unaria(): Promise<ValorC> {
    const t = this.ver();
    if (t.t === 'op' && ['-', '!', '~', '*', '&', '+'].includes(t.v)) {
      this.tomar();
      const v = await this.unaria();
      switch (t.v) {
        case '-':
          return this.num(-this.f.numeroDe(v));
        case '+':
          return v;
        case '!':
          return this.num(this.f.numeroDe(v) ? 0 : 1, 'bool');
        case '~':
          return this.num(~this.f.numeroDe(v));
        case '&':
          if (v.dir === null) throw new NoSoportado('no se puede tomar la dirección de un valor calculado');
          return this.num(v.dir, `${v.nombreTipo ?? this.f.dw.nombreTipo(v.tipo)} *`);
        case '*':
          return this.desreferenciar(v, 0);
      }
    }
    return this.postfija(await this.primaria());
  }

  private async desreferenciar(v: ValorC, indice: number): Promise<ValorC> {
    const { t } = this.f.dw.resolver(v.tipo);
    if (t.k === 'puntero') {
      const p = this.f.numeroDe(v);
      if (p === 0) throw new NoSoportado('puntero NULL');
      const tam = this.f.dw.tamano(t.destino);
      if (tam <= 0) throw new NoSoportado(`no se puede desreferenciar un ${this.f.dw.nombreTipo(v.tipo)}`);
      return this.f.leerValor(t.destino, this.f.mem.desdePuntero(p) + indice * tam);
    }
    if (t.k === 'arreglo' && v.dir !== null) {
      const n = t.dims[0] ?? 0;
      if (n > 0 && (indice < 0 || indice >= n)) throw new NoSoportado(`índice ${indice} fuera del arreglo [${n}]`);
      // Arreglo de varias dimensiones: la fila es un tipo sintético con las dimensiones que quedan.
      const elem = t.dims.length > 1 ? this.f.dw.sintetico({ k: 'arreglo', elem: t.elem, dims: t.dims.slice(1) }) : t.elem;
      return this.f.leerValor(elem, v.dir + indice * this.f.dw.tamano(elem));
    }
    if (v.numero !== undefined) throw new NoSoportado('para leer una dirección cruda usá /api/debug/memory');
    throw new NoSoportado(`no se puede indexar ni desreferenciar un ${this.f.dw.nombreTipo(v.tipo)}`);
  }

  private async postfija(v: ValorC): Promise<ValorC> {
    let actual = v;
    for (;;) {
      const t = this.ver();
      if (t.v === '[') {
        this.tomar();
        const idx = await this.binaria(0);
        this.esperar(']');
        actual = await this.desreferenciar(actual, this.f.numeroDe(idx));
      } else if (t.v === '.' || t.v === '->') {
        this.tomar();
        const nombre = this.tomar();
        if (nombre.t !== 'id') throw new NoSoportado(`falta el nombre del miembro después de "${t.v}"`);
        // `obj->campo` sobre un objeto (no puntero) se toma como `obj.campo`: así `contador->value_`
        // anda igual para un id de ESPHome (que se muestra como el objeto) que para un puntero.
        if (t.v === '->' && this.f.dw.resolver(actual.tipo).t.k !== 'struct') actual = await this.desreferenciar(actual, 0);
        actual = await this.miembro(actual, nombre.v);
      } else return actual;
    }
  }

  private async miembro(v: ValorC, nombre: string): Promise<ValorC> {
    const { t } = this.f.dw.resolver(v.tipo);
    if (t.k !== 'struct') throw new NoSoportado(`"${this.f.dw.nombreTipo(v.tipo)}" no es un struct/clase: no tiene "${nombre}"`);
    if (v.dir === null) throw new NoSoportado('miembro de un valor sin dirección');
    const m = t.miembros.find((x) => x.nombre === nombre);
    if (!m) {
      const disponibles = t.miembros.map((x) => x.nombre).slice(0, 20).join(', ');
      throw new NoSoportado(`"${t.nombre || 'struct'}" no tiene "${nombre}" (miembros: ${disponibles})`);
    }
    if (m.bitTam !== undefined) {
      const bytes = await this.f.mem.leer(v.dir + m.offset, Math.max(1, this.f.dw.tamano(m.tipo)));
      let x = 0n;
      for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]!);
      return this.num(Number((x >> BigInt(m.bitDesde ?? 0)) & ((1n << BigInt(m.bitTam)) - 1n)), this.f.dw.nombreTipo(m.tipo));
    }
    return this.f.leerValor(m.tipo, v.dir + m.offset);
  }

  private async primaria(): Promise<ValorC> {
    const t = this.tomar();
    if (t.t === 'num') {
      const n = t.v.startsWith('0b') ? parseInt(t.v.slice(2), 2) : Number(t.v);
      return this.num(n, Number.isInteger(n) ? 'int' : 'double');
    }
    if (t.v === '(') {
      const v = await this.binaria(0);
      this.esperar(')');
      return v;
    }
    if (t.t === 'id') {
      if (t.v.startsWith('$')) {
        const r = this.registro?.(t.v.slice(1));
        if (r === undefined) throw new NoSoportado(`registro desconocido ${t.v}`);
        return this.num(r, 'registro');
      }
      if (t.v === 'true' || t.v === 'false') return this.num(t.v === 'true' ? 1 : 0, 'bool');
      const g = this.buscar(t.v);
      if (!g) throw new NoSoportado(`no hay una variable global "${t.v}" (solo globales y static; las locales no se ven)`);
      return this.f.leerValor(g.tipo, g.dir);
    }
    throw new NoSoportado(`expresión inválida cerca de "${t.v || 'el final'}"`);
  }
}

function operar(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      if (b === 0) throw new NoSoportado('división por cero');
      return Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
    case '%':
      if (b === 0) throw new NoSoportado('división por cero');
      return a % b;
    case '<<':
      return a * 2 ** b;
    case '>>':
      return Math.floor(a / 2 ** b);
    case '&':
      return Number(BigInt(Math.trunc(a)) & BigInt(Math.trunc(b)));
    case '|':
      return Number(BigInt(Math.trunc(a)) | BigInt(Math.trunc(b)));
    case '^':
      return Number(BigInt(Math.trunc(a)) ^ BigInt(Math.trunc(b)));
    case '==':
      return a === b ? 1 : 0;
    case '!=':
      return a !== b ? 1 : 0;
    case '<':
      return a < b ? 1 : 0;
    case '>':
      return a > b ? 1 : 0;
    case '<=':
      return a <= b ? 1 : 0;
    case '>=':
      return a >= b ? 1 : 0;
    case '&&':
      return a && b ? 1 : 0;
    case '||':
      return a || b ? 1 : 0;
    default:
      throw new NoSoportado(`operador ${op} no soportado`);
  }
}

/**
 * ¿Es código del usuario? (para separar "tus globales" de las del framework).
 * Mira el archivo de la declaración: sketch.cpp de arduino-cli, main/ de ESP-IDF,
 * src/main.cpp de ESPHome (lo genera del YAML del usuario).
 */
export function esDelUsuario(v: { archivo: string | null; cu: string }): boolean {
  const ruta = v.archivo ?? v.cu;
  if (!ruta) return false;
  if (/(^|\/)(components|managed_components|frameworks|esp-idf|arduino-esp32|packages\/arduino|newlib|\.platformio)\//.test(ruta)) return false;
  if (/(^|\/)sketch\/[^/]+$/.test(ruta)) return true; // arduino-cli: /build/sketch/sketch.cpp
  if (/(^|\/)main\/[^/]+\.(c|cc|cpp|cxx|h|hpp)$/.test(ruta)) return true; // ESP-IDF: /project/main/main.c
  if (/(^|\/)src\/main\.cpp$/.test(ruta)) return true; // ESPHome: src/main.cpp (del YAML)
  if (/(^|\/)sketch\.(cpp|ino)$/.test(ruta)) return true;
  return false;
}
