import { describe, expect, it } from 'vitest';
import { completarLeccion, leerProgreso, progresoDeLeccion, registrarPaso } from '../../web/aprendizaje/progreso.js';

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

  it('reinicia la finalización cuando cambia la revisión y elimina registros inválidos', () => {
    const almacen = new AlmacenMemoria();
    registrarPaso(almacen, 'encender-un-led', 1, 'probar');
    completarLeccion(almacen, 'encender-un-led', 1, 'invertir-led');
    registrarPaso(almacen, 'encender-un-led', 2, 'identificar');
    expect(progresoDeLeccion(almacen, 'encender-un-led', 2)).toEqual({ revision: 2, ultimoPasoId: 'identificar', completada: false });
    almacen.datos.set('emu.aprendizaje.v1', JSON.stringify({ version: 1, lecciones: { mal: { revision: 0, completada: 'sí' } } }));
    expect(leerProgreso(almacen)).toEqual({ version: 1, lecciones: {} });
  });
});
