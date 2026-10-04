import { describe, expect, it } from 'vitest';
import {
  defaultProject,
  isAllowedFileName,
  isValidProjectName,
  ProjectSchema,
  MAIN_FILE,
  proyectoSinPlaca,
} from './project.js';

describe('isValidProjectName', () => {
  it('acepta nombres válidos', () => {
    for (const n of ['a', 'alarma', 'alarma-demo', 'demo-1', 'x'.repeat(40)]) {
      expect(isValidProjectName(n), n).toBe(true);
    }
  });

  it('rechaza traversal, separadores y nombres inválidos', () => {
    for (const n of [
      '..',
      '../escape',
      'a/b',
      'a\\b',
      'ALARMA',
      'alarma demo',
      'x'.repeat(41),
      '',
      '-inicial',
      'alarma..demo',
      'sesión',
    ]) {
      expect(isValidProjectName(n), n).toBe(false);
    }
  });
});

describe('ProjectSchema', () => {
  it('parsea el proyecto de ejemplo de la sección 6.1', () => {
    const project = {
      schemaVersion: 1,
      name: 'alarma-demo',
      board: 'esp32-s3-devkitc-1',
      language: 'esphome',
      modules: [
        { id: 'btn1', type: 'button', x: 420, y: 120, props: { label: 'Armar' } },
        { id: 'led1', type: 'led', x: 420, y: 220, props: { color: 'red' } },
        {
          id: 'door1',
          type: 'door-sensor-433',
          x: 60,
          y: 420,
          props: { code: '101100111000101001011010', protocol: 1 },
        },
      ],
      wires: [
        { from: 'btn1.OUT', to: 'board.GPIO6' },
        { from: 'led1.IN', to: 'board.GPIO7' },
      ],
      sim: { wifiSsid: 'sim-wifi', wifiPassword: 'sim-password', autoReload: true },
    };
    const parsed = ProjectSchema.parse(project);
    expect(parsed.modules).toHaveLength(3);
    expect(parsed.wires[1]).toEqual({ from: 'led1.IN', to: 'board.GPIO7' });
  });

  it('rechaza ids de placa mal formados y lenguajes no soportados', () => {
    // Las placas son datos del catálogo (module.json con bloque "board"): el esquema solo
    // chequea el formato del id; que la placa exista lo valida el registro al crear el proyecto.
    const base = defaultProject('demo', 'esphome');
    expect(ProjectSchema.safeParse({ ...base, board: 'ESP 32' }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...base, board: '../esp32' }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...base, board: 'arduino-uno' }).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, language: 'rust' }).success).toBe(false);
  });

  it('defaultProject arranca con la placa y el circuito de la plantilla (GPIO6 -> GPIO7)', () => {
    const p = defaultProject('demo', 'micropython');
    expect(p.modules.map((m) => m.id)).toEqual(['board', 'btn1', 'led1']);
    expect(p.wires).toContainEqual({ from: 'btn1.OUT', to: 'board.GPIO6' });
    expect(p.wires).toContainEqual({ from: 'led1.IN', to: 'board.GPIO7' });
    expect(p.schemaVersion).toBe(1);
    expect(ProjectSchema.parse(p)).toEqual(p);
  });
});

describe('isAllowedFileName', () => {
  it('deja pasar los archivos de código de cada lenguaje', () => {
    expect(isAllowedFileName('esphome', 'main.yaml')).toBe(true);
    expect(isAllowedFileName('esphome', 'secrets.yaml')).toBe(true);
    expect(isAllowedFileName('idf-c', 'main/main.c')).toBe(true);
    expect(isAllowedFileName('idf-c', 'CMakeLists')).toBe(true);
    expect(isAllowedFileName('idf-cpp', 'main/main.cpp')).toBe(true);
    expect(isAllowedFileName('arduino', 'sketch.cpp')).toBe(true);
    expect(isAllowedFileName('micropython', 'main.py')).toBe(true);
  });

  it('bloquea traversal, ocultos y extensiones de otro lenguaje', () => {
    expect(isAllowedFileName('esphome', '../otro/main.yaml')).toBe(false);
    expect(isAllowedFileName('esphome', '.env')).toBe(false);
    expect(isAllowedFileName('esphome', 'main.py')).toBe(false);
    expect(isAllowedFileName('micropython', 'main.yaml')).toBe(false);
    expect(isAllowedFileName('idf-c', 'sketch.cpp')).toBe(true); // idf-c acepta .cpp también
    expect(isAllowedFileName('micropython', 'main.pyc')).toBe(false);
  });
});

