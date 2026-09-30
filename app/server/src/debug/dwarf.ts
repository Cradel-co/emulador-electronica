import path from 'node:path';
import { desarmarCpp, type ArchivoElf } from './elf.js';

/**
 * Lector de DWARF (versiones 2 a 5) para el modo debug, sin gdb: el emulador no trae
 * un gdb de Xtensa/RISC-V/AVR (verificado: ni la imagen de ESPHome ni la de
 * arduino-cli lo tienen, y la de ESP-IDF pesa 3 GB), así que los tipos y las líneas
 * se sacan directo del .elf. Alcance, a propósito acotado:
 *
 *  - Variables globales y `static` (las que tienen dirección fija, DW_OP_addr): nombre
 *    completo (con namespace/clase), tipo, archivo y línea de la declaración.
 *  - Tipos: base, punteros, arreglos, struct/class/union con sus miembros (bitfields
 *    incluidos), enum, typedef, const/volatile.
 *  - Funciones (DW_TAG_subprogram con low_pc/high_pc): para "¿en qué función está?".
 *  - Tabla de líneas (.debug_line): dirección ↔ archivo:línea, para breakpoints por
 *    línea y para mostrar dónde frenó.
 *
 * Fuera de alcance: variables locales (necesitan CFI y listas de ubicaciones), tipos
 * de .debug_types (DWARF 4 con -fdebug-types-section, poco usado en firmware).
 *
 * Los tipos se leen perezosos (se parsea el DIE recién cuando alguien lo pide), así un
 * .elf de ESPHome (~5 MB de .debug_info) se indexa en una sola pasada liviana.
 */

// --- Constantes DWARF (solo las que se usan) --------------------------------------

const DW_TAG = {
  array_type: 0x01,
  class_type: 0x02,
  enumeration_type: 0x04,
  lexical_block: 0x0b,
  member: 0x0d,
  pointer_type: 0x0f,
  reference_type: 0x10,
  compile_unit: 0x11,
  structure_type: 0x13,
  subroutine_type: 0x15,
  typedef: 0x16,
  union_type: 0x17,
  inlined_subroutine: 0x1d,
  inheritance: 0x1c,
  ptr_to_member_type: 0x1f,
  subrange_type: 0x21,
  base_type: 0x24,
  const_type: 0x26,
  enumerator: 0x28,
  subprogram: 0x2e,
  variable: 0x34,
  volatile_type: 0x35,
  restrict_type: 0x37,
  namespace: 0x39,
  unspecified_type: 0x3b,
  rvalue_reference_type: 0x42,
  atomic_type: 0x47,
  partial_unit: 0x3c,
  skeleton_unit: 0x4a,
} as const;

const DW_AT = {
  sibling: 0x01,
  location: 0x02,
  name: 0x03,
  byte_size: 0x0b,
  bit_offset: 0x0c,
  bit_size: 0x0d,
  stmt_list: 0x10,
  low_pc: 0x11,
  high_pc: 0x12,
  comp_dir: 0x1b,
  const_value: 0x1c,
  upper_bound: 0x2f,
  abstract_origin: 0x31,
  count: 0x37,
  data_member_location: 0x38,
  decl_file: 0x3a,
  decl_line: 0x3b,
  declaration: 0x3c,
  encoding: 0x3e,
  external: 0x3f,
  specification: 0x47,
  type: 0x49,
  data_bit_offset: 0x6b,
  linkage_name: 0x6e,
  str_offsets_base: 0x72,
  addr_base: 0x73,
  MIPS_linkage_name: 0x2007,
} as const;

const DW_FORM = {
  addr: 0x01,
  block2: 0x03,
  block4: 0x04,
  data2: 0x05,
  data4: 0x06,
  data8: 0x07,
  string: 0x08,
  block: 0x09,
  block1: 0x0a,
  data1: 0x0b,
  flag: 0x0c,
  sdata: 0x0d,
  strp: 0x0e,
  udata: 0x0f,
  ref_addr: 0x10,
  ref1: 0x11,
  ref2: 0x12,
  ref4: 0x13,
  ref8: 0x14,
  ref_udata: 0x15,
  indirect: 0x16,
  sec_offset: 0x17,
  exprloc: 0x18,
  flag_present: 0x19,
  strx: 0x1a,
  addrx: 0x1b,
  ref_sup4: 0x1c,
  strp_sup: 0x1d,
  data16: 0x1e,
  line_strp: 0x1f,
  ref_sig8: 0x20,
  implicit_const: 0x21,
  loclistx: 0x22,
  rnglistx: 0x23,
  ref_sup8: 0x24,
  strx1: 0x25,
  strx2: 0x26,
  strx3: 0x27,
  strx4: 0x28,
  addrx1: 0x29,
  addrx2: 0x2a,
  addrx3: 0x2b,
  addrx4: 0x2c,
  GNU_addr_index: 0x1f01,
  GNU_str_index: 0x1f02,
  GNU_ref_alt: 0x1f20,
  GNU_strp_alt: 0x1f21,
} as const;

/** Codificaciones de DW_TAG_base_type (DW_ATE_*). */
export const DW_ATE = {
  address: 0x01,
  boolean: 0x02,
  float: 0x04,
  signed: 0x05,
  signed_char: 0x06,
  unsigned: 0x07,
  unsigned_char: 0x08,
  UTF: 0x10,
} as const;

const DW_OP_addr = 0x03;
const DW_OP_plus_uconst = 0x23;
const DW_OP_addrx = 0xa1;
const DW_OP_GNU_addr_index = 0xfb;

// --- Lectura de bytes -------------------------------------------------------------

