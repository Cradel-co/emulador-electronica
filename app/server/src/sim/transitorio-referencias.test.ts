import { expect, it } from 'vitest';
import { Netlist } from './netlist.js';
import { nodosReferenciadosTransitorio } from './transitorio-referencias.js';

it('recorre R/S conductores, C/L y V sin confundir otra isla con la referencia', () => {
  const n = new Netlist('islas');
  n.agregar('m', { tipo: 'V', nombre: 'v', a: 'alimentacion', b: '0', voltios: 5 });
  n.agregar('m', { tipo: 'R', nombre: 'r', a: 'alimentacion', b: 'a', ohms: 1000 });
  n.agregar('m', { tipo: 'C', nombre: 'c', a: 'a', b: 'b', faradios: 1e-6, v0: 0 });
  n.agregar('m', { tipo: 'L', nombre: 'l', a: 'b', b: 'c', henrios: 1e-3, i0: 0 });
  n.agregar('m', { tipo: 'S', nombre: 'cerrado', a: 'c', b: 'd', cerrado: true });
  n.agregar('m', { tipo: 'R', nombre: 'aislada', a: 'isla1', b: 'isla2', ohms: 1000 });
  expect([...nodosReferenciadosTransitorio(n.elementos, ['0'])].sort()).toEqual(['0', 'a', 'alimentacion', 'b', 'c', 'd']);
});

it('no ancla por fugas, contactos abiertos, corriente ideal ni terminales de control', () => {
  const n = new Netlist('sin camino físico comprobado');
  n.agregar('m', { tipo: 'R', nombre: 'fuga', a: 'fuga', b: '0', ohms: 1e12 });
  n.agregar('m', { tipo: 'S', nombre: 'abierto', a: 'abierto', b: '0', cerrado: false });
  n.agregar('m', { tipo: 'I', nombre: 'i', a: 'corriente', b: '0', amperios: 1e-3 });
  n.agregar('m', { tipo: 'D', nombre: 'd', a: 'diodo', b: '0', modelo: { is: 1e-15, n: 1 } });
  n.agregar('m', { tipo: 'SV', nombre: 'sv', a: 'sv1', b: 'sv2', cp: '0', cn: 'control', umbral: 1 });
  n.agregar('m', { tipo: 'REG', nombre: 'reg', a: 'entrada', b: 'salida', tierra: '0', voltios: 3.3, caida: 0.3, limiteA: 1 });
  expect([...nodosReferenciadosTransitorio(n.elementos, ['0'])]).toEqual(['0']);
});
