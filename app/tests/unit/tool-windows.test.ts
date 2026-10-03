import { describe, expect, it } from 'vitest';
import { toolWindowLayout } from '../../web/tool-windows.js';

describe('preferencias de ventanas independientes', () => {
  it('recupera preferencias válidas y descarta posiciones o estados inválidos', () => {
    expect(toolWindowLayout({ explorador: { open: true, dock: 'der' }, componentes: { open: 'no', dock: 'flotante' } })).toEqual({
      explorador: { open: true, dock: 'der' }, componentes: { open: true, dock: 'izq' },
    });
    expect(toolWindowLayout(null)).toEqual(toolWindowLayout('incorrecto'));
    expect(toolWindowLayout({ explorador: null })).toEqual(toolWindowLayout(null));
  });
  it('no comparte preferencias mutables entre lecturas', () => {
    const first = toolWindowLayout(null);
    first.componentes.open = false;
    expect(toolWindowLayout(null).componentes.open).toBe(true);
  });
});
