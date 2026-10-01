import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATHS } from '../paths.js';
import { cargarChips, validarChip } from './catalogoChips.js';

/**
 * Un chip que no valida queda fuera del catálogo con un aviso en la consola del server, y los
 * módulos que lo usan dejan de responder: acá se exige que todos los de fábrica carguen.
 */
describe('catálogo de chips', () => {
  it('cada carpeta de chips/ con chip.json carga (ninguno queda afuera en silencio)', () => {
    const carpetas = readdirSync(PATHS.chips).filter((d) => statSync(path.join(PATHS.chips, d)).isDirectory());
    expect(cargarChips().map((c) => c.id).sort()).toEqual(carpetas.sort());
  });

  it('validarChip da errores legibles: campo y motivo', () => {
    const r = validarChip({ id: 'X', nombre: '', pines: [], comportamiento: 'a.txt' }, '');
    expect(r.def).toBeUndefined();
    expect(r.errores.join('\n')).toMatch(/id:/);
    expect(r.errores.join('\n')).toMatch(/comportamiento:/);
  });

  it('un comportamiento con error de sintaxis no se acepta', () => {
    const r = validarChip({ id: 'x', nombre: 'X', pines: ['A'], comportamiento: 'c.js' }, 'module.exports = {');
    expect(r.errores[0]).toMatch(/chip "x"/);
  });
});
