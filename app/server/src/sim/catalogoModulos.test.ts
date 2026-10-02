import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { probarModulo, type InformeModulo } from './pruebasModulo.js';
import { precalentar } from './spice.js';

/**
 * Todos los módulos de fábrica, con su propio banco de pruebas (tests.json), sus reglas y su
 * esquemático validados, y en el nivel "fabricable". Un módulo nuevo de fábrica que no cumpla
 * esto rompe este test: es la lista de lo que tiene que tener (ver modules/README.md).
 */

let cat: ModuloCatalogo[] = [];
const informes = new Map<string, InformeModulo>();
const buscar = (t: string) => cat.find((m) => m.type === t);

beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
  for (const m of cat) informes.set(m.type, await probarModulo(m, buscar));
}, 240_000);

/** Nombres de KiCad usados por los módulos de fábrica, verificados contra las librerías oficiales. */
const KICAD = new Set(
  readFileSync(new URL('../fixtures/kicad-verificados.txt', import.meta.url), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
);

describe('módulos de fábrica: cada uno se prueba a sí mismo', () => {
  it('hay módulos', () => expect(cat.length).toBeGreaterThan(15));

  it('lo declarado es coherente (pines, elementos, esquemático, reglas, pruebas)', () => {
    const malos = Object.fromEntries([...informes].filter(([, i]) => i.errores.length).map(([t, i]) => [t, i.errores]));
    expect(malos).toEqual({});
  });

  it('todas las pruebas pasan (con el motor eléctrico real)', () => {
    const malas = [...informes].flatMap(([t, i]) => i.pruebas.filter((p) => !p.ok).map((p) => `${t} › ${p.nombre}: ${p.fallas.join('; ')}`));
    expect(malas).toEqual([]);
  });

  it('todos llegan a "fabricable": parte, esquemático con huella, y pruebas', () => {
    const faltan = Object.fromEntries([...informes].filter(([, i]) => i.nivel !== 'fabricable').map(([t, i]) => [t, i.falta]));
    expect(faltan).toEqual({});
  });

  it('cada módulo con modelo eléctrico o pines tiene al menos un caso propio en tests.json', () => {
    const sin = cat.filter((m) => m.pins.length > 0 && !(m.pruebas?.length)).map((m) => m.type);
    expect(sin).toEqual([]);
  });

  it('los símbolos y huellas de KiCad existen en las librerías oficiales (lista verificada)', () => {
    const usados = cat.flatMap((m) => [
      m.esquematico?.simbolo, m.esquematico?.huella, ...(m.esquematico?.conectores ?? []).map((c) => c.huella),
      ...(m.esquematico?.discreto ?? []).flatMap((p) => [p.simbolo, p.huella]),
    ].filter((x): x is string => !!x).map((x) => `${m.type}: ${x}`));
    expect(usados.filter((u) => !KICAD.has(u.split(': ')[1]!))).toEqual([]);
  });
});
