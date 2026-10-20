import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leccionesMdx, RUTA_PILOTO } from '../../web/aprendizaje/piloto.js';
import { rutasAprendizaje } from '../../web/aprendizaje-catalogo.js';
import { contenidoAprendizaje, validarCatalogoAprendizaje } from '../../web/aprendizaje/contenido.js';

describe('integridad editorial MDX', () => {
  it('cada lección pertenece a una ruta existente y sus requisitos preceden al contenido', () => {
    expect(leccionesMdx).toHaveLength(6);
    expect(new Set(contenidoAprendizaje.map(leccion => leccion.id)).size).toBe(contenidoAprendizaje.length);
    expect(validarCatalogoAprendizaje(contenidoAprendizaje)).toEqual([]);
    expect(rutasAprendizaje.some(ruta => ruta.id === RUTA_PILOTO)).toBe(true);
    const previas = new Set<string>();
    for (const leccion of leccionesMdx) {
      expect(leccion.rutaId).toBe(RUTA_PILOTO);
      expect(leccion.requisitos.every(id => previas.has(id))).toBe(true);
      previas.add(leccion.id);
      const documento = readFileSync(new URL(`../../web/aprendizaje/lecciones/${leccion.id}.mdx`, import.meta.url), 'utf8');
      expect(documento).toContain('<Actividad />');
      expect(documento).toContain('<Pregunta');
      expect(leccion.observaciones.length).toBeGreaterThan(0);
    }
  });
});
