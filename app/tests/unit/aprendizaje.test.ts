import { describe, expect, it } from 'vitest';
import { contenidoAprendizaje, leccionPorId, validarCatalogoAprendizaje } from '../../web/aprendizaje/contenido.js';

describe('contenido de Aprender', () => {
  it('publica una lección de LED completa con IDs únicos y pasos navegables', () => {
    expect(validarCatalogoAprendizaje(contenidoAprendizaje)).toEqual([]);
    expect(contenidoAprendizaje.map(leccion => leccion.id)).toEqual(['encender-un-led']);
    const leccion = leccionPorId('encender-un-led');
    expect(leccion?.pasos.map(paso => paso.id)).toEqual([
      'identificar', 'seguir-circuito', 'estimar-corriente', 'probar', 'invertir-led',
    ]);
    expect(leccionPorId('no-existe')).toBeUndefined();
  });

  it('detecta metadatos ausentes, IDs duplicados y pasos vacíos', () => {
    expect(validarCatalogoAprendizaje([{
      id: 'incompleta', revision: 1, titulo: '', resumen: 'x', nivel: 'inicial', duracionMinutos: 0,
      orden: 1, objetivos: [], requisitos: [], materiales: [], pasos: [
        { id: 'igual', titulo: 'A', bloques: [] },
        { id: 'igual', titulo: 'B', bloques: [{ tipo: 'parrafo', texto: 'texto' }] },
      ], erroresFrecuentes: [],
    }])).toEqual([
      'incompleta: falta el título.',
      'incompleta: la duración debe ser positiva.',
      'incompleta: debe tener al menos un objetivo.',
      'incompleta/igual: el paso debe tener contenido.',
      'incompleta: los pasos deben tener IDs y títulos únicos.',
    ]);
  });
});
