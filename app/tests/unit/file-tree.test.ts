import { describe, expect, it } from 'vitest';
import { construirArbolArchivos } from '../../web/file-tree.js';
import { placasDelProyecto } from '../../web/project-boards.js';

describe('árbol del explorador', () => {
  it('agrupa carpetas anidadas y conserva rutas completas sin duplicar nodos', () => {
    const tree = construirArbolArchivos(['main.py', 'lib/sensor.py', 'lib/display/oled.py', 'lib/sensor.py']);
    expect([...tree.children.keys()]).toEqual(['main.py', 'lib']);
    const lib = tree.children.get('lib')!;
    expect(lib.file).toBe(false);
    expect(lib.children.size).toBe(2);
    expect(lib.children.get('sensor.py')?.path).toBe('lib/sensor.py');
    expect(lib.children.get('display')?.children.get('oled.py')).toMatchObject({ path: 'lib/display/oled.py', file: true });
  });
  it('devuelve un árbol vacío cuando no hay archivos', () => { expect(construirArbolArchivos([]).children.size).toBe(0); });
});
describe('placas de proyecto compatibles', () => {
  it('adapta el formato legacy y no agrega duplicados al formato multi placa', () => {
    expect(placasDelProyecto({ board: 'esp32', language: 'micropython' })).toEqual([{ id: 'board', board: 'esp32', language: 'micropython' }]);
    const boards = [{ id: 'board2', board: 'uno', language: 'arduino' }];
    expect(placasDelProyecto({ board: 'esp32', boards })).toBe(boards);
  });
  it('respeta proyectos sin placas y una colección explícitamente vacía', () => {
    expect(placasDelProyecto(null)).toEqual([]);
    expect(placasDelProyecto({ board: null })).toEqual([]);
    expect(placasDelProyecto({ board: 'esp32', boards: [] })).toEqual([]);
  });
});
