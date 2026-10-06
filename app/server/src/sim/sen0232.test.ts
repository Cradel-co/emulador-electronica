import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleInstance, Project, Wire } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { estadoAnalogicoEspDesdeCircuito, type EstadoAnalogicoEsp } from '../analogicoEsp.js';
import { analizarCircuito, type AnalisisCircuito } from './analisis.js';
import { precalentar } from './spice.js';

/**
 * Sonómetro SEN0232 (DFRobot). Los números son los de su hoja de datos: 30–130 dBA en 0,6–2,6 V
 * lineales, alimentación 3,3–5 V, 14 mA a 5 V y 22 mA a 3,3 V.
 *
 * Es un micrófono, así que no suena: la app no sintetiza nada con él. Lo que entrega es una
 * tensión que el ADC del ESP32 lee, y de ahí sale el camino del #54.
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

/** El sonómetro alimentado por la fuente de laboratorio, con su salida al aire. */
function conFuente(dbA: number, voltage = 5, consumoMa = 14): Project {
  return {
    schemaVersion: 1, name: 't', board: null, language: null, sim: SIM,
    modules: [
      mod('f', 'fuente-regulable', { voltage, currentLimitMa: 1000 }),
      mod('mic1', 'sonometro-sen0232', { dbA, consumoMa }),
    ],
    wires: [w('f.V', 'mic1.VCC'), w('mic1.GND', 'f.GND')],
  };
}

const analizar = (p: Project): Promise<AnalisisCircuito> => analizarCircuito(p, b, {});
/** Tensión de salida respecto de su GND, leída del propio elemento que la entrega. */
const salida = (r: AnalisisCircuito) => {
  const e = r.elementos.find((x) => x.id === 'mic1.salida')!;
  return e.vb - r.tensiones['mic1.GND']!;
};

describe('SEN0232: la curva de la hoja de datos', () => {
  it('30 dBA, el mínimo del rango, dan 0,6 V', async () => {
    expect(salida(await analizar(conFuente(30)))).toBeCloseTo(0.6, 2);
  });

  it('130 dBA, el máximo, dan 2,6 V', async () => {
    expect(salida(await analizar(conFuente(130)))).toBeCloseTo(2.6, 2);
  });

  it('es lineal: 80 dBA caen justo en el medio, 1,6 V', async () => {
    expect(salida(await analizar(conFuente(80)))).toBeCloseTo(1.6, 2);
  });

  it('20 mV por decibel', async () => {
    const a = salida(await analizar(conFuente(60)));
    const c = salida(await analizar(conFuente(61)));
    expect(c - a).toBeCloseTo(0.02, 3);
  });

  it('fuera de rango se recorta: el sonómetro no mide menos de 30 ni más de 130 dBA', async () => {
    expect(salida(await analizar(conFuente(10)))).toBeCloseTo(0.6, 2);
    expect(salida(await analizar(conFuente(200)))).toBeCloseTo(2.6, 2);
  });
});

describe('SEN0232: alimentación', () => {
  it('consume de su VCC lo declarado, no de la nada', async () => {
    const r = await analizar(conFuente(80, 5, 14));
    const fuente = r.fuentes[0];
    if (!fuente || typeof fuente.mA !== 'number') throw new Error('la fuente no informó corriente');
    const deLaFuente = Math.abs(fuente.mA);
    expect(deLaFuente).toBeGreaterThan(13);
    expect(deLaFuente).toBeLessThan(16);
  });

  it('a 3,3 V todavía alcanza para los 2,6 V de fondo de escala', async () => {
    expect(salida(await analizar(conFuente(130, 3.3, 22)))).toBeCloseTo(2.6, 2);
  });

  it('por debajo de su mínimo no puede entregar el fondo de escala', async () => {
    // Con 2,5 V de alimentación no hay margen para 2,6 V de salida: entrega menos.
    expect(salida(await analizar(conFuente(130, 2.5)))).toBeLessThan(2.6);
  });
});

describe('SEN0232: el ADC del ESP32 lo lee', () => {
  /** El sonómetro cableado a un GPIO con ADC1 del S3 (1..10). */
  function conPlaca(dbA: number): Project {
    return {
      schemaVersion: 1, name: 't', board: 'esp32-s3-devkitc-1', language: 'micropython', sim: SIM,
      modules: [
        mod('board', 'esp32-s3-devkitc-1', { usb: true }),
        mod('mic1', 'sonometro-sen0232', { dbA, consumoMa: 14 }),
      ],
      wires: [w('board.3V3', 'mic1.VCC'), w('mic1.GND', 'board.GND'), w('mic1.OUT', 'board.GPIO4')],
    };
  }

  /** Un canal sin resolver vale null: eso es un fallo del caso, no algo que el test deba tapar. */
  const canal = (e: EstadoAnalogicoEsp, gpio: number): number => {
    const v = e.canales[gpio];
    if (typeof v !== 'number') throw new Error(`el canal ${gpio} no quedó resuelto (${String(v)})`);
    return v;
  };

  it('la tensión del sonómetro llega al canal del ADC', async () => {
    const r = await analizar(conPlaca(80));
    const desc = b('esp32-s3-devkitc-1')!.board!;
    const estado = estadoAnalogicoEspDesdeCircuito('board', desc, r);
    expect(estado.resuelto).toBe(true);
    expect(canal(estado, 4)).toBeCloseTo(1.6, 1);
  });

  it('subir el nivel de sonido sube lo que lee el ADC', async () => {
    const desc = b('esp32-s3-devkitc-1')!.board!;
    const bajo = estadoAnalogicoEspDesdeCircuito('board', desc, await analizar(conPlaca(40)));
    const alto = estadoAnalogicoEspDesdeCircuito('board', desc, await analizar(conPlaca(120)));
    expect(canal(alto, 4)).toBeGreaterThan(canal(bajo, 4));
    expect(canal(alto, 4) - canal(bajo, 4)).toBeCloseTo(1.6, 1);
  });
});
