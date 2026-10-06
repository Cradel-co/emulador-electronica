import { describe, expect, it } from 'vitest';
import { Netlist } from './netlist.js';

describe('netlist: una medición ausente no equivale a cero', () => {
  const resistor = () => { const n = new Netlist('prueba'); n.agregar('r', { tipo: 'R', nombre: 'r', a: 'n1', b: '0', ohms: 1000 }); return n; };
  it('rechaza un voltaje requerido ausente', () => {
    expect(() => resistor().resolver({ valores: new Map(), errores: [] })).toThrow(/v\(n1\)/);
  });
  it.each([NaN, Infinity, -Infinity])('rechaza un voltaje no finito: %s', (v) => {
    expect(() => resistor().resolver({ valores: new Map([['v(n1)', v]]), errores: [] })).toThrow(/finito/);
  });
  it('acepta cero medido y tierra implícita, sin vector de ground', () => {
    expect(resistor().resolver({ valores: new Map([['v(n1)', 0]]), errores: [] })[0]).toMatchObject({ va: 0, vb: 0, i: 0, p: 0 });
  });
  it('rechaza corriente de amperímetro ausente', () => {
    const n = new Netlist('prueba'); n.agregar('v', { tipo: 'V', nombre: 'salida', a: 'n1', b: '0', voltios: 5 });
    expect(() => n.resolver({ valores: new Map([['v(n1)', 5]]), errores: [] })).toThrow(/i\(vam_/);
  });
  it('rechaza un resultado con diagnóstico fatal aunque contenga voltajes', () => {
    expect(() => resistor().resolver({ valores: new Map([['v(n1)', 0]]), errores: ['Error: simulation aborted'] })).toThrow(/aborted/);
  });
});

describe('netlist: las primitivas inválidas no llegan a ngspice', () => {
  it.each([0, -1, NaN, Infinity])('rechaza resistencia inválida %s', ohms => {
    expect(() => new Netlist('prueba').agregar('r', { tipo: 'R', nombre: 'r', a: 'n1', b: '0', ohms })).toThrow(/ohms/);
  });
  it('rechaza NaN en voltaje y límite infinito', () => {
    expect(() => new Netlist('prueba').agregar('v', { tipo: 'V', nombre: 'v', a: 'n1', b: '0', voltios: NaN })).toThrow(/voltios/);
    expect(() => new Netlist('prueba').agregar('v', { tipo: 'V', nombre: 'v', a: 'n1', b: '0', voltios: 5, limiteA: Infinity })).toThrow(/limiteA/);
  });
  it('rechaza derivadas y diodos con parámetros inválidos', () => {
    expect(() => new Netlist('prueba').agregar('c', { tipo: 'C', nombre: 'c', a: 'n1', b: '0', faradios: -1 })).toThrow(/faradios/);
    expect(() => new Netlist('prueba').agregar('l', { tipo: 'L', nombre: 'l', a: 'n1', b: '0', henrios: 0 })).toThrow(/henrios/);
    expect(() => new Netlist('prueba').agregar('d', { tipo: 'D', nombre: 'd', a: 'n1', b: '0', modelo: { is: 1e-12, n: 1, rs: -1 } })).toThrow(/rs/);
  });
  it('rechaza IDs de elemento duplicados antes de mezclar mediciones', () => {
    const n = new Netlist('prueba'); const r = { tipo: 'R' as const, nombre: 'r', a: 'n1', b: '0', ohms: 1000 };
    n.agregar('m', r);
    expect(() => n.agregar('m', r)).toThrow(/duplicado/);
  });
});
