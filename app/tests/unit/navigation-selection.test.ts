import { describe, expect, it } from 'vitest';
import { resolveWorkspaceSelection } from '../../web/navigation-selection.js';

const boards = [{ id: 'board' }, { id: 'segunda' }];
const trees = [
  { id: 'board', name: 'ESP32', files: [{ path: 'lib/main.py' }, { path: 'main.py' }], directories: ['lib'] },
  { id: 'segunda', name: 'Arduino', files: [{ path: 'sketch.cpp' }, { path: 'lib/sensor.cpp' }], directories: ['lib'] },
];
describe('selección de contexto desde una ruta', () => {
  it('elige el principal de la primera placa y no un main anidado', () => {
    expect(resolveWorkspaceSelection({ project: 'casa' }, boards, trees)).toEqual({ board: 'board', file: 'main.py' });
  });
  it('restaura un archivo anidado de otra placa', () => {
    expect(resolveWorkspaceSelection({ project: 'casa', board: 'segunda', file: 'lib/sensor.cpp' }, boards, trees)).toEqual({ board: 'segunda', file: 'lib/sensor.cpp' });
  });
  it('recupera el principal cuando se elimina el archivo', () => {
    expect(resolveWorkspaceSelection({ project: 'casa', board: 'segunda', file: 'borrado.cpp' }, boards, trees)).toEqual({ board: 'segunda', file: 'sketch.cpp' });
  });
  it('recupera la primera placa cuando se elimina la seleccionada', () => {
    expect(resolveWorkspaceSelection({ project: 'casa', board: 'borrada' }, boards, trees)).toEqual({ board: 'board', file: 'main.py' });
  });
  it('permite circuitos sin placa y placas sin archivos', () => {
    expect(resolveWorkspaceSelection({ project: 'casa' }, [], [])).toEqual({});
    expect(resolveWorkspaceSelection({ project: 'casa' }, boards, [])).toEqual({ board: 'board' });
  });
});
