import { describe, expect, it } from 'vitest';
import { filtrar, palabrasDe, puntaje, TOPE, tramos } from '../../web/paleta.js';

const c = (titulo: string, tipo = 'Acción') => ({ tipo, titulo, hacer: () => {} });

describe('puntaje', () => {
  it('menor es mejor: empezar el título gana a empezar una palabra, y eso a estar a mitad', () => {
    expect(puntaje('LED', ['led'])).toBe(0);
    expect(puntaje('Agregar LED', ['led'])).toBe(1);
    expect(puntaje('Modelo', ['del'])).toBe(3);
  });

  it('si falta alguna palabra, -1', () => {
    expect(puntaje('Agregar LED', ['agregar', 'relé'])).toBe(-1);
  });

  it('cuenta los separadores habituales como inicio de palabra', () => {
    for (const t of ['a·led', 'a-led', 'a_led', 'a.led', 'a/led']) expect(puntaje(t, ['led'])).toBe(1);
  });
});

describe('filtrar', () => {
  const todos = [c('Modelo del circuito'), c('Agregar LED', 'Módulo'), c('LED rojo'), c('Parar')];

  it('ordena por puntaje', () => {
    expect(filtrar(todos, 'led').map((x) => x.titulo)).toEqual(['LED rojo', 'Agregar LED']);
  });

  it('a igual puntaje respeta el orden de llegada', () => {
    const iguales = [c('b led'), c('a led')];
    expect(filtrar(iguales, 'led').map((x) => x.titulo)).toEqual(['b led', 'a led']);
  });

  it('sin consulta devuelve los primeros tal cual, y nunca más que el tope', () => {
    const muchos = Array.from({ length: 200 }, (_, i) => c(`item ${i}`));
    expect(filtrar(muchos, '')).toHaveLength(TOPE);
    expect(filtrar(muchos, '   ')[0]!.titulo).toBe('item 0');
    expect(filtrar(muchos, 'item')).toHaveLength(TOPE);
  });

  it('todas las palabras tienen que aparecer', () => {
    expect(filtrar(todos, 'agregar led').map((x) => x.titulo)).toEqual(['Agregar LED']);
    expect(filtrar(todos, 'zzz')).toEqual([]);
  });
});

describe('tramos (el resaltado)', () => {
  it('marca la primera aparición de cada palabra, sin distinguir mayúsculas', () => {
    expect(tramos('Agregar LED', palabrasDe('agregar led'))).toEqual([
      { texto: 'Agregar', marcado: true },
      { texto: ' ', marcado: false },
      { texto: 'LED', marcado: true },
    ]);
  });

  it('conserva las mayúsculas del título original', () => {
    expect(tramos('Abrir proyecto', ['abrir'])[0]).toEqual({ texto: 'Abrir', marcado: true });
  });

  it('sin palabras, el título entero sin marcar', () => {
    expect(tramos('Parar', [])).toEqual([{ texto: 'Parar', marcado: false }]);
  });

  it('dos palabras que se pisan no rompen el resultado', () => {
    // Con el resaltado viejo (reemplazos sobre el HTML), "mar" caía adentro de un <mark>.
    const r = tramos('marcar', ['marca', 'mar']);
    expect(r.map((x) => x.texto).join('')).toBe('marcar');
    expect(r.filter((x) => x.marcado)).toHaveLength(1);
  });
});
