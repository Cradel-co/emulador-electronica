import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATHS } from './paths.js';
import { armarChangelog, leerFragmento, TIPOS_CAMBIO, type Fragmento } from './changelog.js';

/**
 * El changelog se lleva en **un archivo por cambio** (`changelog.d/`), no en un CHANGELOG.md único
 * que todas las ramas editan: con varias ramas abiertas en paralelo, ese archivo da conflicto en
 * cada merge porque todas tocan las mismas líneas de arriba.
 */

const frag = (tipo: string, slug: string, resumen: string, detalle = ''): Fragmento | undefined =>
  leerFragmento(`${tipo}-${slug}.md`, detalle ? `${resumen}\n\n${detalle}\n` : `${resumen}\n`).fragmento;

describe('leerFragmento: el nombre dice el tipo', () => {
  it('acepta los tipos que usan las ramas', () => {
    for (const t of TIPOS_CAMBIO) {
      const r = leerFragmento(`${t}-algo-corto.md`, 'El buzzer pasivo ahora toca notas.\n');
      expect(r.errores, t).toEqual([]);
      expect(r.fragmento?.tipo, t).toBe(t);
    }
  });

  it('rechaza un tipo que no existe, diciendo cuáles valen', () => {
    const r = leerFragmento('mejora-algo.md', 'Algo.\n');
    expect(r.fragmento).toBeUndefined();
    expect(r.errores.join(' ')).toMatch(/feat/);
  });

  it('rechaza nombres sin descripción o con mayúsculas y espacios', () => {
    for (const nombre of ['fix.md', 'fix-.md', 'fix-AB.md', 'fix-con espacio.md', 'fix-ab.md', 'notas.txt']) {
      expect(leerFragmento(nombre, 'Algo que pasó.\n').fragmento, nombre).toBeUndefined();
    }
  });

  it('separa el resumen del detalle', () => {
    const f = frag('fix', 'el-adc-no-refrescaba', 'El firmware ya ve los cambios de prop.', 'Antes se quedaba con la instantánea del arranque.');
    expect(f?.resumen).toBe('El firmware ya ve los cambios de prop.');
    expect(f?.detalle).toBe('Antes se quedaba con la instantánea del arranque.');
  });
});

describe('leerFragmento: el contenido tiene que servirle a alguien', () => {
  it('rechaza un fragmento vacío', () => {
    for (const c of ['', '\n\n', '   ']) expect(leerFragmento('fix-algo.md', c).fragmento).toBeUndefined();
  });

  it('rechaza un resumen de relleno', () => {
    for (const c of ['TODO', 'por completar', 'describir el cambio', 'wip']) {
      const r = leerFragmento('fix-algo.md', `${c}\n`);
      expect(r.fragmento, c).toBeUndefined();
      expect(r.errores.join(' '), c).toMatch(/relleno|completar/i);
    }
  });

  it('rechaza un resumen larguísimo: el resumen es una línea', () => {
    expect(leerFragmento('fix-algo.md', `${'a'.repeat(200)}\n`).fragmento).toBeUndefined();
  });
});

describe('armarChangelog', () => {
  const fragmentos = [
    frag('feat', 'buzzer-pasivo', 'El buzzer pasivo toca notas con PWM.')!,
    frag('fix', 'pwm-sin-sonido', 'El buzzer pasivo ya suena: el motor no sabía que el pin era salida.')!,
    frag('feat', 'sonometro', 'Sonómetro SEN0232 como entrada analógica.')!,
    frag('docs', 'agregar-un-modulo', 'El proceso para agregar un módulo, con el error que originó cada paso.')!,
  ];

  it('agrupa por tipo y pone los títulos en español', () => {
    const md = armarChangelog(fragmentos, { version: '0.2.0', fecha: '2026-10-07' });
    expect(md).toMatch(/## 0\.2\.0 — 2026-10-07/);
    expect(md).toMatch(/### Nuevo/);
    expect(md).toMatch(/### Arreglado/);
    expect(md).toMatch(/### Documentación/);
    expect(md.indexOf('### Nuevo')).toBeLessThan(md.indexOf('### Arreglado'));
  });

  it('cada fragmento es una viñeta con su resumen', () => {
    const md = armarChangelog(fragmentos, { version: '0.2.0', fecha: '2026-10-07' });
    expect(md).toContain('- El buzzer pasivo toca notas con PWM.');
    expect(md).toContain('- Sonómetro SEN0232 como entrada analógica.');
  });

  it('el detalle va indentado abajo de su viñeta', () => {
    const conDetalle = [frag('fix', 'algo-concreto', 'Resumen corto.', 'El por qué, que conviene saber.')!];
    expect(armarChangelog(conDetalle, { version: '0.1.0', fecha: '2026-10-07' }))
      .toMatch(/- Resumen corto\.\n {2}El por qué, que conviene saber\./);
  });

  it('no inventa secciones vacías', () => {
    const md = armarChangelog([frag('fix', 'algo-concreto', 'Algo que se arregló.')!], { version: '0.1.0', fecha: '2026-10-07' });
    expect(md).not.toMatch(/### Nuevo/);
  });

  it('sin fragmentos lo dice en vez de devolver una sección hueca', () => {
    expect(armarChangelog([], { version: '0.1.0', fecha: '2026-10-07' })).toMatch(/sin cambios/i);
  });
});

describe('los fragmentos que hay en el repo son válidos', () => {
  const dir = path.join(PATHS.root, 'changelog.d');

  it('cada .md de changelog.d pasa la validación', () => {
    if (!existsSync(dir)) return;
    const archivos = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
    for (const a of archivos) {
      const { errores } = leerFragmento(a, readFileSync(path.join(dir, a), 'utf8'));
      expect(errores, `changelog.d/${a}`).toEqual([]);
    }
  });
});
