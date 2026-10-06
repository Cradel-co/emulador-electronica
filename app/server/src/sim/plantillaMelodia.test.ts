import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProjectSchema, sonidosDelCircuito, type Project, type PwmDeclarado } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { gpioDe, conPlaca } from '../diagramOps.js';
import { diffDiagramVsCode, scanPins } from '../pinScan.js';
import { analizarCircuito } from './analisis.js';
import { precalentar } from './spice.js';

/**
 * La plantilla "melodía con buzzer pasivo". Verifica el tramo que une las dos mitades del caso B:
 * el PWM llega indexado por GPIO de la placa, y el sonido lo pide por pin del módulo, así que
 * alguien tiene que resolver el cableado. Eso es lo que hace `gpioDe` en index.ts.
 */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);

beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

const plantilla = (): Project => ProjectSchema.parse(JSON.parse(readFileSync(
  new URL('../../../../projects/_template/melodia-con-buzzer-pasivo/project.json', import.meta.url), 'utf8',
)));

/** El sonido del buzzer con el PWM que el firmware declaró sobre esos GPIO. */
async function sonar(porGpio: ReadonlyMap<number, PwmDeclarado>) {
  const p = plantilla();
  const r = await analizarCircuito(p, b, { nivelesReales: true });
  const pwmDe = (id: string, pin: string) => {
    const gpio = gpioDe(p, id, pin, b);
    return gpio === null ? undefined : porGpio.get(gpio);
  };
  return sonidosDelCircuito(p.modules, (t) => b(t)?.salidas, r.tensiones, (id) => r.modulos[id]?.ui, pwmDe)[0];
}

describe('plantilla melodia-con-buzzer-pasivo', () => {
  /**
   * El escáner de pines mira el código para saber qué GPIO usa. El programa de la plantilla pone
   * el pin en una constante (`GPIO_BUZZER = 5`) y lo pasa por `PWM(Pin(...))`: eso avisaba "hay un
   * módulo cableado al pin GPIO5 que el código no usa", siendo que sí lo usa.
   */
  it('el código de la plantilla declara el GPIO que tiene cableado, sin avisos falsos', () => {
    const codigo = readFileSync(new URL('../../../../projects/_template/melodia-con-buzzer-pasivo/main.py', import.meta.url), 'utf8');
    const p = plantilla();
    const desc = b(p.board ?? '')?.board;
    expect(scanPins('micropython', codigo, desc)).toEqual([5]);
    const avisos = diffDiagramVsCode(conPlaca(p), scanPins('micropython', codigo, desc), desc);
    expect(avisos.filter((a) => a.kind === 'module-pin-unused' || a.kind === 'code-pin-unwired')).toEqual([]);
  });

  it('es un proyecto válido con el piezo cableado a un GPIO', () => {
    const p = plantilla();
    expect(p.modules.map((m) => m.type)).toContain('buzzer-pasivo');
    expect(gpioDe(p, 'bz1', 'IN', b)).toBe(5);
  });

  it('parado no suena: sin programa no hay PWM declarado', async () => {
    expect(await sonar(new Map())).toMatchObject({ sonando: false, ganancia: 0 });
  });

  it('el PWM del GPIO cableado es el que lo hace sonar', async () => {
    const s = await sonar(new Map([[5, { hz: 440, duty: 0.5 }]]));
    expect(s).toMatchObject({ modulo: 'bz1', sonando: true, hz: 440 });
  });

  it('un PWM en otro GPIO no lo hace sonar', async () => {
    expect((await sonar(new Map([[6, { hz: 440, duty: 0.5 }]])))?.sonando).toBe(false);
  });

  it('cada nota de la escala suena a su frecuencia', async () => {
    for (const hz of [262, 330, 392, 523]) {
      const s = await sonar(new Map([[5, { hz, duty: 0.5 }]]));
      expect(s?.hz, `${hz} Hz`).toBe(hz);
      expect(s?.sonando, `${hz} Hz`).toBe(true);
    }
  });

  it('duty 0 es el silencio entre notas', async () => {
    expect((await sonar(new Map([[5, { hz: 440, duty: 0 }]])))?.sonando).toBe(false);
  });

  it('bajar el duty baja el volumen sin tocar la nota', async () => {
    const medio = await sonar(new Map([[5, { hz: 440, duty: 0.5 }]]));
    const cuarto = await sonar(new Map([[5, { hz: 440, duty: 0.25 }]]));
    expect(cuarto?.hz).toBe(medio?.hz);
    expect(cuarto?.ganancia).toBeLessThan(medio!.ganancia);
    expect(medio!.dbA! - cuarto!.dbA!).toBeCloseTo(3, 1);
  });
});
