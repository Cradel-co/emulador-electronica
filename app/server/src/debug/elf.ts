/**
 * Lector mínimo de ELF32 (little-endian), sin dependencias: lo que el modo debug
 * necesita de un .elf compilado — secciones y tabla de símbolos (nombre, dirección,
 * tamaño, tipo). Sirve igual para AVR (Arduino Uno), Xtensa (ESP32-S3) y RISC-V
 * (ESP32-C3/C6): el formato es el mismo, cambia solo `e_machine`.
 *
 * No usa avr-nm/readelf de un contenedor: el .elf de un sketch pesa ~30 KB y el de
 * ESPHome ~11 MB, se lee entero en memoria en milisegundos.
 */

export const EM_AVR = 83;
export const EM_XTENSA = 94;
export const EM_RISCV = 243;

export interface SeccionElf {
  nombre: string;
  tipo: number;
  flags: number;
  dir: number;
  offset: number;
  tam: number;
  link: number;
  entsize: number;
}

export type TipoSimbolo = 'objeto' | 'funcion' | 'seccion' | 'archivo' | 'otro';

export interface SimboloElf {
  nombre: string;
  /** Nombre legible (C++ desarmado, si se pudo). */
  legible: string;
  dir: number;
  tam: number;
  tipo: TipoSimbolo;
  global: boolean;
  seccion: string | null;
}

const SHT_SYMTAB = 2;
const SHT_NOBITS = 8;

export class ArchivoElf {
  readonly maquina: number;
  readonly entrada: number;
  readonly secciones: SeccionElf[];
  private simbolosCache: SimboloElf[] | null = null;
  private funcionesOrdenadas: SimboloElf[] | null = null;

  constructor(readonly datos: Buffer) {
    if (datos.length < 52 || datos.readUInt32BE(0) !== 0x7f454c46) throw new Error('no es un archivo ELF');
    if (datos[4] !== 1) throw new Error('solo se soporta ELF de 32 bits');
    if (datos[5] !== 1) throw new Error('solo se soporta ELF little-endian');
    this.maquina = datos.readUInt16LE(18);
    this.entrada = datos.readUInt32LE(24);
    const shoff = datos.readUInt32LE(32);
    const shentsize = datos.readUInt16LE(46);
    const shnum = datos.readUInt16LE(48);
    const shstrndx = datos.readUInt16LE(50);
    const crudas: Omit<SeccionElf, 'nombre'>[] = [];
    const nombres: number[] = [];
    for (let i = 0; i < shnum; i++) {
      const o = shoff + i * shentsize;
      if (o + 40 > datos.length) break;
      nombres.push(datos.readUInt32LE(o));
      crudas.push({
        tipo: datos.readUInt32LE(o + 4),
        flags: datos.readUInt32LE(o + 8),
        dir: datos.readUInt32LE(o + 12),
        offset: datos.readUInt32LE(o + 16),
        tam: datos.readUInt32LE(o + 20),
        link: datos.readUInt32LE(o + 24),
        entsize: datos.readUInt32LE(o + 36),
      });
    }
    const tablaNombres = crudas[shstrndx];
    this.secciones = crudas.map((s, i) => ({
      ...s,
      nombre: tablaNombres ? leerCadena(datos, tablaNombres.offset + nombres[i]!) : '',
    }));
  }

  /** Arquitectura legible (para la UI / el agente). */
  get arquitectura(): 'avr' | 'xtensa' | 'riscv' | 'otra' {
    if (this.maquina === EM_AVR) return 'avr';
    if (this.maquina === EM_XTENSA) return 'xtensa';
    if (this.maquina === EM_RISCV) return 'riscv';
    return 'otra';
  }

  seccion(nombre: string): SeccionElf | undefined {
    return this.secciones.find((s) => s.nombre === nombre);
  }

  /** Contenido de una sección (vista, sin copiar). Vacío si no existe o es NOBITS (.bss). */
  contenido(nombre: string): Buffer {
    const s = this.seccion(nombre);
    if (!s || s.tipo === SHT_NOBITS) return Buffer.alloc(0);
    return this.datos.subarray(s.offset, s.offset + s.tam);
  }

