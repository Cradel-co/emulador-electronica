import { DefinicionComponenteSchema, type DefinicionComponente, type ReferenciaComponente } from '../../../../shared/src/componentes/contratos.js';
import { huellaDefinicion } from '../../../../server/src/componentes/catalogo.js';

export const puerto = (id: string) => ({ id, dominio: 'electrico' as const, direccion: 'bidireccional' as const, ancho: 1 });
export const externo = (id: string) => ({ tipo: 'externo' as const, puerto: id });
export const hijo = (instancia: string, id: string) => ({ tipo: 'hijo' as const, instancia, puerto: id });
export const referencia = (def: DefinicionComponente): ReferenciaComponente => ({ id: def.id, version: def.version, sha256: huellaDefinicion(def) });

export function resistor(): DefinicionComponente {
  return DefinicionComponenteSchema.parse({
    schemaVersion: 1, id: 'resistor', version: '1.0.0', nombre: 'Resistor ideal', tipo: 'hoja-legada',
    puertos: [puerto('1'), puerto('2')], modulo: { id: 'resistor', sha256: 'a'.repeat(64) },
    parametros: { ohms: { tipo: 'numero', default: 1000, min: 1, max: 10_000_000, unidad: 'ohm' } },
  });
}

export function divisor(r: DefinicionComponente): DefinicionComponente {
  return DefinicionComponenteSchema.parse({
    schemaVersion: 1, id: 'divisor', version: '1.0.0', nombre: 'Divisor', tipo: 'compuesto',
    puertos: ['VIN', 'OUT', 'GND'].map(puerto),
    parametros: { inferior: { tipo: 'numero', default: 1000, min: 1, max: 10_000_000, unidad: 'ohm' } },
    instancias: [
      { id: 'r1', definicion: referencia(r), parametros: { ohms: 1000 } },
      { id: 'r2', definicion: referencia(r), parametros: { ohms: { parametro: 'inferior' } } },
    ],
    conexiones: [
      { id: 'entrada', terminales: [externo('VIN'), hijo('r1', '1')] },
      { id: 'salida', terminales: [externo('OUT'), hijo('r1', '2'), hijo('r2', '1')] },
      { id: 'tierra', terminales: [externo('GND'), hijo('r2', '2')] },
    ],
  });
}

/** Sin cables entre las dos copias: ni siquiera sus GND están unidos por nombre. */
export function doble(d: DefinicionComponente): DefinicionComponente {
  return DefinicionComponenteSchema.parse({
    schemaVersion: 1, id: 'doble', version: '1.0.0', nombre: 'Dos divisores', tipo: 'compuesto', puertos: [],
    instancias: [
      { id: 'izquierda', definicion: referencia(d), parametros: {} },
      { id: 'derecha', definicion: referencia(d), parametros: { inferior: 2000 } },
    ], conexiones: [],
  });
}
