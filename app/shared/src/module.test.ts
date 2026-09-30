import { describe, expect, it } from 'vitest';
import { ModuleDefSchema, parseBoardRef, parseModuleRef } from './module.js';

describe('parseModuleRef', () => {
  it('parte "btn1.OUT" en módulo y pin', () => {
    expect(parseModuleRef('btn1.OUT')).toEqual({ moduleId: 'btn1', pin: 'OUT' });
  });
  it('devuelve null si falta alguna parte', () => {
    expect(parseModuleRef('btn1')).toBeNull();
    expect(parseModuleRef('.OUT')).toBeNull();
    expect(parseModuleRef('btn1.')).toBeNull();
  });
});

describe('parseBoardRef', () => {
  it('parte "board.GPIO6"', () => {
    expect(parseBoardRef('board.GPIO6')).toEqual({ moduleId: null, pin: 'GPIO6' });
    expect(parseBoardRef('btn1.OUT')).toBeNull();
    expect(parseBoardRef('board.')).toBeNull();
  });
});

describe('ModuleDefSchema', () => {
  const base = {
    type: 'button',
    name: 'Pulsador',
    category: 'entrada',
    svg: 'button.svg',
    pins: [{ name: 'OUT', x: 10, y: 40, kind: 'digital-out' }],
    bridge: { role: 'input', pin: 'OUT', activeLevel: 0, pull: 'up' },
    controls: [{ kind: 'momentary', label: 'Apretar' }],
    props: { label: { type: 'string', default: 'Botón' } },
  };

  it('acepta la definición de la sección 6.2', () => {
    const def = ModuleDefSchema.parse(base);
    expect(def.bridge?.role).toBe('input');
    expect(def.controls[0]?.kind).toBe('momentary');
  });

  it('rechaza roles de puente desconocidos', () => {
    const bad = { ...base, bridge: { role: 'analog-in', pin: 'OUT' } };
    expect(ModuleDefSchema.safeParse(bad).success).toBe(false);
  });

  it('rechaza props con tipos desconocidos', () => {
    const bad = { ...base, props: { x: { type: 'date' } } };
    expect(ModuleDefSchema.safeParse(bad).success).toBe(false);
  });
});
