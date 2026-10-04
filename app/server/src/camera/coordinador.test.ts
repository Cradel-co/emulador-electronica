import { it, expect } from 'vitest';
import { ServicioCamara } from './servicio.js';
import { CoordinadorCapturas } from './coordinador.js';
import type { EntradaChip } from '../bus/chipSandbox.js';

it('coordina fallos y cancela solicitudes al reiniciar sin mezclar instancias', () => {
  const s = new ServicioCamara(()=>{}), c = new CoordinadorCapturas(s,()=>{});
  const entradas: { instancia: string; datos: EntradaChip }[] = [];
  const entrada = (instancia: string, datos: EntradaChip) => entradas.push({instancia,datos});
  c.salida('p','a:arduchip',{cameraAction:'capture',token:1},entrada);
  expect(entradas.at(-1)).toMatchObject({instancia:'a',datos:{tipo:'fallo',token:1}});
  s.abrir('p','a'); s.abrir('p','b');
  c.salida('p','a:arduchip',{cameraAction:'capture',token:2},entrada);
  c.salida('p','b:arduchip',{cameraAction:'capture',token:3},entrada);
  c.salida('p','a:arduchip',{cameraAction:'cancel'},entrada);
  expect(entradas.at(-1)).toMatchObject({instancia:'a',datos:{tipo:'fallo',token:2}});
  expect(()=>s.solicitar('p','b',()=>{},()=>{})).toThrow();
  c.salida('p','b:arduchip',{cameraAction:'cancel'},entrada);
  expect(entradas.at(-1)).toMatchObject({instancia:'b',datos:{tipo:'fallo',token:3}});
});