class Lector {
  constructor(
    readonly b: Buffer,
    public pos = 0,
  ) {}
  u8(): number {
    return this.b[this.pos++]!;
  }
  u16(): number {
    const v = this.b.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u24(): number {
    const v = this.b[this.pos]! | (this.b[this.pos + 1]! << 8) | (this.b[this.pos + 2]! << 16);
    this.pos += 3;
    return v;
  }
  u32(): number {
    const v = this.b.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  /** 64 bits como number (se pierde precisión arriba de 2^53: no pasa en firmware de 32 bits). */
  u64(): number {
    const lo = this.b.readUInt32LE(this.pos);
    const hi = this.b.readUInt32LE(this.pos + 4);
    this.pos += 8;
    return hi * 0x100000000 + lo;
  }
  uleb(): number {
    let r = 0;
    let mul = 1;
    for (;;) {
      const byte = this.b[this.pos++]!;
      r += (byte & 0x7f) * mul;
      if ((byte & 0x80) === 0) return r;
      mul *= 128;
    }
  }
  sleb(): number {
    let r = 0;
    let mul = 1;
    let byte: number;
    do {
      byte = this.b[this.pos++]!;
      r += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte & 0x80);
    if (byte & 0x40) r -= mul;
    return r;
  }
  cstr(): string {
    const ini = this.pos;
    while (this.pos < this.b.length && this.b[this.pos] !== 0) this.pos++;
    const s = this.b.toString('utf8', ini, this.pos);
    this.pos++;
    return s;
  }
  saltarCstr(): void {
    while (this.pos < this.b.length && this.b[this.pos] !== 0) this.pos++;
    this.pos++;
  }
  dir(tam: number): number {
    return tam === 2 ? this.u16() : tam === 8 ? this.u64() : this.u32();
  }
  offset(tam: number): number {
    return tam === 8 ? this.u64() : this.u32();
  }
}

// --- Modelo -----------------------------------------------------------------------

interface AtribAbrev {
  at: number;
  form: number;
  implicito: number;
}

interface Abrev {
  tag: number;
  hijos: boolean;
  attrs: AtribAbrev[];
}

interface Cu {
  offset: number;
  fin: number;
  primerDie: number;
  version: number;
  tamDir: number;
  tamOff: number;
  abrevs: Map<number, Abrev>;
  strOffsetsBase: number;
  addrBase: number;
  nombre: string;
  compDir: string;
  lineas: number | null;
}

type Valor = number | string | Buffer | boolean | null;

interface Die {
  offset: number;
  tag: number;
  hijos: boolean;
  /** Offset del primer hijo (o del siguiente hermano si no tiene hijos). */
  despues: number;
  attrs: Map<number, { v: Valor; form: number }>;
  cu: Cu;
}

export interface Miembro {
  nombre: string;
  offset: number;
  tipo: number | null;
  bitTam?: number;
  /** Bit desde el LSB del almacenamiento (ya convertido de DWARF 2/3 si hacía falta). */
  bitDesde?: number;
}

export type TipoC =
  | { k: 'base'; nombre: string; tam: number; codif: number }
  | { k: 'puntero'; tam: number; destino: number | null; referencia?: boolean }
  | { k: 'arreglo'; elem: number | null; dims: number[] }
  | { k: 'struct'; clase: 'struct' | 'class' | 'union'; nombre: string; tam: number; miembros: Miembro[]; incompleto?: boolean }
  | { k: 'enum'; nombre: string; tam: number; valores: { nombre: string; valor: number }[] }
  | { k: 'typedef'; nombre: string; destino: number | null }
  | { k: 'calif'; calif: 'const' | 'volatile' | 'restrict' | 'atomic'; destino: number | null }
  | { k: 'void' }
  | { k: 'funcion' }
  | { k: 'otro'; nombre: string };

export interface VariableDwarf {
  nombre: string;
  /** Con namespace/clase (`esphome::App`) o función (`loop::contador` para un static local). */
  nombreCompleto: string;
  dir: number;
  tipo: number | null;
  archivo: string | null;
  linea: number | null;
  /** Compilation unit (archivo fuente principal) donde está definida. */
  cu: string;
  externa: boolean;
  /** `static` dentro de una función. */
  estaticaLocal: boolean;
}

export interface FuncionDwarf {
  nombre: string;
  bajo: number;
  alto: number;
  archivo: string | null;
  linea: number | null;
  cu: string;
}

export interface FilaLinea {
  dir: number;
  archivo: string;
  linea: number;
}

interface ProgramaLineas {
  archivos: string[];
}

/** Tabla de líneas completa, compacta (arreglos tipados). */
class TablaLineas {
  dirs = new Uint32Array(0);
  lineas = new Uint32Array(0);
  archivos = new Uint32Array(0);
  /** 1 = la fila siguiente empieza otra secuencia (no hay código entre medio). */
  finSecuencia = new Uint8Array(0);
  esSentencia = new Uint8Array(0);
  nombresArchivo: string[] = [];
}

// --- Parser -----------------------------------------------------------------------

export class InfoDwarf {
  readonly variables: VariableDwarf[] = [];
  /** Globales optimizadas (sin dirección propia): nombre y tipo, `dir` = 0. */
  readonly sinUbicacion: VariableDwarf[] = [];
  readonly funciones: FuncionDwarf[] = [];
  /** Cantidad de compilation units leídas (diagnóstico). */
  unidades = 0;
  /** Unidades que no se pudieron indexar (diagnóstico). */
  readonly unidadesConError: string[] = [];
  private readonly info: Buffer;
  private readonly abbrev: Buffer;
  private readonly str: Buffer;
  private readonly lineStr: Buffer;
  private readonly strOffsets: Buffer;
  private readonly addr: Buffer;
  private readonly line: Buffer;
  private readonly cus: Cu[] = [];
  private readonly abrevCache = new Map<number, Map<number, Abrev>>();
  private readonly tipos = new Map<number, TipoC>();
  /** Declaraciones (miembros static, métodos) → nombre calificado, para las definiciones con DW_AT_specification. */
  private readonly declaraciones = new Map<number, { nombre: string; tipo: number | null }>();
  /** Structs completos por nombre calificado (para resolver declaraciones incompletas). */
  private readonly structsPorNombre = new Map<string, number>();
  private readonly programas = new Map<number, ProgramaLineas>();
  private tabla: TablaLineas | null = null;
  private funcionesOrdenadas: FuncionDwarf[] | null = null;
  readonly tamDir: number;

  constructor(elf: ArchivoElf) {
    this.info = elf.contenido('.debug_info');
    this.abbrev = elf.contenido('.debug_abbrev');
    this.str = elf.contenido('.debug_str');
    this.lineStr = elf.contenido('.debug_line_str');
    this.strOffsets = elf.contenido('.debug_str_offsets');
    this.addr = elf.contenido('.debug_addr');
    this.line = elf.contenido('.debug_line');
    this.tamDir = elf.arquitectura === 'avr' ? 2 : 4;
    this.indexar();
  }

  get tieneInfo(): boolean {
    return this.info.length > 0;
  }

  // --- Unidades y abreviaturas ------------------------------------------------------

  private abreviaturas(off: number): Map<number, Abrev> {
    const ya = this.abrevCache.get(off);
    if (ya) return ya;
    const m = new Map<number, Abrev>();
    const l = new Lector(this.abbrev, off);
    while (l.pos < this.abbrev.length) {
      const codigo = l.uleb();
      if (codigo === 0) break;
      const tag = l.uleb();
      const hijos = l.u8() === 1;
      const attrs: AtribAbrev[] = [];
      for (;;) {
        const at = l.uleb();
        const form = l.uleb();
        if (at === 0 && form === 0) break;
        const implicito = form === DW_FORM.implicit_const ? l.sleb() : 0;
        attrs.push({ at, form, implicito });
      }
      m.set(codigo, { tag, hijos, attrs });
    }
    this.abrevCache.set(off, m);
    return m;
  }

  private leerCabeceraCu(offset: number): Cu | null {
    const l = new Lector(this.info, offset);
    let largo = l.u32();
    let tamOff = 4;
    if (largo === 0xffffffff) {
      largo = l.u64();
      tamOff = 8;
    }
    const inicioDatos = l.pos;
    const fin = inicioDatos + largo;
    const version = l.u16();
    let tamDir: number;
    let abrevOff: number;
    if (version >= 5) {
      const tipoUnidad = l.u8();
      tamDir = l.u8();
      abrevOff = l.offset(tamOff);
      if (tipoUnidad === 2 || tipoUnidad === 6) {
        l.pos += 8 + tamOff; // type unit: firma + offset del tipo
      } else if (tipoUnidad === 4 || tipoUnidad === 5) {
        l.pos += 8; // skeleton / split: dwo_id
      }
      if (tipoUnidad !== 1 && tipoUnidad !== 3) {
        return { offset, fin, primerDie: -1, version, tamDir, tamOff, abrevs: new Map(), strOffsetsBase: 0, addrBase: 0, nombre: '', compDir: '', lineas: null };
      }
    } else {
      abrevOff = l.offset(tamOff);
      tamDir = l.u8();
    }
    if (version < 2 || version > 5) return null;
    return {
      offset,
      fin,
      primerDie: l.pos,
      version,
      tamDir,
      tamOff,
      abrevs: this.abreviaturas(abrevOff),
      // DWARF 5 sin DW_AT_str_offsets_base: el estándar dice que es 8 (después de la cabecera).
      strOffsetsBase: 8,
      addrBase: 8,
      nombre: '',
      compDir: '',
      lineas: null,
    };
  }

  // --- Valores de atributos ---------------------------------------------------------

  private cadenaEn(buf: Buffer, off: number): string {
    if (off < 0 || off >= buf.length) return '';
    let fin = off;
    while (fin < buf.length && buf[fin] !== 0) fin++;
    return buf.toString('utf8', off, fin);
  }

  private strx(cu: Cu, i: number): string {
    const o = cu.strOffsetsBase + i * cu.tamOff;
    if (o + cu.tamOff > this.strOffsets.length) return '';
    const off = cu.tamOff === 8 ? Number(this.strOffsets.readBigUInt64LE(o)) : this.strOffsets.readUInt32LE(o);
    return this.cadenaEn(this.str, off);
  }

  private addrx(cu: Cu, i: number): number {
    const o = cu.addrBase + i * cu.tamDir;
    if (o + cu.tamDir > this.addr.length) return 0;
    return cu.tamDir === 2 ? this.addr.readUInt16LE(o) : this.addr.readUInt32LE(o);
  }

  /** Lee (o saltea, con `leer=false`) el valor de un atributo. Las referencias vuelven absolutas. */
  private valor(l: Lector, form: number, cu: Cu, implicito: number, leer: boolean): Valor {
    switch (form) {
      case DW_FORM.addr:
        return l.dir(cu.tamDir);
      case DW_FORM.data1:
      case DW_FORM.flag:
        return l.u8();
      case DW_FORM.data2:
        return l.u16();
      case DW_FORM.data4:
        return l.u32();
      case DW_FORM.data8:
        return l.u64();
      case DW_FORM.data16:
        l.pos += 16;
        return null;
      case DW_FORM.sdata:
        return l.sleb();
      case DW_FORM.udata:
        return l.uleb();
      case DW_FORM.string:
        if (!leer) {
          l.saltarCstr();
          return null;
        }
        return l.cstr();
      case DW_FORM.strp:
      case DW_FORM.GNU_strp_alt:
      case DW_FORM.strp_sup: {
        const off = l.offset(cu.tamOff);
        return leer && form === DW_FORM.strp ? this.cadenaEn(this.str, off) : null;
      }
      case DW_FORM.line_strp: {
        const off = l.offset(cu.tamOff);
        return leer ? this.cadenaEn(this.lineStr, off) : null;
      }
      case DW_FORM.strx:
      case DW_FORM.GNU_str_index: {
        const i = l.uleb();
        return leer ? this.strx(cu, i) : null;
      }
      case DW_FORM.strx1:
        return this.strxLeido(cu, l.u8(), leer);
      case DW_FORM.strx2:
        return this.strxLeido(cu, l.u16(), leer);
      case DW_FORM.strx3:
        return this.strxLeido(cu, l.u24(), leer);
      case DW_FORM.strx4:
        return this.strxLeido(cu, l.u32(), leer);
      case DW_FORM.addrx:
      case DW_FORM.GNU_addr_index:
        return this.addrx(cu, l.uleb());
      case DW_FORM.addrx1:
        return this.addrx(cu, l.u8());
      case DW_FORM.addrx2:
        return this.addrx(cu, l.u16());
      case DW_FORM.addrx3:
        return this.addrx(cu, l.u24());
      case DW_FORM.addrx4:
        return this.addrx(cu, l.u32());
      case DW_FORM.ref1:
        return cu.offset + l.u8();
      case DW_FORM.ref2:
        return cu.offset + l.u16();
      case DW_FORM.ref4:
        return cu.offset + l.u32();
      case DW_FORM.ref8:
        return cu.offset + l.u64();
      case DW_FORM.ref_udata:
        return cu.offset + l.uleb();
      case DW_FORM.ref_addr:
        return cu.version <= 2 ? l.dir(cu.tamDir) : l.offset(cu.tamOff);
      case DW_FORM.GNU_ref_alt:
        l.offset(cu.tamOff);
        return null;
      case DW_FORM.ref_sig8:
        l.pos += 8;
        return null;
      case DW_FORM.ref_sup4:
        l.pos += 4;
        return null;
      case DW_FORM.ref_sup8:
        l.pos += 8;
        return null;
      case DW_FORM.sec_offset:
        return l.offset(cu.tamOff);
      case DW_FORM.exprloc:
      case DW_FORM.block: {
        const n = l.uleb();
        const b = leer ? this.info.subarray(l.pos, l.pos + n) : null;
        l.pos += n;
        return b;
      }
      case DW_FORM.block1: {
        const n = l.u8();
        const b = leer ? this.info.subarray(l.pos, l.pos + n) : null;
        l.pos += n;
        return b;
      }
      case DW_FORM.block2: {
        const n = l.u16();
        const b = leer ? this.info.subarray(l.pos, l.pos + n) : null;
        l.pos += n;
        return b;
      }
      case DW_FORM.block4: {
        const n = l.u32();
        const b = leer ? this.info.subarray(l.pos, l.pos + n) : null;
        l.pos += n;
        return b;
      }
      case DW_FORM.flag_present:
        return true;
      case DW_FORM.implicit_const:
        return implicito;
      case DW_FORM.loclistx:
      case DW_FORM.rnglistx:
        return l.uleb();
      case DW_FORM.indirect: {
        const real = l.uleb();
        return this.valor(l, real, cu, implicito, leer);
      }
      default:
        throw new Error(`forma DWARF desconocida 0x${form.toString(16)} en ${l.pos}`);
    }
  }

  private strxLeido(cu: Cu, i: number, leer: boolean): string | null {
    return leer ? this.strx(cu, i) : null;
  }

  /** Lee un DIE completo (todos sus atributos). null si es una entrada nula (fin de hijos). */
  private leerDieEn(offset: number, cu: Cu): Die | null {
    const l = new Lector(this.info, offset);
    const codigo = l.uleb();
    if (codigo === 0) return null;
    const ab = cu.abrevs.get(codigo);
    if (!ab) throw new Error(`abreviatura DWARF ${codigo} inexistente en ${offset}`);
    const attrs = new Map<number, { v: Valor; form: number }>();
    for (const a of ab.attrs) attrs.set(a.at, { v: this.valor(l, a.form, cu, a.implicito, true), form: a.form });
    return { offset, tag: ab.tag, hijos: ab.hijos, despues: l.pos, attrs, cu };
  }

  private cuDe(offset: number): Cu | undefined {
    let lo = 0;
    let hi = this.cus.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.cus[mid]!;
      if (offset < c.offset) hi = mid - 1;
      else if (offset >= c.fin) lo = mid + 1;
      else return c;
    }
    return undefined;
  }

  private die(offset: number): Die | null {
    const cu = this.cuDe(offset);
    if (!cu) return null;
    try {
      return this.leerDieEn(offset, cu);
    } catch {
      return null;
    }
  }

  /** Offset del siguiente hermano de un DIE (salteando todo su subárbol). */
  private saltarSubarbol(d: Die): number {
    const sib = d.attrs.get(DW_AT.sibling)?.v;
    if (typeof sib === 'number' && sib > d.offset) return sib;
    if (!d.hijos) return d.despues;
    let pos = d.despues;
    for (;;) {
      const h = this.leerDieEn(pos, d.cu);
      if (!h) return pos + 1; // entrada nula: 1 byte (código 0)
      pos = this.saltarSubarbol(h);
    }
  }

  private *hijos(d: Die): Generator<Die> {
    if (!d.hijos) return;
    let pos = d.despues;
    for (let guarda = 0; guarda < 100_000; guarda++) {
      const h = this.leerDieEn(pos, d.cu);
      if (!h) return;
      yield h;
      pos = this.saltarSubarbol(h);
    }
  }

  // --- Pasada de indexación -------------------------------------------------------------

  private indexar(): void {
    let off = 0;
    while (off + 11 <= this.info.length) {
      const cu = this.leerCabeceraCu(off);
      if (!cu || cu.fin <= off) break;
      this.cus.push(cu);
      if (cu.primerDie >= 0) {
        try {
          this.indexarCu(cu);
        } catch (err) {
          // Una CU rara no invalida el resto: se sigue con la próxima.
          this.unidadesConError.push(`${cu.nombre || `CU@${cu.offset}`}: ${(err as Error).message}`);
        }
      }
      off = cu.fin;
    }
    this.unidades = this.cus.length;
  }

  private indexarCu(cu: Cu): void {
    const l = new Lector(this.info, cu.primerDie);
    /** Pila de ámbitos: nombre (o null si no califica) y si es una función. */
    const pila: { nombre: string | null; funcion: string | null; tag: number }[] = [];
    let primero = true;
    while (l.pos < cu.fin) {
      const offset = l.pos;
      const codigo = l.uleb();
      if (codigo === 0) {
        pila.pop();
        if (pila.length === 0 && !primero) break;
        continue;
      }
      const ab = cu.abrevs.get(codigo);
      if (!ab) throw new Error(`abreviatura ${codigo} inexistente`);
      const tag = ab.tag;
      const interesa =
        tag === DW_TAG.compile_unit ||
        tag === DW_TAG.partial_unit ||
        tag === DW_TAG.variable ||
        tag === DW_TAG.subprogram ||
        tag === DW_TAG.namespace ||
        tag === DW_TAG.structure_type ||
        tag === DW_TAG.class_type ||
        tag === DW_TAG.union_type ||
        (tag === DW_TAG.member && pila.length > 0);
      let attrs: Map<number, Valor> | null = null;
      if (interesa) {
        attrs = new Map();
        for (const a of ab.attrs) attrs.set(a.at, this.valor(l, a.form, cu, a.implicito, true));
        if (tag === DW_TAG.compile_unit || tag === DW_TAG.partial_unit) {
          // Las bases van antes de resolver strx/addrx del resto de la unidad.
          const sob = attrs.get(DW_AT.str_offsets_base);
          if (typeof sob === 'number') cu.strOffsetsBase = sob;
          const ab2 = attrs.get(DW_AT.addr_base);
          if (typeof ab2 === 'number') cu.addrBase = ab2;
          // Con las bases ya puestas, se relee el nombre (si venía por strx).
          l.pos = offset;
          l.uleb();
          attrs = new Map();
          for (const a of ab.attrs) attrs.set(a.at, this.valor(l, a.form, cu, a.implicito, true));
          cu.nombre = String(attrs.get(DW_AT.name) ?? '');
          cu.compDir = String(attrs.get(DW_AT.comp_dir) ?? '');
          const sl = attrs.get(DW_AT.stmt_list);
          cu.lineas = typeof sl === 'number' ? sl : null;
        }
      } else {
        for (const a of ab.attrs) this.valor(l, a.form, cu, a.implicito, false);
      }
      primero = false;

      let prefijo: string[] = [];
      if (attrs) {
        const ambito = pila[pila.length - 1];
        prefijo = pila.map((p) => p.nombre).filter((n): n is string => Boolean(n));
        let funcionActual: string | null = null;
        for (let i = pila.length - 1; i >= 0 && funcionActual === null; i--) funcionActual = pila[i]!.funcion;
        this.procesarDie(tag, offset, attrs, cu, prefijo, funcionActual, ambito?.tag ?? null);
      }

      if (ab.hijos) {
        let nombreAmbito: string | null = null;
        let funcion: string | null = null;
        if (attrs && (tag === DW_TAG.namespace || tag === DW_TAG.structure_type || tag === DW_TAG.class_type || tag === DW_TAG.union_type)) {
          const n = attrs.get(DW_AT.name);
          nombreAmbito = typeof n === 'string' ? n : tag === DW_TAG.namespace ? '(anónimo)' : null;
        }
        if (tag === DW_TAG.subprogram && attrs) funcion = this.nombreFuncion(attrs, prefijo) ?? '?';
        pila.push({ nombre: nombreAmbito, funcion, tag });
      }
    }
  }

  private nombreFuncion(attrs: Map<number, Valor>, prefijo: string[]): string | null {
    const n = attrs.get(DW_AT.name);
    if (typeof n === 'string') return [...prefijo, n].join('::');
    for (const at of [DW_AT.specification, DW_AT.abstract_origin]) {
      const ref = attrs.get(at);
      if (typeof ref === 'number') {
        const d = this.declaraciones.get(ref);
        if (d) return d.nombre;
        const die = this.die(ref);
        const nn = die?.attrs.get(DW_AT.name)?.v;
        if (typeof nn === 'string') return nn;
        const ln = die?.attrs.get(DW_AT.linkage_name)?.v ?? die?.attrs.get(DW_AT.MIPS_linkage_name)?.v;
        if (typeof ln === 'string') return desarmarCpp(ln);
      }
    }
    const ln = attrs.get(DW_AT.linkage_name) ?? attrs.get(DW_AT.MIPS_linkage_name);
    return typeof ln === 'string' ? desarmarCpp(ln) : null;
  }

  private procesarDie(
    tag: number,
    offset: number,
    attrs: Map<number, Valor>,
    cu: Cu,
    prefijo: string[],
    funcion: string | null,
    tagPadre: number | null,
  ): void {
    const nombre = attrs.get(DW_AT.name);
    const tipo = attrs.get(DW_AT.type);
    const declaracion = attrs.get(DW_AT.declaration) === true || attrs.get(DW_AT.declaration) === 1;

    if (tag === DW_TAG.structure_type || tag === DW_TAG.class_type || tag === DW_TAG.union_type) {
      if (typeof nombre === 'string' && !declaracion && typeof attrs.get(DW_AT.byte_size) === 'number') {
        const completo = [...prefijo, nombre].join('::');
        if (!this.structsPorNombre.has(completo)) this.structsPorNombre.set(completo, offset);
      }
      return;
    }

    // Declaraciones dentro de clases (miembros static y métodos): se guardan para las definiciones de afuera.
    if (declaracion && typeof nombre === 'string' && (tag === DW_TAG.member || tag === DW_TAG.variable || tag === DW_TAG.subprogram)) {
      this.declaraciones.set(offset, { nombre: [...prefijo, nombre].join('::'), tipo: typeof tipo === 'number' ? tipo : null });
      if (tag !== DW_TAG.variable) return;
    }

    if (tag === DW_TAG.subprogram) {
      const bajo = attrs.get(DW_AT.low_pc);
      const alto = attrs.get(DW_AT.high_pc);
      // low_pc = 0: función que el enlazador descartó (--gc-sections).
      if (typeof bajo !== 'number' || typeof alto !== 'number' || bajo === 0) return;
      // DWARF 4+: high_pc como constante = largo; como dirección = fin.
      const forma = this.formaDe(cu, offset, DW_AT.high_pc);
      const esDireccion =
        forma === DW_FORM.addr ||
        forma === DW_FORM.addrx ||
        forma === DW_FORM.GNU_addr_index ||
        (forma !== undefined && forma >= DW_FORM.addrx1 && forma <= DW_FORM.addrx4);
      const fin = esDireccion ? alto : bajo + alto;
      const n = this.nombreFuncion(attrs, prefijo) ?? `func_0x${bajo.toString(16)}`;
      this.funciones.push({
        nombre: n,
        bajo,
        alto: fin,
        archivo: this.archivoDecl(cu, attrs.get(DW_AT.decl_file)),
        linea: typeof attrs.get(DW_AT.decl_line) === 'number' ? (attrs.get(DW_AT.decl_line) as number) : null,
        cu: cu.nombre,
      });
      return;
    }

    if (tag !== DW_TAG.variable) return;
    const loc = attrs.get(DW_AT.location);
    if (!Buffer.isBuffer(loc) || loc.length === 0) {
      // Definición sin ubicación (el compilador la reemplazó por su valor constante), a nivel de
      // archivo: ESPHome declara así cada `id:` (un puntero const a su "__pstorage"). Se guardan
      // aparte para poder reconstruirlas (ver adaptadorC.ts).
      if (!declaracion && funcion === null && typeof nombre === 'string' && typeof tipo === 'number') {
        this.sinUbicacion.push({
          nombre,
          nombreCompleto: [...prefijo, nombre].join('::'),
          dir: 0,
          tipo,
          archivo: this.archivoDecl(cu, attrs.get(DW_AT.decl_file)),
          linea: typeof attrs.get(DW_AT.decl_line) === 'number' ? (attrs.get(DW_AT.decl_line) as number) : null,
          cu: cu.nombre,
          externa: false,
          estaticaLocal: false,
        });
      }
      return;
    }
    const dir = this.direccionFija(loc, cu);
    if (dir === null || dir === 0) return; // 0 = descartada por el enlazador

    let n = typeof nombre === 'string' ? nombre : null;
    let completo: string | null = n ? [...prefijo, n].join('::') : null;
    let t = typeof tipo === 'number' ? tipo : null;
    const spec = attrs.get(DW_AT.specification);
    if (typeof spec === 'number') {
      const d = this.declaraciones.get(spec);
      if (d) {
        completo = d.nombre;
        n = d.nombre.split('::').pop() ?? d.nombre;
        t ??= d.tipo;
      } else {
        const die = this.die(spec);
        const nn = die?.attrs.get(DW_AT.name)?.v;
        if (typeof nn === 'string') {
          n = nn;
          completo = nn;
        }
        const tt = die?.attrs.get(DW_AT.type)?.v;
        if (t === null && typeof tt === 'number') t = tt;
      }
    }
    const origen = attrs.get(DW_AT.abstract_origin);
    if (!n && typeof origen === 'number') {
      const die = this.die(origen);
      const nn = die?.attrs.get(DW_AT.name)?.v;
      if (typeof nn === 'string') n = completo = nn;
      const tt = die?.attrs.get(DW_AT.type)?.v;
      if (t === null && typeof tt === 'number') t = tt;
    }
    if (!n || !completo) {
      const ln = attrs.get(DW_AT.linkage_name) ?? attrs.get(DW_AT.MIPS_linkage_name);
      if (typeof ln !== 'string') return;
      completo = desarmarCpp(ln);
      n = completo.split('::').pop() ?? completo;
    }
    const estaticaLocal = funcion !== null && tagPadre !== DW_TAG.compile_unit;
    this.variables.push({
      nombre: n,
      nombreCompleto: estaticaLocal ? `${funcion}::${n}` : completo,
      dir,
      tipo: t,
      archivo: this.archivoDecl(cu, attrs.get(DW_AT.decl_file)),
      linea: typeof attrs.get(DW_AT.decl_line) === 'number' ? (attrs.get(DW_AT.decl_line) as number) : null,
      cu: cu.nombre,
      externa: attrs.get(DW_AT.external) === true || attrs.get(DW_AT.external) === 1,
      estaticaLocal,
    });
  }

  private formaDe(cu: Cu, offset: number, at: number): number | undefined {
    const l = new Lector(this.info, offset);
    const ab = cu.abrevs.get(l.uleb());
    return ab?.attrs.find((a) => a.at === at)?.form;
  }

  /** Dirección de una ubicación de la forma DW_OP_addr X (o addrx), o null si no es fija. */
  private direccionFija(loc: Buffer, cu: Cu): number | null {
    const l = new Lector(loc, 0);
    const op = l.u8();
    let dir: number;
    if (op === DW_OP_addr) dir = l.dir(cu.tamDir);
    else if (op === DW_OP_addrx || op === DW_OP_GNU_addr_index) dir = this.addrx(cu, l.uleb());
    else return null;
    // Solo "DW_OP_addr X" (o con un DW_OP_plus_uconst). TLS y otras expresiones, no.
    if (l.pos === loc.length) return dir;
    if (loc[l.pos] === DW_OP_plus_uconst) {
      l.u8();
      dir += l.uleb();
      return l.pos === loc.length ? dir : null;
    }
    return null;
  }

  private archivoDecl(cu: Cu, idx: Valor | undefined): string | null {
    if (typeof idx !== 'number' || cu.lineas === null) return null;
    const prog = this.programa(cu.lineas, cu);
    if (!prog) return null;
    const base = cu.version >= 5 ? 0 : 1;
    return prog.archivos[idx - base] ?? null;
  }

  // --- Tipos (perezosos) ------------------------------------------------------------------

  private siguienteSintetico = -1;

  /**
   * Tipo armado por el depurador (no está en el .elf), p. ej. la fila de un arreglo
   * de 2 dimensiones. Vive en offsets negativos para no chocar con los DIE reales.
   */
  sintetico(t: TipoC): number {
    for (const [k, v] of this.tipos) if (k < 0 && JSON.stringify(v) === JSON.stringify(t)) return k;
    const id = this.siguienteSintetico--;
    this.tipos.set(id, t);
    return id;
  }

  tipo(offset: number | null): TipoC {
    if (offset === null) return { k: 'void' };
    const ya = this.tipos.get(offset);
    if (ya) return ya;
    const t = this.leerTipo(offset);
    this.tipos.set(offset, t);
    return t;
  }

  private leerTipo(offset: number): TipoC {
    const d = this.die(offset);
    if (!d) return { k: 'otro', nombre: '?' };
    const a = (at: number): Valor | undefined => d.attrs.get(at)?.v;
    const num = (at: number): number | null => {
      const v = a(at);
      return typeof v === 'number' ? v : null;
    };
    const nombre = typeof a(DW_AT.name) === 'string' ? (a(DW_AT.name) as string) : '';
    const destino = num(DW_AT.type);
    switch (d.tag) {
      case DW_TAG.base_type:
        return { k: 'base', nombre, tam: num(DW_AT.byte_size) ?? 0, codif: num(DW_AT.encoding) ?? DW_ATE.signed };
      case DW_TAG.pointer_type:
      case DW_TAG.ptr_to_member_type:
        return { k: 'puntero', tam: num(DW_AT.byte_size) ?? this.tamDir, destino };
      case DW_TAG.reference_type:
      case DW_TAG.rvalue_reference_type:
        return { k: 'puntero', tam: num(DW_AT.byte_size) ?? this.tamDir, destino, referencia: true };
      case DW_TAG.typedef:
        return { k: 'typedef', nombre, destino };
      case DW_TAG.const_type:
        return { k: 'calif', calif: 'const', destino };
      case DW_TAG.volatile_type:
        return { k: 'calif', calif: 'volatile', destino };
      case DW_TAG.restrict_type:
        return { k: 'calif', calif: 'restrict', destino };
      case DW_TAG.atomic_type:
        return { k: 'calif', calif: 'atomic', destino };
      case DW_TAG.subroutine_type:
        return { k: 'funcion' };
      case DW_TAG.unspecified_type:
        return nombre === 'decltype(nullptr)' ? { k: 'puntero', tam: this.tamDir, destino: null } : { k: 'void' };
      case DW_TAG.array_type: {
        const dims: number[] = [];
        for (const h of this.hijos(d)) {
          if (h.tag !== DW_TAG.subrange_type) continue;
          const c = h.attrs.get(DW_AT.count)?.v;
          const ub = h.attrs.get(DW_AT.upper_bound)?.v;
          if (typeof c === 'number') dims.push(c);
          else if (typeof ub === 'number') dims.push(ub + 1 > 0x7fffffff ? 0 : ub + 1);
          else dims.push(0); // arreglo sin tamaño (extern int x[];)
        }
        return { k: 'arreglo', elem: destino, dims: dims.length ? dims : [0] };
      }
      case DW_TAG.enumeration_type: {
        const valores: { nombre: string; valor: number }[] = [];
        for (const h of this.hijos(d)) {
          if (h.tag !== DW_TAG.enumerator) continue;
          const v = h.attrs.get(DW_AT.const_value);
          let valor = typeof v?.v === 'number' ? v.v : 0;
          // data1/2/4 sin signo: si el enum tiene negativos, vienen en complemento a 2.
          if (v && v.form === DW_FORM.data1 && valor > 0x7f) valor -= 0x100;
          else if (v && v.form === DW_FORM.data2 && valor > 0x7fff) valor -= 0x10000;
          valores.push({ nombre: String(h.attrs.get(DW_AT.name)?.v ?? '?'), valor });
        }
        return { k: 'enum', nombre, tam: num(DW_AT.byte_size) ?? 4, valores };
      }
      case DW_TAG.structure_type:
      case DW_TAG.class_type:
      case DW_TAG.union_type: {
        const clase = d.tag === DW_TAG.union_type ? 'union' : d.tag === DW_TAG.class_type ? 'class' : 'struct';
        const esDecl = a(DW_AT.declaration) === true || a(DW_AT.declaration) === 1;
        if (esDecl) {
          // Declaración adelantada: se busca la definición completa por nombre.
          const completa = nombre ? this.buscarStruct(nombre) : undefined;
          if (completa !== undefined && completa !== offset) return this.tipo(completa);
          return { k: 'struct', clase, nombre, tam: 0, miembros: [], incompleto: true };
        }
        const tam = num(DW_AT.byte_size) ?? 0;
        const miembros: Miembro[] = [];
        for (const h of this.hijos(d)) {
          if (h.tag === DW_TAG.inheritance) {
            // Clase base (C++): se muestra como un miembro más, con el nombre de la base entre <>.
            const loc = h.attrs.get(DW_AT.data_member_location)?.v;
            const tb = h.attrs.get(DW_AT.type)?.v;
            const off = typeof loc === 'number' ? loc : Buffer.isBuffer(loc) && loc[0] === DW_OP_plus_uconst ? new Lector(loc, 1).uleb() : 0;
            if (typeof tb === 'number') miembros.push({ nombre: `<${this.nombreTipo(tb)}>`, offset: off, tipo: tb });
            continue;
          }
          if (h.tag !== DW_TAG.member) continue;
          if (h.attrs.get(DW_AT.declaration)) continue; // miembro static: no ocupa lugar en el objeto
          const loc = h.attrs.get(DW_AT.data_member_location)?.v;
          let off = 0;
          if (typeof loc === 'number') off = loc;
          else if (Buffer.isBuffer(loc) && loc[0] === DW_OP_plus_uconst) off = new Lector(loc, 1).uleb();
          const m: Miembro = {
            nombre: String(h.attrs.get(DW_AT.name)?.v ?? '(anónimo)'),
            offset: off,
            tipo: typeof h.attrs.get(DW_AT.type)?.v === 'number' ? (h.attrs.get(DW_AT.type)!.v as number) : null,
          };
          const bitTam = h.attrs.get(DW_AT.bit_size)?.v;
          if (typeof bitTam === 'number') {
            m.bitTam = bitTam;
            const dbo = h.attrs.get(DW_AT.data_bit_offset)?.v;
            const bo = h.attrs.get(DW_AT.bit_offset)?.v;
            if (typeof dbo === 'number') {
              m.offset = Math.floor(dbo / 8);
              m.bitDesde = dbo % 8;
            } else if (typeof bo === 'number') {
              // DWARF 2/3: bit_offset desde el MSB de un almacenamiento de byte_size bytes (little-endian).
              const bs = h.attrs.get(DW_AT.byte_size)?.v;
              const tamAlm = typeof bs === 'number' ? bs : 4;
              m.bitDesde = tamAlm * 8 - bo - bitTam;
            } else m.bitDesde = 0;
          }
          miembros.push(m);
        }
        return { k: 'struct', clase, nombre, tam, miembros };
      }
      default:
        return { k: 'otro', nombre: nombre || `tag 0x${d.tag.toString(16)}` };
    }
  }

  /** Offset del tipo struct/class completo con ese nombre (calificado o no). */
  buscarStruct(nombre: string): number | undefined {
    const directo = this.structsPorNombre.get(nombre);
    if (directo !== undefined) return directo;
    for (const [k, v] of this.structsPorNombre) if (k.endsWith(`::${nombre}`)) return v;
    return undefined;
  }

  /** Quita typedef y const/volatile hasta el tipo "de verdad". */
  resolver(offset: number | null): { t: TipoC; off: number | null } {
    let off = offset;
    for (let i = 0; i < 32; i++) {
      const t = this.tipo(off);
      if (t.k === 'typedef' || t.k === 'calif') {
        off = t.destino;
        continue;
      }
      return { t, off };
    }
    return { t: { k: 'otro', nombre: '(bucle de tipos)' }, off };
  }

  tamano(offset: number | null): number {
    const { t } = this.resolver(offset);
    switch (t.k) {
      case 'base':
        return t.tam;
      case 'puntero':
        return t.tam;
      case 'enum':
        return t.tam;
      case 'struct':
        return t.tam;
      case 'arreglo': {
        const e = this.tamano(t.elem);
        return t.dims.reduce((acc, d) => acc * d, e);
      }
      default:
        return 0;
    }
  }

  /** Nombre del tipo como en C: `int`, `char *`, `uint8_t [10]`, `struct Foo`. */
  nombreTipo(offset: number | null, prof = 0): string {
    if (prof > 12) return '…';
    const t = this.tipo(offset);
    switch (t.k) {
      case 'void':
        return 'void';
      case 'base':
        return t.nombre;
      case 'typedef':
        return t.nombre;
      case 'calif':
        return `${t.calif} ${this.nombreTipo(t.destino, prof + 1)}`;
      case 'puntero':
        return `${this.nombreTipo(t.destino, prof + 1)} ${t.referencia ? '&' : '*'}`;
      case 'arreglo':
        return `${this.nombreTipo(t.elem, prof + 1)} ${t.dims.map((d) => `[${d || ''}]`).join('')}`;
      case 'struct':
        return t.nombre ? (t.clase === 'struct' ? t.nombre : `${t.clase} ${t.nombre}`) : `${t.clase} {…}`;
      case 'enum':
        return t.nombre ? `enum ${t.nombre}` : 'enum {…}';
      case 'funcion':
        return 'función';
      case 'otro':
        return t.nombre;
    }
  }

  // --- Funciones --------------------------------------------------------------------------

  funcionEn(dir: number): FuncionDwarf | undefined {
    if (!this.funcionesOrdenadas) this.funcionesOrdenadas = [...this.funciones].sort((a, b) => a.bajo - b.bajo || b.alto - a.alto);
    const f = this.funcionesOrdenadas;
    let lo = 0;
    let hi = f.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (f[mid]!.bajo <= dir) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // Puede haber funciones anidadas/solapadas: se busca hacia atrás la que contiene la dirección.
    for (let i = idx; i >= 0 && i > idx - 64; i--) {
      const c = f[i]!;
      if (dir >= c.bajo && dir < c.alto) return c;
    }
    return undefined;
  }

  buscarFuncion(nombre: string): FuncionDwarf[] {
    return this.funciones.filter((f) => f.nombre === nombre || f.nombre.endsWith(`::${nombre}`));
  }

  // --- Tabla de líneas ------------------------------------------------------------------------

  private programa(off: number, cu?: Cu): ProgramaLineas | null {
    const ya = this.programas.get(off);
    if (ya) return ya;
    try {
      const p = this.leerProgramaLineas(off, cu, null);
      this.programas.set(off, p);
      return p;
    } catch {
      return null;
    }
  }

  /**
   * Lee la cabecera (y, si se pasa `filas`, todo el programa) de un line program en `off`.
   * Devuelve la lista de archivos con su ruta completa.
   */
  private leerProgramaLineas(off: number, cu: Cu | undefined, filas: { push: (d: number, a: number, l: number, fin: boolean, stmt: boolean) => void; archivo: (ruta: string) => number } | null): ProgramaLineas {
    const b = this.line;
    const l = new Lector(b, off);
    let largo = l.u32();
    let tamOff = 4;
    if (largo === 0xffffffff) {
      largo = l.u64();
      tamOff = 8;
    }
    const fin = l.pos + largo;
    const version = l.u16();
    let tamDir = cu?.tamDir ?? this.tamDir;
    if (version >= 5) {
      tamDir = l.u8();
      l.u8(); // segment selector size
    }
    const largoCabecera = l.offset(tamOff);
    const inicioPrograma = l.pos + largoCabecera;
    const minInst = l.u8();
    if (version >= 4) l.u8(); // max ops per instruction
    const defaultStmt = l.u8() !== 0;
    const lineBase = (l.u8() << 24) >> 24;
    const lineRange = l.u8();
    const opcodeBase = l.u8();
    const largos: number[] = [];
    for (let i = 1; i < opcodeBase; i++) largos.push(l.u8());

    const dirs: string[] = [];
    const archivos: string[] = [];
    const compDir = cu?.compDir ?? '';
    const unir = (dir: string, nombre: string): string => (path.posix.isAbsolute(nombre) ? nombre : path.posix.join(dir || compDir, nombre));

    if (version >= 5) {
      const leerEntradas = (): { tipo: number; valor: string | number }[][] => {
        const nFormatos = l.u8();
        const formatos: { tipo: number; form: number }[] = [];
        for (let i = 0; i < nFormatos; i++) formatos.push({ tipo: l.uleb(), form: l.uleb() });
        const n = l.uleb();
        const out: { tipo: number; valor: string | number }[][] = [];
        for (let i = 0; i < n; i++) {
          const e: { tipo: number; valor: string | number }[] = [];
          for (const f of formatos) {
            let v: string | number = 0;
            if (f.form === DW_FORM.string) v = l.cstr();
            else if (f.form === DW_FORM.line_strp) v = this.cadenaEn(this.lineStr, l.offset(tamOff));
            else if (f.form === DW_FORM.strp) v = this.cadenaEn(this.str, l.offset(tamOff));
            else if (f.form === DW_FORM.udata) v = l.uleb();
            else if (f.form === DW_FORM.data1) v = l.u8();
            else if (f.form === DW_FORM.data2) v = l.u16();
            else if (f.form === DW_FORM.data4) v = l.u32();
            else if (f.form === DW_FORM.data8) v = l.u64();
            else if (f.form === DW_FORM.data16) l.pos += 16;
            else if (f.form === DW_FORM.block) l.pos += l.uleb();
            else throw new Error(`forma ${f.form} en la tabla de líneas`);
            e.push({ tipo: f.tipo, valor: v });
          }
          out.push(e);
        }
        return out;
      };
      for (const e of leerEntradas()) dirs.push(String(e.find((x) => x.tipo === 1)?.valor ?? ''));
      for (const e of leerEntradas()) {
        const nombre = String(e.find((x) => x.tipo === 1)?.valor ?? '');
        const di = Number(e.find((x) => x.tipo === 2)?.valor ?? 0);
        archivos.push(unir(dirs[di] ?? '', nombre));
      }
    } else {
      dirs.push(compDir);
      for (;;) {
        const d = l.cstr();
        if (!d) break;
        dirs.push(d);
      }
      for (;;) {
        const nombre = l.cstr();
        if (!nombre) break;
        const di = l.uleb();
        l.uleb();
        l.uleb();
        archivos.push(unir(dirs[di] ?? '', nombre));
      }
    }
    const prog: ProgramaLineas = { archivos };
    if (!filas) return prog;

    // Máquina de estados de la tabla de líneas (DWARF 5, 6.2).
    const base = version >= 5 ? 0 : 1;
    const idxArchivo = (i: number): number => filas.archivo(archivos[i - base] ?? '?');
    l.pos = inicioPrograma;
    let dir = 0;
    let archivo = 1;
    let linea = 1;
    let stmt = defaultStmt;
    const reiniciar = (): void => {
      dir = 0;
      archivo = 1;
      linea = 1;
      stmt = defaultStmt;
    };
    const emitir = (finSec: boolean): void => filas.push(dir, idxArchivo(archivo), linea, finSec, stmt);
    while (l.pos < fin) {
      const op = l.u8();
      if (op >= opcodeBase) {
        const aj = op - opcodeBase;
        dir += Math.floor(aj / lineRange) * minInst;
        linea += lineBase + (aj % lineRange);
        emitir(false);
      } else if (op === 0) {
        const n = l.uleb();
        const sig = l.pos + n;
        const sub = l.u8();
        if (sub === 1) {
          emitir(true);
          reiniciar();
        } else if (sub === 2) {
          dir = l.dir(n - 1 === 2 ? 2 : n - 1 === 8 ? 8 : tamDir);
        } else if (sub === 3) {
          const nombre = l.cstr();
          const di = l.uleb();
          archivos.push(unir(dirs[di] ?? '', nombre));
        }
        l.pos = sig;
      } else {
        switch (op) {
          case 1:
            emitir(false);
            break;
          case 2:
            dir += l.uleb() * minInst;
            break;
          case 3:
            linea += l.sleb();
            break;
          case 4:
            archivo = l.uleb();
            break;
          case 5:
            l.uleb();
            break;
          case 6:
            stmt = !stmt;
            break;
          case 7:
            break;
          case 8:
            dir += Math.floor((255 - opcodeBase) / lineRange) * minInst;
            break;
          case 9:
            dir += l.u16();
            break;
          default:
            // 10, 11 sin operandos; 12 (set_isa) y desconocidos: se saltean sus operandos ULEB.
            for (let i = 0; i < (largos[op - 1] ?? 0); i++) l.uleb();
        }
      }
    }
    return prog;
  }

  private tablaLineas(): TablaLineas {
    if (this.tabla) return this.tabla;
    const t = new TablaLineas();
    const dirs: number[] = [];
    const lineas: number[] = [];
    const archivos: number[] = [];
    const fines: number[] = [];
    const stmts: number[] = [];
    const indice = new Map<string, number>();
    const archivo = (ruta: string): number => {
      let i = indice.get(ruta);
      if (i === undefined) {
        i = t.nombresArchivo.length;
        t.nombresArchivo.push(ruta);
        indice.set(ruta, i);
      }
      return i;
    };
    const vistos = new Set<number>();
    // Se junta cada secuencia entera antes de guardarla: las que empiezan en 0 son
    // código que el enlazador descartó (--gc-sections) y ensuciarían la dirección 0.
    let secuencia: [number, number, number, number, number][] = [];
    for (const cu of this.cus) {
      if (cu.lineas === null || vistos.has(cu.lineas)) continue;
      vistos.add(cu.lineas);
      try {
        this.leerProgramaLineas(cu.lineas, cu, {
          push: (d, a, l, fin, stmt) => {
            secuencia.push([d, a, l, fin ? 1 : 0, stmt ? 1 : 0]);
            if (!fin) return;
            if (secuencia[0]![0] !== 0) {
              for (const [sd, sa, sl, sf, ss] of secuencia) {
                dirs.push(sd);
                archivos.push(sa);
                lineas.push(sl);
                fines.push(sf);
                stmts.push(ss);
              }
            }
            secuencia = [];
          },
          archivo,
        });
        secuencia = [];
      } catch {
        /* programa roto: se ignora */
      }
    }
    // Orden por dirección; en empate, las de fin de secuencia primero (cierran la anterior).
    const orden = dirs.map((_, i) => i).sort((a, b) => dirs[a]! - dirs[b]! || fines[b]! - fines[a]! || a - b);
    t.dirs = Uint32Array.from(orden.map((i) => dirs[i]!));
    t.lineas = Uint32Array.from(orden.map((i) => lineas[i]!));
    t.archivos = Uint32Array.from(orden.map((i) => archivos[i]!));
    t.finSecuencia = Uint8Array.from(orden.map((i) => fines[i]!));
    t.esSentencia = Uint8Array.from(orden.map((i) => stmts[i]!));
    this.tabla = t;
    return t;
  }

  /** Archivo y línea del código en una dirección. */
  lineaEn(dir: number): FilaLinea | null {
    const t = this.tablaLineas();
    let lo = 0;
    let hi = t.dirs.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t.dirs[mid]! <= dir) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // Si la última fila antes de la dirección cierra una secuencia, la dirección no es
    // código con línea (en un empate, el orden pone primero el cierre y después el inicio).
    if (idx < 0 || t.finSecuencia[idx] === 1) return null;
    return { dir: t.dirs[idx]!, archivo: t.nombresArchivo[t.archivos[idx]!]!, linea: t.lineas[idx]! };
  }

