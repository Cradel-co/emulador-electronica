import { describe, expect, it } from 'vitest';
import { asociarProyecto, completarLeccion, leerProgreso, progresoDeLeccion, quitarAsociacionProyecto, registrarPaso, registroDeLeccion } from '../../web/aprendizaje/progreso.js';

class AlmacenMemoria {
  datos = new Map<string, string>();
  getItem(clave: string): string | null { return this.datos.get(clave) ?? null; }
  setItem(clave: string, valor: string): void { this.datos.set(clave, valor); }
}

describe('progreso local de Aprender', () => {
  it('recuerda el último paso y marca la revisión actual como completada', () => {
    const almacen = new AlmacenMemoria();
    registrarPaso(almacen, 'encender-un-led', 1, 'probar');
    expect(progresoDeLeccion(almacen, 'encender-un-led', 1)).toEqual({ revision: 1, ultimoPasoId: 'probar', completada: false });
    completarLeccion(almacen, 'encender-un-led', 1, 'invertir-led');
    expect(progresoDeLeccion(almacen, 'encender-un-led', 1)?.completada).toBe(true);
    expect(progresoDeLeccion(almacen, 'encender-un-led', 2)).toBeUndefined();
  });

  it('ignora datos corruptos, versiones futuras y errores del almacenamiento', () => {
    const almacen = new AlmacenMemoria();
    almacen.datos.set('emu.aprendizaje.v1', '{ roto');
    expect(leerProgreso(almacen)).toEqual({ version: 1, lecciones: {} });
    almacen.datos.set('emu.aprendizaje.v1', JSON.stringify({ version: 8, lecciones: {} }));
    expect(leerProgreso(almacen)).toEqual({ version: 1, lecciones: {} });
    const roto = { getItem() { throw new Error('sin acceso'); }, setItem() { throw new Error('cuota'); } };
    expect(leerProgreso(roto)).toEqual({ version: 1, lecciones: {} });
    expect(() => registrarPaso(roto, 'encender-un-led', 1, 'probar')).not.toThrow();
  });

  it('mantiene el progreso en memoria mientras el almacenamiento está bloqueado', () => {
    const bloqueado = { getItem() { return null; }, setItem() { throw new Error('cuota'); } };
    registrarPaso(bloqueado, 'leccion-sin-storage', 1, 'paso-1');
    expect(registroDeLeccion(bloqueado, 'leccion-sin-storage')).toEqual({
      revision: 1, ultimoPasoId: 'paso-1', completada: false,
    });
  });

  it('reinicia la finalización cuando cambia la revisión y elimina registros inválidos', () => {
    const almacen = new AlmacenMemoria();
    registrarPaso(almacen, 'encender-un-led', 1, 'probar');
    completarLeccion(almacen, 'encender-un-led', 1, 'invertir-led');
    registrarPaso(almacen, 'encender-un-led', 2, 'identificar');
    expect(progresoDeLeccion(almacen, 'encender-un-led', 2)).toEqual({ revision: 2, ultimoPasoId: 'identificar', completada: false });
    almacen.datos.set('emu.aprendizaje.v1', JSON.stringify({ version: 1, lecciones: { mal: { revision: 0, completada: 'sí' } } }));
    expect(leerProgreso(almacen)).toEqual({ version: 1, lecciones: {} });
  });

  it('asocia una práctica sin perder progreso y limpia la asociación si se borró el proyecto', () => {
    const almacen = new AlmacenMemoria();
    registrarPaso(almacen, 'encender-un-led', 1, 'invertir-led');
    asociarProyecto(almacen, 'encender-un-led', 1, 'practica-led');
    completarLeccion(almacen, 'encender-un-led', 1, 'invertir-led');
    expect(progresoDeLeccion(almacen, 'encender-un-led', 1)).toEqual({
      revision: 1, ultimoPasoId: 'invertir-led', completada: true,
      completadaEn: expect.any(String), proyectoNombre: 'practica-led',
    });
    quitarAsociacionProyecto(almacen, 'encender-un-led', 1);
    expect(progresoDeLeccion(almacen, 'encender-un-led', 1)).toMatchObject({
      ultimoPasoId: 'invertir-led', completada: true,
    });
    expect(progresoDeLeccion(almacen, 'encender-un-led', 1)?.proyectoNombre).toBeUndefined();
  });

  it('conserva la práctica al cambiar la revisión y descarta nombres corruptos', () => {
    const almacen = new AlmacenMemoria();
    asociarProyecto(almacen, 'encender-un-led', 1, 'practica-led');
    registrarPaso(almacen, 'encender-un-led', 2, 'identificar');
    expect(progresoDeLeccion(almacen, 'encender-un-led', 2)).toMatchObject({
      revision: 2, ultimoPasoId: 'identificar', completada: false, proyectoNombre: 'practica-led',
    });
    almacen.datos.set('emu.aprendizaje.v1', JSON.stringify({
      version: 1, lecciones: { 'encender-un-led': { revision: 2, completada: false, proyectoNombre: 4 } },
    }));
    expect(leerProgreso(almacen).lecciones['encender-un-led']).toBeUndefined();
  });

  it('expone un registro de otra revisión para retomar la práctica y revisar la lección', () => {
    const almacen = new AlmacenMemoria();
    registrarPaso(almacen, 'encender-un-led', 1, 'paso-que-sigue-existiendo');
    asociarProyecto(almacen, 'encender-un-led', 1, 'practica-led');
    completarLeccion(almacen, 'encender-un-led', 1, 'paso-que-sigue-existiendo');
    expect(progresoDeLeccion(almacen, 'encender-un-led', 2)).toBeUndefined();
    expect(registroDeLeccion(almacen, 'encender-un-led')).toMatchObject({
      revision: 1, ultimoPasoId: 'paso-que-sigue-existiendo', completada: true, proyectoNombre: 'practica-led',
    });
  });
});
