import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleInstance, Project, Wire } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito, type AnalisisCircuito } from './analisis.js';
import { precalentar } from './spice.js';

/**
 * El potenciómetro contra el motor real. La tensión del cursor no la calcula el modelo: declara
 * dos resistencias y la Ley de Ohm hace el resto. El número de referencia es el de
 * docs/modulos-y-su-codigo.md: con 5 V entre A y B y la posición en 25, el cursor da 3,75 V.
 */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);

beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

const SIM = { wifiSsid: 'x', wifiPassword: 'y', autoReload: false };
const w = (from: string, to: string): Wire => ({ from, to });
const mod = (id: string, type: string, props: Record<string, unknown> = {}): ModuleInstance =>
  ({ id, type, props, x: 0, y: 0 }) as ModuleInstance;

/** El potenciómetro como divisor, sin carga en el cursor. */
function divisor(voltage: number, posicion: number, ohms = 10000, powerRatedW = 0.25): Project {
  return {
    schemaVersion: 1, name: 't', board: null, language: null, sim: SIM,
    modules: [
      mod('f', 'fuente-regulable', { voltage, currentLimitMa: 1000 }),
      mod('pot1', 'potenciometro', { ohms, posicion, powerRatedW }),
    ],
    wires: [w('f.V', 'pot1.A'), w('pot1.B', 'f.GND')],
  };
}

const analizar = (p: Project): Promise<AnalisisCircuito> => analizarCircuito(p, b, {});
/**
 * Tensión del cursor respecto de B. `tensiones` solo trae los pines cableados, y en un divisor sin
 * carga W está al aire: se lee del propio tramo, que el motor declaró de W a B.
 */
const cursor = (r: AnalisisCircuito) => {
  const tramo = r.elementos.find((e) => e.id === 'pot1.tramoB')!;
  return tramo.va - tramo.vb;
};
const mA = (r: AnalisisCircuito, tramo: string) => r.elementos.find((e) => e.id === `pot1.${tramo}`)!.i * 1000;

describe('potenciómetro: el divisor', () => {
  it('el número de la doc: 5 V entre A y B, posición 25 → el cursor da 3,75 V', async () => {
    expect(cursor(await analizar(divisor(5, 25)))).toBeCloseTo(3.75, 2);
  });

  it('a la mitad, la mitad de la tensión', async () => {
    expect(cursor(await analizar(divisor(5, 50)))).toBeCloseTo(2.5, 2);
  });

  it('posición 0: el cursor queda pegado a A', async () => {
    expect(cursor(await analizar(divisor(5, 0)))).toBeCloseTo(5, 1);
  });

  it('posición 100: el cursor queda pegado a B', async () => {
    expect(cursor(await analizar(divisor(5, 100)))).toBeCloseTo(0, 1);
  });

  it('la posición se recorta: 150 se comporta como 100 y −50 como 0', async () => {
    expect(cursor(await analizar(divisor(5, 150)))).toBeCloseTo(0, 1);
    expect(cursor(await analizar(divisor(5, -50)))).toBeCloseTo(5, 1);
  });

  it('consume lo que dice la Ley de Ohm: 5 V sobre 10 kΩ son 0,5 mA por los dos tramos', async () => {
    const r = await analizar(divisor(5, 50));
    expect(mA(r, 'tramoA')).toBeCloseTo(0.5, 2);
    expect(mA(r, 'tramoB')).toBeCloseTo(0.5, 2);
  });

  it('con carga en el cursor el divisor se carga: la tensión cae del valor sin carga', async () => {
    // 10 kΩ al 50 % da 2,5 V en vacío; con 1 kΩ colgado del cursor, el tramo de abajo queda en
    // 5 kΩ ∥ 1 kΩ y la tensión se desploma. Nadie lo programa: es la Ley de Ohm.
    const conCarga: Project = {
      schemaVersion: 1, name: 't', board: null, language: null, sim: SIM,
      modules: [
        mod('f', 'fuente-regulable', { voltage: 5, currentLimitMa: 1000 }),
        mod('pot1', 'potenciometro', { ohms: 10000, posicion: 50, powerRatedW: 0.25 }),
        mod('carga', 'resistor', { ohms: 1000, powerRatedW: 0.25 }),
      ],
      wires: [w('f.V', 'pot1.A'), w('pot1.B', 'f.GND'), w('pot1.W', 'carga.1'), w('carga.2', 'f.GND')],
    };
    const v = cursor(await analizar(conCarga));
    expect(v).toBeLessThan(2.5);
    expect(v).toBeCloseTo(5 * (5000 * 1000 / 6000) / (5000 + 5000 * 1000 / 6000), 2);
  });

  it('ningún tramo llega a 0 Ω: un potenciómetro real tiene resistencia de contacto', async () => {
    // Si tramoA fuera 0 Ω, la fuente vería un corto a través de nada en la posición extrema.
    const r = await analizar(divisor(5, 0));
    expect(Math.abs(mA(r, 'tramoA'))).toBeLessThan(600);
    expect(r.resuelto).toBe(true);
  });
});

describe('potenciómetro: la potencia nominal declarada', () => {
  it('dentro de lo nominal no avisa nada', async () => {
    const r = await analizar(divisor(5, 50, 10000));
    expect(r.avisos.filter((a) => /pot1|nominal/.test(a.mensaje))).toEqual([]);
  });

  it('pasarse de la nominal es una advertencia', async () => {
    // 8 V sobre 100 Ω: cada tramo a mitad de camino disipa 0,32 W contra 0,25 W declarados.
    const r = await analizar(divisor(8, 50, 100));
    const aviso = r.avisos.find((a) => /nominal/.test(a.mensaje));
    expect(aviso?.severidad).toBe('advertencia');
  });

  it('al doble de la nominal, peligro', async () => {
    // 12 V sobre 100 Ω: 0,72 W contra 0,25 W.
    const r = await analizar(divisor(12, 50, 100));
    const aviso = r.avisos.find((a) => /nominal/.test(a.mensaje));
    expect(aviso?.severidad).toBe('peligro');
    expect(aviso?.mensaje).toMatch(/0,72 W/);
  });
});
