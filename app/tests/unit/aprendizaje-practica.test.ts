import { describe, expect, it, vi } from 'vitest';
import { crearConRecuperacion } from '../../web/aprendizaje/practica.js';

describe('recuperación al crear una práctica', () => {
  it('recupera el proyecto por nombre si el POST terminó en el servidor y perdió su respuesta', async () => {
    const crear = vi.fn().mockRejectedValue(new TypeError('se perdió la conexión'));
    const recuperar = vi.fn().mockResolvedValue({ project: { name: 'practica-led' } });

    await expect(crearConRecuperacion(crear, recuperar)).resolves.toEqual({ project: { name: 'practica-led' } });
    expect(crear).toHaveBeenCalledOnce();
    expect(recuperar).toHaveBeenCalledOnce();
  });

  it('no consulta ni adopta un proyecto cuando la API rechazó la creación', async () => {
    const conflicto = new Error('El proyecto ya existe.');
    const crear = vi.fn().mockRejectedValue(conflicto);
    const recuperar = vi.fn();

    await expect(crearConRecuperacion(crear, recuperar)).rejects.toBe(conflicto);
    expect(recuperar).not.toHaveBeenCalled();
  });

  it('conserva el error de transporte si no encuentra el proyecto o falla la consulta', async () => {
    const red = new TypeError('se perdió la conexión');
    await expect(crearConRecuperacion(
      () => Promise.reject(red),
      async () => null,
    )).rejects.toBe(red);
    await expect(crearConRecuperacion(
      () => Promise.reject(red),
      () => Promise.reject(new Error('GET caído')),
    )).rejects.toBe(red);
  });
});
