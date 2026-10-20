import { describe, expect, it } from 'vitest';
import { DefinicionComponenteSchema, PuertoComponenteSchema, ReferenciaComponenteSchema } from '../../../../shared/src/componentes/contratos.js';

const hoja = () => ({ schemaVersion: 1, id: 'resistor', version: '1.0.0', nombre: 'Resistor', tipo: 'hoja-legada',
  puertos: [{ id: '1', dominio: 'electrico', direccion: 'bidireccional', ancho: 1 }],
  modulo: { id: 'resistor', sha256: 'a'.repeat(64) } });

describe('contratos jerárquicos', () => {
  it('conserva puertos legados y agrega parámetros vacíos sin alterar el documento recibido', () => {
    const entrada = hoja();
    expect(DefinicionComponenteSchema.parse(entrada).parametros).toEqual({});
    expect(entrada).not.toHaveProperty('parametros');
  });
  it('rechaza campos desconocidos e IDs duplicados', () => {
    expect(DefinicionComponenteSchema.safeParse({ ...hoja(), sorpresa: true }).success).toBe(false);
    expect(DefinicionComponenteSchema.safeParse({ ...hoja(), puertos: [...hoja().puertos, ...hoja().puertos] }).success).toBe(false);
  });
  it('acepta parámetros de número, texto y booleano con defaults válidos', () => {
    const parametros = { resistencia: { tipo: 'numero', default: 1000, min: 1, max: 2000, unidad: 'ohm' }, modo: { tipo: 'texto', default: 'ideal', valores: ['ideal', 'medido'] }, activo: { tipo: 'booleano', default: false } };
    expect(DefinicionComponenteSchema.parse({ ...hoja(), parametros }).parametros).toEqual(parametros);
  });
  it('acepta nombres reales de pines y rechaza un puerto eléctrico vectorial', () => {
    for (const id of ['1', '3V3', 'INT/SQW', '+']) expect(PuertoComponenteSchema.safeParse({ ...hoja().puertos[0], id }).success).toBe(true);
    expect(PuertoComponenteSchema.safeParse({ ...hoja().puertos[0], ancho: 8 }).success).toBe(false);
  });
  it.each(['latest', '^1.0.0', '01.0.0'])('rechaza versión no exacta: %s', version => {
    expect(ReferenciaComponenteSchema.safeParse({ id: 'r', version, sha256: 'a'.repeat(64) }).success).toBe(false);
  });
  it('rechaza hash inválido y drive eléctrico impuesto por el contrato', () => {
    expect(ReferenciaComponenteSchema.safeParse({ id: 'r', version: '1.0.0', sha256: 'x'.repeat(64) }).success).toBe(false);
    expect(PuertoComponenteSchema.safeParse({ id: 'OUT', dominio: 'electrico', direccion: 'salida', ancho: 1 }).success).toBe(false);
  });
  it.each([
    { tipo: 'numero', default: Infinity }, { tipo: 'numero', default: 2, min: 3 },
    { tipo: 'numero', default: 2, min: 4, max: 1 }, { tipo: 'texto', default: 'x', valores: ['y'] },
  ])('rechaza parámetro declarado inválido: %j', parametro => {
    expect(DefinicionComponenteSchema.safeParse({ ...hoja(), parametros: { valor: parametro } }).success).toBe(false);
  });
  it('rechaza terminal local inexistente y repetición en distintas redes', () => {
    const base = { ...hoja(), tipo: 'compuesto', modulo: undefined, instancias: [], conexiones: [] };
    delete base.modulo;
    const terminal = { tipo: 'externo', puerto: '1' };
    expect(DefinicionComponenteSchema.safeParse({ ...base, conexiones: [{ id: 'a', terminales: [terminal, { tipo: 'externo', puerto: 'ausente' }] }] }).success).toBe(false);
    expect(DefinicionComponenteSchema.safeParse({ ...base, conexiones: [{ id: 'a', terminales: [terminal, terminal] }] }).success).toBe(false);
  });
});
