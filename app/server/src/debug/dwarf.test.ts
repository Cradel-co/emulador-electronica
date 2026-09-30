import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArchivoElf, desarmarCpp, EM_AVR, EM_XTENSA } from './elf.js';
import { InfoDwarf } from './dwarf.js';
import { FormateadorC, MemoriaConCache, type Memoria } from './valoresC.js';
import { Referencias } from './tipos.js';

/**
 * Fixtures (server/src/fixtures/depuracion):
 *  - dw5-xtensa.elf: dw5.c compilado con el GCC 14 de ESP-IDF (.cache/idf/tools/xtensa-esp-elf):
 *      xtensa-esp32s3-elf-gcc -gdwarf-5 -O1 -nostdlib -Wl,-e,_start -o dw5-xtensa.elf dw5.c
 *    → DWARF 5 (strx, line_strp, tabla de líneas v5), struct con bitfields, enum con
 *      negativos, arreglo 2D, static local.
 *  - uno-debug.elf/.hex: uno-debug.cpp compilado por la app con arduino-cli (avr-gcc 7.3, LTO,
 *    DWARF 2), el mismo que se verificó en vivo contra avr8js.
 */
const fixture = (n: string): string => fileURLToPath(new URL(`../fixtures/depuracion/${n}`, import.meta.url));
const xtensa = new ArchivoElf(readFileSync(fixture('dw5-xtensa.elf')));
const uno = new ArchivoElf(readFileSync(fixture('uno-debug.elf')));

/** Memoria "del chip" armada con el contenido inicial de las secciones del .elf (.data, .rodata). */
function memoriaDelElf(elf: ArchivoElf): Memoria {
  return {
    tamPuntero: 4,
    desdePuntero: (v) => v,
    async leer(dir, largo) {
      for (const s of elf.secciones) {
        if (s.dir && dir >= s.dir && dir + largo <= s.dir + s.tam) {
          // .bss (NOBITS): en ceros, como la RAM después del arranque.
          if (s.tipo === 8) return new Uint8Array(largo);
          return new Uint8Array(elf.datos.subarray(s.offset + (dir - s.dir), s.offset + (dir - s.dir) + largo));
        }
      }
      throw new Error(`fuera de las secciones: 0x${dir.toString(16)}`);
    },
  };
}

describe('ArchivoElf', () => {
  it('lee la cabecera, las secciones y la tabla de símbolos', () => {
    expect(xtensa.maquina).toBe(EM_XTENSA);
    expect(xtensa.arquitectura).toBe('xtensa');
    expect(xtensa.seccion('.debug_info')).toBeDefined();
    const estado = xtensa.buscarSimbolo('estado');
    expect(estado).toMatchObject({ tipo: 'objeto', tam: 24, global: true });
    expect(xtensa.funcionEn(xtensa.buscarSimbolo('usar')!.dir + 4)?.nombre).toBe('usar');

    expect(uno.maquina).toBe(EM_AVR);
    const contador = uno.buscarSimbolo('contador');
    expect(contador).toMatchObject({ tipo: 'objeto', tam: 4 });
    expect(contador!.dir).toBeGreaterThanOrEqual(0x800100); // SRAM del ATmega328P en el espacio de datos del .elf
  });

  it('desarma nombres C++ simples', () => {
    expect(desarmarCpp('_ZN7esphome3AppE')).toBe('esphome::App');
    expect(desarmarCpp('_Z4loopv')).toBe('loop');
    expect(desarmarCpp('_ZN14HardwareSerial5writeEh')).toBe('HardwareSerial::write');
    expect(desarmarCpp('_ZZ4loopE6ultimo')).toBe('_ZZ4loopE6ultimo'); // static local: sin desarmar, no rompe
    expect(desarmarCpp('main')).toBe('main');
  });

  it('rechaza lo que no es ELF32', () => {
    expect(() => new ArchivoElf(Buffer.from('hola, no soy un elf.............................................'))).toThrow(/ELF/);
  });
});

describe('InfoDwarf (DWARF 5, Xtensa)', () => {
  const dw = new InfoDwarf(xtensa);

  it('indexa globales, static locales y funciones sin errores', () => {
    expect(dw.unidadesConError).toEqual([]);
    const nombres = dw.variables.map((v) => v.nombreCompleto).sort();
    expect(nombres).toEqual(['color', 'estado', 'matriz', 'usar::llamadas']);
    expect(dw.variables.find((v) => v.nombre === 'llamadas')?.estaticaLocal).toBe(true);
    expect(dw.buscarFuncion('usar')[0]).toMatchObject({ nombre: 'usar' });
  });

  it('resuelve tipos: struct con bitfields, enum con negativos, arreglo 2D', () => {
    const estado = dw.variables.find((v) => v.nombre === 'estado')!;
    expect(dw.nombreTipo(estado.tipo)).toBe('Estado');
    expect(dw.tamano(estado.tipo)).toBe(24);
    const t = dw.resolver(estado.tipo).t;
    expect(t.k).toBe('struct');
    if (t.k !== 'struct') return;
    expect(t.miembros.map((m) => m.nombre)).toEqual(['contador', 'banderas', 'modo', 'pos', 'nombre', 'temperatura']);
    expect(t.miembros.find((m) => m.nombre === 'modo')).toMatchObject({ bitTam: 5, bitDesde: 3 });

    const color = dw.variables.find((v) => v.nombre === 'color')!;
    const tc = dw.resolver(color.tipo).t;
    expect(tc.k === 'enum' && tc.valores).toEqual([
      { nombre: 'ROJO', valor: 1 },
      { nombre: 'VERDE', valor: 2 },
      { nombre: 'AZUL', valor: -1 },
    ]);
    const matriz = dw.variables.find((v) => v.nombre === 'matriz')!;
    expect(dw.nombreTipo(matriz.tipo)).toBe('int [2][3]');
    expect(dw.tamano(matriz.tipo)).toBe(24);
  });

  it('tabla de líneas: dirección ↔ archivo:línea (como readelf --debug-dump=decodedline)', () => {
    const usar = dw.buscarFuncion('usar')[0]!;
    expect(dw.lineaEn(usar.bajo)).toMatchObject({ linea: 15 });
    expect(dw.lineaEn(usar.bajo)?.archivo.endsWith('dw5.c')).toBe(true);
    const bp = dw.direccionesDeLinea('dw5.c', 19);
    expect(bp?.linea).toBe(19);
    expect(bp?.dirs).toEqual([0x40009d]);
    // Una línea sin código (el `}` final) se corre a la próxima con código, o no hay.
    expect(dw.direccionesDeLinea('noexiste.c', 1)).toBeNull();
  });
});

