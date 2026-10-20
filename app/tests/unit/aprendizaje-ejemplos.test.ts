import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ejemploPorId, ejemplosCircuito, prediccionCircuito } from '../../web/aprendizaje/ejemplos.js';

describe('predicciones didácticas de los circuitos', () => {
  it('cada esquema usa los mismos valores y conexiones que su copia del emulador', () => {
    for (const ejemplo of ejemplosCircuito) {
      const project = JSON.parse(readFileSync(new URL(`../../../projects/_learning/${ejemplo.id}/project.json`, import.meta.url), 'utf8'));
      const props = (id: string) => project.modules.find((module: { id: string }) => module.id === id)?.props;
      expect(props('fuente1').voltage).toBe(ejemplo.tension);
      expect(props('r1').ohms).toBe(ejemplo.r1);
      if ('r2' in ejemplo) expect(props('r2').ohms).toBe(ejemplo.r2);
      if ('r3' in ejemplo) expect(props('r3').ohms).toBe(ejemplo.r3);
      if ('ramaAbierta' in ejemplo) expect(project.wires.some((wire: { from: string; to: string }) => wire.from === 'r2.1' || wire.to === 'r2.1')).toBe(false);
      if (ejemplo.id === 'divisor-sin-carga') expect(props('r3')).toBeUndefined();
    }
  });

  it('resuelve las variantes y conserva corriente y potencia antes de redondear', () => {
    const caso = (id: string) => { const ejemplo = ejemploPorId(id); if (!ejemplo) throw new Error(id); return prediccionCircuito(ejemplo); };
    expect(caso('ohm-2k').iFuente).toBe(.0025);
    expect(caso('serie-desigual').caidas).toEqual([5 / 3, 10 / 3]);
    expect(caso('paralelo-rama-abierta').corrientes).toEqual([.005, 0]);
    expect(caso('divisor-sin-carga').caidas).toEqual([2.5, 2.5]);
    for (const ejemplo of ejemplosCircuito) {
      const p = prediccionCircuito(ejemplo);
      expect(p.potenciaFuente + p.potencias.reduce((suma, potencia) => suma + potencia, 0)).toBeCloseTo(0, 12);
    }
  });
});