  /** Archivos fuente que aparecen en la tabla de líneas. */
  archivosFuente(): string[] {
    return [...this.tablaLineas().nombresArchivo];
  }

  /**
   * Direcciones donde empieza una línea de un archivo (para un breakpoint). `archivo`
   * se compara por sufijo ("sketch.cpp", "main/main.c"). Si la línea no tiene código
   * (comentario, línea en blanco), se usa la siguiente que sí tenga, como hace gdb.
   */
  direccionesDeLinea(archivo: string, linea: number, maxSalto = 20): { linea: number; archivo: string; dirs: number[] } | null {
    const t = this.tablaLineas();
    const sufijo = archivo.replace(/^\.?\//, '');
    const coincide = new Set<number>();
    t.nombresArchivo.forEach((n, i) => {
      if (n === sufijo || n.endsWith(`/${sufijo}`)) coincide.add(i);
    });
    if (coincide.size === 0) return null;
    for (let l = linea; l <= linea + maxSalto; l++) {
      const dirs: number[] = [];
      let nombre = '';
      for (let i = 0; i < t.dirs.length; i++) {
        if (t.lineas[i] !== l || !coincide.has(t.archivos[i]!) || t.finSecuencia[i] === 1 || t.esSentencia[i] === 0) continue;
        // Solo el comienzo de un bloque de esa línea (la fila anterior es otra línea u otro archivo).
        const previaMisma = i > 0 && t.lineas[i - 1] === l && t.archivos[i - 1] === t.archivos[i] && t.finSecuencia[i - 1] === 0;
        if (previaMisma) continue;
        dirs.push(t.dirs[i]!);
        nombre = t.nombresArchivo[t.archivos[i]!]!;
      }
      if (dirs.length > 0) {
        // Direcciones únicas y ordenadas; con código duplicado (inline), hasta 8.
        const unicas = [...new Set(dirs)].sort((a, b) => a - b).slice(0, 8);
        return { linea: l, archivo: nombre, dirs: unicas };
      }
    }
    return null;
  }

  /** Comienzos de línea (con sentencia) dentro de un rango de direcciones: para "next". */
  comienzosDeLineaEn(bajo: number, alto: number): { dir: number; linea: number; archivo: string }[] {
    const t = this.tablaLineas();
    const out: { dir: number; linea: number; archivo: string }[] = [];
    let lo = 0;
    let hi = t.dirs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t.dirs[mid]! < bajo) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < t.dirs.length && t.dirs[i]! < alto; i++) {
      if (t.finSecuencia[i] === 1 || t.esSentencia[i] === 0) continue;
      out.push({ dir: t.dirs[i]!, linea: t.lineas[i]!, archivo: t.nombresArchivo[t.archivos[i]!]! });
    }
    return out;
  }
}