describe('FormateadorC + evaluate (valores leídos de la memoria)', () => {
  const dw = new InfoDwarf(xtensa);
  const refs = new Referencias();
  const f = new FormateadorC(dw, new MemoriaConCache(memoriaDelElf(xtensa)), refs);
  const buscar = (n: string) => dw.variables.find((v) => v.nombreCompleto === n || v.nombre === n);
  const ev = (e: string) => f.evaluar(e, buscar, (r) => (r === 'pc' ? 0x40009d : undefined));

  it('muestra un struct como gdb, con bitfields y float', async () => {
    const r = await ev('estado');
    // Resumen de un nivel (lo anidado más adentro queda como {…}; se ve al expandir).
    expect(r.result).toMatch(/^\{contador = 7, banderas = 5, modo = 9, pos = \[2\] \{\{…\}, \{…\}\}, nombre = 0x[0-9a-f]+, temperatura = 21\.5\}$/);
    expect(r.type).toBe('Estado');
    expect(r.variablesReference).toBeGreaterThan(0);
    const hijos = await refs.hijos(r.variablesReference);
    expect(hijos.map((h) => `${h.name}=${h.value}`)).toEqual([
      'contador=7',
      'banderas=5',
      'modo=9',
      'pos=[2] {{x = 1, y = -2}, {x = 3, y = 4}}',
      expect.stringMatching(/^nombre=0x[0-9a-f]+ \(ver \*nombre\)$/),
      'temperatura=21.5',
    ]);
    // Puntero a char: se expande a lo apuntado.
    const nombre = hijos.find((h) => h.name === 'nombre')!;
    const apuntado = await refs.hijos(nombre.variablesReference);
    expect(apuntado[0]).toMatchObject({ name: '*nombre', value: "104 'h'" });
  });

  it('evalúa miembros, índices, arreglos 2D, enums, aritmética y registros', async () => {
    expect((await ev('estado.pos[1].y')).result).toBe('4');
    expect((await ev('estado.pos[0].y * 10 + estado.contador')).result).toBe('-13');
    expect((await ev('matriz[1][2]')).result).toBe('6');
    expect((await ev('matriz[1]')).result).toBe('[3] {4, 5, 6}');
    expect((await ev('color')).result).toBe('VERDE (2)');
    expect((await ev('color == 2')).result).toBe('1');
    expect((await ev('*estado.nombre')).result).toBe("104 'h'");
    expect((await ev('usar::llamadas')).result).toBe('0');
    expect((await ev('$pc')).result).toBe(String(0x40009d));
    expect((await ev('&estado')).result).toBe(String(buscar('estado')!.dir));
  });

  it('errores claros (sin romper)', async () => {
    await expect(ev('noexiste')).rejects.toThrow(/no hay una variable global/);
    await expect(ev('estado.nada')).rejects.toThrow(/no tiene "nada"/);
    await expect(ev('matriz[5]')).rejects.toThrow(/fuera del arreglo/);
    await expect(ev('estado +')).rejects.toThrow();
    await expect(ev('1 / 0')).rejects.toThrow(/división por cero/);
  });
});

describe('InfoDwarf (DWARF 2, AVR con LTO)', () => {
  const dw = new InfoDwarf(uno);

  it('encuentra las globales del sketch con su tipo y dónde están declaradas', () => {
    const contador = dw.variables.find((v) => v.nombre === 'contador')!;
    expect(dw.nombreTipo(contador.tipo)).toBe('volatile long unsigned int');
    expect(contador.archivo).toBe('/build/sketch/sketch.cpp');
    expect(contador.linea).toBe(9);
    const nombre = dw.variables.find((v) => v.nombre === 'nombre')!;
    expect(dw.nombreTipo(nombre.tipo)).toBe('char [12]');
    // Registros de E/S del ATmega (avr-libc los declara como variables en 0x800020-0x8000FF).
    expect(dw.variables.find((v) => v.nombre === 'PORTB')?.dir).toBe(0x800025);
  });

  it('breakpoint por línea en sketch.cpp (setup/loop quedan dentro de main por LTO)', () => {
    const bp = dw.direccionesDeLinea('sketch.cpp', 17)!;
    expect(bp.linea).toBe(17);
    expect(bp.dirs).toEqual([0x740]);
    expect(dw.funcionEn(0x740)?.nombre).toBe('main');
    expect(dw.buscarFuncion('loop')).toEqual([]);
  });
});
