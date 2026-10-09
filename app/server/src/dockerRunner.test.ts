import { describe, expect, it } from 'vitest';
import { containerNameFor } from './dockerRunner.js';

describe('identidad del contenedor de compilación', () => {
  it('separa placas con el mismo id en proyectos distintos', () => {
    expect(containerNameFor('/repo/.build/uno/boards/aux'))
      .not.toBe(containerNameFor('/repo/.build/dos/boards/aux'));
  });

  it('separa una placa adicional de un proyecto cuyo nombre coincide', () => {
    expect(containerNameFor('/repo/.build/uno/boards/aux'))
      .not.toBe(containerNameFor('/repo/.build/aux'));
  });

  it('separa checkouts distintos y conserva la identidad para limpiar y reintentar', () => {
    const directorio = '/checkout-a/.build/uno';
    expect(containerNameFor(directorio)).toBe(containerNameFor(directorio));
    expect(containerNameFor(directorio)).not.toBe(containerNameFor('/checkout-b/.build/uno'));
  });

  it('normaliza rutas equivalentes y genera un nombre válido y acotado para Docker', () => {
    expect(containerNameFor('/repo/.build/uno/boards/../aux/'))
      .toBe(containerNameFor('/repo/.build/uno/aux'));
    const nombre = containerNameFor(`/repo/.build/${'Placa con espacios '.repeat(30)}`);
    expect(nombre).toMatch(/^[a-z0-9][a-z0-9_.-]+$/);
    expect(nombre.length).toBeLessThanOrEqual(80);
  });
});