describe('MAIN_FILE', () => {
  it('apunta al archivo principal de cada lenguaje', () => {
    expect(MAIN_FILE.esphome).toBe('main.yaml');
    expect(MAIN_FILE['idf-c']).toBe('main/main.c');
    expect(MAIN_FILE['idf-cpp']).toBe('main/main.cpp');
    expect(MAIN_FILE.arduino).toBe('sketch.cpp');
    expect(MAIN_FILE.micropython).toBe('main.py');
  });
});

describe('sim.autoReload', () => {
  it('los proyectos anteriores al campo se leen con la recarga apagada', () => {
    const viejo = { schemaVersion: 1, name: 'v', board: 'esp32-s3-devkitc-1', language: 'micropython', modules: [], wires: [], sim: { wifiSsid: 'a', wifiPassword: 'b' } };
    expect(ProjectSchema.parse(viejo).sim.autoReload).toBe(false);
  });

  it('un proyecto nuevo con placa la trae activa; sin placa, no', () => {
    expect(defaultProject('n', 'micropython').sim.autoReload).toBe(true);
    expect(proyectoSinPlaca('n').sim.autoReload).toBe(false);
  });
});

describe('placas múltiples', () => {
  it('interpreta proyectos históricos sin escribir campos nuevos', async () => {
    const { placasDelProyecto, placaDelProyecto } = await import('./project.js');
    const project = defaultProject('legacy', 'micropython');
    expect(placasDelProyecto(project)).toEqual([{ id: 'board', board: project.board, language: 'micropython' }]);
    expect(placaDelProyecto(project)?.id).toBe('board');
    expect(placaDelProyecto(project, 'board2')).toBeUndefined();
    expect(project.boards).toBeUndefined();
    expect(placasDelProyecto(proyectoSinPlaca('circuito'))).toEqual([]);
  });

  it('preserva identidad y lenguaje independientes al guardar', async () => {
    const { placasDelProyecto, placaDelProyecto } = await import('./project.js');
    const boards = [
      { id: 'board', board: 'esp32-s3-devkitc-1', language: 'micropython' },
      { id: 'board2', board: 'arduino-uno', language: 'arduino' },
    ];
    const base = defaultProject('multi', 'micropython');
    const parsed = ProjectSchema.parse({ ...base, boards, modules: [...base.modules, { id: 'board2', type: 'arduino-uno', x: 260, y: 0, props: {} }] });
    expect(placasDelProyecto(parsed)).toEqual(boards);
    expect(placaDelProyecto(parsed, 'board2')).toEqual(boards[1]);
  });

  it('rechaza ids duplicados, traversal y lenguajes inválidos', () => {
    const base = defaultProject('multi', 'micropython');
    const board = { id: 'board', board: base.board, language: base.language };
    expect(ProjectSchema.safeParse({ ...base, boards: [board, board] }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...base, boards: [{ ...board, id: '../escape' }] }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...base, boards: [{ ...board, language: 'rust' }] }).success).toBe(false);
  });
});


describe('consistencia entre placas y dibujo', () => {
  it('rechaza quitar o cambiar el módulo de una placa declarada', () => {
    const base = defaultProject('multi', 'micropython');
    const boards = [{ id: 'board', board: base.board, language: base.language }];
    expect(ProjectSchema.safeParse({ ...base, boards }).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...base, boards, modules: base.modules.filter((module) => module.id !== 'board') }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...base, boards, modules: base.modules.map((module) => module.id === 'board' ? { ...module, type: 'arduino-uno' } : module) }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...base, boards, language: 'arduino' }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...base, boards: [] }).success).toBe(false);
  });
});
