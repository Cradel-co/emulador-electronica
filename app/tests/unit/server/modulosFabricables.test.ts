import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog, type ModuloCatalogo } from '../../../server/src/catalog.js';
import { probarModulo } from '../../../server/src/sim/pruebasModulo.js';
import { precalentar } from '../../../server/src/sim/spice.js';

/**
 * Lo que un módulo de fábrica dice de sí mismo para **probarse y fabricarse** (SDD-MODULOS.md,
 * secciones 3 y 4): sus casos de `tests.json` corridos con el motor eléctrico real, sus símbolos y
 * huellas de KiCad verificados contra las librerías oficiales, y todos los `model.ts` tipeados con
 * el tsconfig de `modules/` (strict).
 *
 * El nivel de cada módulo (dibujo → simula → probado → fabricable) lo calcula `nivelModulo` y se ve
 * en su panel, en `GET /api/modules` y en las herramientas MCP `catalogo` y `probar_modulo`.
 */

let cat: ModuloCatalogo[] = [];
const buscar = (t: string) => cat.find((m) => m.type === t);
beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 240_000);

/** Nombres de KiCad usados por los módulos de fábrica, verificados contra las librerías oficiales. */
const KICAD = new Set(
  readFileSync(new URL('../../fixtures/server/kicad-verificados.txt', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')),
);

describe('módulos de fábrica: se prueban a sí mismos y se pueden fabricar', () => {
  it('los módulos con tests.json están coherentes y pasan todos sus casos (con el motor real)', async () => {
    const malos: Record<string, { errores: string[]; fallas: string[] }> = {};
    for (const m of cat.filter((m) => (m.pruebas?.length ?? 0) > 0)) {
      const inf = await probarModulo(m, buscar);
      const fallas = inf.pruebas.filter((p) => !p.ok).map((p) => `${p.nombre}: ${p.fallas.join('; ')}`);
      if (inf.errores.length || fallas.length) malos[m.type] = { errores: inf.errores, fallas };
    }
    expect(malos).toEqual({});
  }, 240_000);

  it('los símbolos y huellas de KiCad existen en la lista verificada', () => {
    const usados = cat.flatMap((m) => [
      m.esquematico?.simbolo,
      m.esquematico?.huella,
      ...(m.esquematico?.conectores ?? []).map((c) => c.huella),
      ...(m.esquematico?.discreto ?? []).flatMap((p) => [p.simbolo, p.huella]),
    ].filter((x): x is string => !!x).map((x) => `${m.type}: ${x}`));
    expect(usados.filter((u) => !KICAD.has(u.split(': ')[1]!))).toEqual([]);
  });

  it('los tipos de todos los model.ts se verifican con el tsconfig de modules/ (strict)', () => {
    const tsc = new URL('../../../node_modules/typescript/bin/tsc', import.meta.url).pathname;
    const r = spawnSync(process.execPath, [tsc, '-p', new URL('../../../../modules/tsconfig.json', import.meta.url).pathname], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  }, 180_000);
});
