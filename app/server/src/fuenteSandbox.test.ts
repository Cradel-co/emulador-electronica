import { it, expect } from 'vitest';
import { compilarFuente } from './fuenteSandbox.js';
import { validarChip } from './bus/catalogoChips.js';
import { SandboxChip } from './bus/chipSandbox.js';

it('compila TypeScript en memoria y conserva los comportamientos JavaScript', () => {
  const js = 'module.exports = { direcciones: [48] };';
  expect(compilarFuente(js,'comportamiento.js')).toBe(js);
  const ts = 'const direccion: number = 48; module.exports = { direcciones: [direccion] };';
  const r = validarChip({id:'prueba-ts',nombre:'prueba',pines:['SDA','SCL'],comportamiento:'comportamiento.ts'},ts);
  expect(r.errores).toEqual([]);
  const s = new SandboxChip('prueba',r.def?.codigo ?? '');
  expect(s.correr([],{},{}).direcciones).toEqual([48]);
  expect(() => compilarFuente('const x: = 0','roto.ts')).toThrow();
  expect(() => new SandboxChip('aislado',compilarFuente("import fs from 'node:fs'; fs.readFileSync('/tmp/no');",'host.ts'))).toThrow();
});