  /** Todos los símbolos de .symtab (sin los vacíos). */
  simbolos(): SimboloElf[] {
    if (this.simbolosCache) return this.simbolosCache;
    const out: SimboloElf[] = [];
    const tabla = this.secciones.find((s) => s.tipo === SHT_SYMTAB);
    if (tabla) {
      const cadenas = this.secciones[tabla.link];
      const paso = tabla.entsize || 16;
      for (let o = tabla.offset; o + 16 <= tabla.offset + tabla.tam; o += paso) {
        const nombreOff = this.datos.readUInt32LE(o);
        const valor = this.datos.readUInt32LE(o + 4);
        const tam = this.datos.readUInt32LE(o + 8);
        const info = this.datos[o + 12]!;
        const shndx = this.datos.readUInt16LE(o + 14);
        const nombre = cadenas && nombreOff ? leerCadena(this.datos, cadenas.offset + nombreOff) : '';
        if (!nombre) continue;
        const t = info & 0xf;
        const tipo: TipoSimbolo = t === 1 ? 'objeto' : t === 2 ? 'funcion' : t === 3 ? 'seccion' : t === 4 ? 'archivo' : 'otro';
        out.push({
          nombre,
          legible: desarmarCpp(nombre),
          dir: valor,
          tam,
          tipo,
          global: info >> 4 !== 0,
          seccion: shndx > 0 && shndx < 0xff00 ? (this.secciones[shndx]?.nombre ?? null) : null,
        });
      }
    }
    this.simbolosCache = out;
    return out;
  }

  /** Variables (símbolos de datos) con tamaño: lo que se puede leer de la RAM. */
  variables(): SimboloElf[] {
    return this.simbolos().filter((s) => s.tipo === 'objeto' && s.tam > 0);
  }

  buscarSimbolo(nombre: string): SimboloElf | undefined {
    const todos = this.simbolos();
    return todos.find((s) => s.nombre === nombre) ?? todos.find((s) => s.legible === nombre);
  }

  /**
   * Función que contiene una dirección (para "¿dónde está parado?"). En Xtensa y
   * RISC-V las direcciones de código son directas; en AVR, byte (PC × 2).
   */
  funcionEn(dir: number): SimboloElf | undefined {
    if (!this.funcionesOrdenadas) {
      this.funcionesOrdenadas = this.simbolos()
        .filter((s) => s.tipo === 'funcion')
        .sort((a, b) => a.dir - b.dir);
    }
    const f = this.funcionesOrdenadas;
    let lo = 0;
    let hi = f.length - 1;
    let mejor: SimboloElf | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = f[mid]!;
      if (s.dir <= dir) {
        mejor = s;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (!mejor) return undefined;
    // Sin tamaño (símbolos de ensamblador) se acepta; con tamaño, tiene que caer adentro.
    if (mejor.tam > 0 && dir >= mejor.dir + mejor.tam) return undefined;
    return mejor;
  }
}

export function leerCadena(datos: Buffer, offset: number): string {
  if (offset < 0 || offset >= datos.length) return '';
  let fin = offset;
  while (fin < datos.length && datos[fin] !== 0) fin++;
  return datos.toString('utf8', offset, fin);
}

/**
 * Desarmado mínimo de nombres C++ (Itanium ABI), solo lo común en firmware:
 * `_ZN3foo3barE` → `foo::bar`, `_Z4loopv` → `loop`, `_ZN3foo3barEi` → `foo::bar`.
 * Sin argumentos ni plantillas complejas: si no se entiende, devuelve el original.
 * (El nombre completo y los tipos salen de DWARF cuando está; esto es el respaldo.)
 */
export function desarmarCpp(nombre: string): string {
  if (!nombre.startsWith('_Z')) return nombre;
  let i = 2;
  const partes: string[] = [];
  const leerNombre = (): string | null => {
    let n = 0;
    const ini = i;
    while (i < nombre.length && nombre[i]! >= '0' && nombre[i]! <= '9') {
      n = n * 10 + (nombre.charCodeAt(i) - 48);
      i++;
    }
    if (i === ini || n <= 0 || i + n > nombre.length) return null;
    const s = nombre.slice(i, i + n);
    i += n;
    return s;
  };
  if (nombre[i] === 'L') i++; // símbolo local (static)
  if (nombre[i] === 'N') {
    i++;
    while (nombre[i] === 'K' || nombre[i] === 'V' || nombre[i] === 'r') i++; // calificadores de método
    while (i < nombre.length && nombre[i] !== 'E') {
      if (nombre[i] === 'C' && /[123]/.test(nombre[i + 1] ?? '')) {
        partes.push(partes[partes.length - 1] ?? '?'); // constructor
        i += 2;
        continue;
      }
      if (nombre[i] === 'D' && /[012]/.test(nombre[i + 1] ?? '')) {
        partes.push(`~${partes[partes.length - 1] ?? '?'}`); // destructor
        i += 2;
        continue;
      }
      if (nombre.startsWith('St', i)) {
        partes.push('std');
        i += 2;
        continue;
      }
      if (nombre[i] === 'I') return partes.length ? partes.join('::') : nombre; // plantilla: se corta acá
      const p = leerNombre();
      if (p === null) return partes.length ? partes.join('::') : nombre;
      partes.push(p);
    }
    return partes.length ? partes.join('::') : nombre;
  }
  const p = leerNombre();
  return p ?? nombre;
}
