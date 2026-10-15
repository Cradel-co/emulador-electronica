import { describe, expect, it } from 'vitest';
import { normalizeWorkspaceRoute, parseWorkspaceRoute, sameWorkspaceRoute, workspaceRoutePath, WorkspaceRouteError } from '../../web/navigation-route.js';

describe('contrato de rutas del espacio de trabajo', () => {
  it.each(['', '#', '/', '#/'])('reconoce Inicio %j', href => {
    expect(parseWorkspaceRoute(href)).toEqual({ project: null });
  });

  it('admite el índice y una lección con un paso en el historial', () => {
    expect(parseWorkspaceRoute('#/aprender')).toEqual({ project: null, aprender: {} });
    expect(parseWorkspaceRoute('#/aprender/encender-un-led?paso=probar')).toEqual({
      project: null, aprender: { leccion: 'encender-un-led', paso: 'probar' },
    });
    expect(workspaceRoutePath({ project: null, aprender: { leccion: 'encender-un-led', paso: 'probar' } }))
      .toBe('/aprender/encender-un-led?paso=probar');
  });

  it('migra enlaces de proyectos anteriores sin perder caracteres', () => {
    expect(parseWorkspaceRoute('#alarma%20patio')).toEqual({ project: 'alarma patio' });
    expect(workspaceRoutePath(parseWorkspaceRoute('#alarma%20patio'))).toBe('/projects/alarma%20patio');
  });

  it('preserva placa y archivos anidados, incluidos espacios y signos', () => {
    const route = { project: 'casa ñ', board: 'esp32-2', file: 'sensores/temperatura + habitación.py' };
    expect(parseWorkspaceRoute(`#${workspaceRoutePath(route)}`)).toEqual(route);
  });

  it('conserva la lección asociada a la ruta de una práctica', () => {
    const route = { project: 'practica led', board: 'board', leccion: 'encender-un-led' };
    expect(parseWorkspaceRoute('#/projects/practica%20led?board=board&leccion=encender-un-led')).toEqual(route);
    expect(workspaceRoutePath(route)).toBe('/projects/practica%20led?board=board&leccion=encender-un-led');
    expect(sameWorkspaceRoute(route, { ...route, leccion: undefined })).toBe(false);
  });

  it('permite enlaces parciales y descarta parámetros ajenos al contrato', () => {
    expect(parseWorkspaceRoute('/projects/casa?board=1&otro=valor')).toEqual({ project: 'casa', board: '1' });
    expect(parseWorkspaceRoute('/projects/casa?file=lib%2Fsensor.py')).toEqual({ project: 'casa', file: 'lib/sensor.py' });
  });

  it.each(['#%ZZ', '#%E0%A4%A', '/projects/%ZZ', '/projects/casa?file=%ZZ', '/projects/casa?file=%E0%A4%A'])('rechaza escapes dañados %j con un error del dominio', href => {
    expect(() => parseWorkspaceRoute(href)).toThrow(WorkspaceRouteError);
  });

  it.each(['/inexistente', '/projects/', '/projects/casa/archivo', '/projects/..', '/projects/a%2Fb', '/projects/casa?board=..', '/projects/casa?file=../main.py', '/projects/casa?file=lib//sensor.py', '/projects/casa?file=lib%5Csensor.py', '/projects/casa?board=a&board=b', '/projects/casa?file=a&file=b', '/projects/casa#otra'])('rechaza rutas ambiguas o inseguras %j', href => {
    expect(() => parseWorkspaceRoute(href)).toThrow(WorkspaceRouteError);
  });

  it('Inicio no conserva una selección huérfana', () => {
    expect(normalizeWorkspaceRoute({ project: null, board: 'board', file: 'main.py' })).toEqual({ project: null });
    expect(workspaceRoutePath({ project: null, file: 'main.py' })).toBe('/');
  });

  it('distingue selección, placa y proyecto sin depender del orden de un objeto', () => {
    expect(sameWorkspaceRoute({ project: 'casa', board: 'uno' }, { board: 'uno', project: 'casa' })).toBe(true);
    expect(sameWorkspaceRoute({ project: 'casa', board: 'uno' }, { project: 'casa', board: 'dos' })).toBe(false);
    expect(sameWorkspaceRoute({ project: 'casa', file: 'a.py' }, { project: 'casa', file: 'b.py' })).toBe(false);
    expect(sameWorkspaceRoute({ project: null }, { project: null, aprender: {} })).toBe(false);
  });
});
