import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProjectSchema, type Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { PuenteAnalogicoEsp, estadoAnalogicoEspDesdeCircuito } from '../analogicoEsp.js';
import { analizarCircuito } from './analisis.js';
import { precalentar } from './spice.js';

/**
 * La plantilla "sonómetro que se lee": el SEN0232 cableado al ADC1 del S3, con su perfil de
 * conversión declarado en el propio proyecto (`sim.analogicoEsp`).
 *
 * Atraviesa el mismo puente que usa el firmware (`@ADC` → `@ADCR`), así que verifica lo que de
 * verdad va a leer el código MicroPython, incluidos los rechazos: fuera del dominio declarado el
 * puente devuelve un error en vez de inventar una cuenta.
 */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);

beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

const plantilla = (): Project => ProjectSchema.parse(JSON.parse(readFileSync(
  new URL('../../../../projects/_template/sonometro-que-se-lee/project.json', import.meta.url), 'utf8',
)));

/** Lo que el firmware recibiría al leer el canal, con el ambiente en `dbA`. */
async function leerADC(dbA: number, gpio = 4, atenuacion = 3): Promise<string> {
  const base = plantilla();
  const p: Project = { ...base, modules: base.modules.map((m) => (m.id === 'mic1' ? { ...m, props: { ...m.props, dbA } } : m)) };
  const r = await analizarCircuito(p, b, {});
  const desc = b('esp32-s3-devkitc-1')?.board;
  if (!desc) throw new Error('la placa de la plantilla no está en el catálogo');
  const perfil = p.sim.analogicoEsp?.board;
  if (!perfil) throw new Error('la plantilla no declara el perfil de ADC');
  const dicho: string[] = [];
  const puente = new PuenteAnalogicoEsp('esp32s3', perfil, (l) => dicho.push(l));
  puente.actualizar(estadoAnalogicoEspDesdeCircuito('board', desc, r));
  puente.recibir(`@ADC 1 ${gpio} ${atenuacion}`);
  const respuesta = dicho[0];
  if (respuesta === undefined) throw new Error('el puente no contestó');
  return respuesta.replace('@ADCR 1 ', '');
}

/** La conversión que hace el programa de la plantilla: cuentas → voltios → dBA. */
const dbADe = (cuentas: number, cero = 0, fondo = 3.1) => 30 + ((cero + (cuentas / 4096) * (fondo - cero)) - 0.6) / 0.02;

describe('plantilla sonometro-que-se-lee', () => {
  it('es un proyecto válido y su perfil de ADC pasa el esquema', () => {
    const p = plantilla();
    expect(p.board).toBe('esp32-s3-devkitc-1');
    expect(p.modules.map((m) => m.type)).toContain('sonometro-sen0232');
    expect(p.sim.analogicoEsp?.board?.canales).toHaveLength(1);
  });

  it('el dominio declarado cubre todo lo que el sensor puede entregar (0,6 a 2,6 V)', () => {
    const canal = plantilla().sim.analogicoEsp?.board?.canales[0];
    if (!canal) throw new Error('sin canal declarado');
    expect(canal.rangoVEntrada.min).toBeLessThanOrEqual(0.6);
    expect(canal.rangoVEntrada.max).toBeGreaterThanOrEqual(2.6);
  });

  it('el firmware lee una cuenta válida en los extremos y en el medio del rango', async () => {
    for (const dbA of [30, 80, 130]) {
      const r = await leerADC(dbA);
      expect(r, `${dbA} dBA`).toMatch(/^\d+$/);
      expect(Number(r), `${dbA} dBA`).toBeGreaterThan(0);
      expect(Number(r), `${dbA} dBA`).toBeLessThan(4096);
    }
  });

  it('la cuenta vuelve a dar el nivel de sonido: el viaje de ida y vuelta cierra', async () => {
    for (const dbA of [30, 45, 60, 80, 100, 130]) {
      const cuentas = Number(await leerADC(dbA));
      expect(dbADe(cuentas), `${dbA} dBA`).toBeCloseTo(dbA, 0);
    }
  });

  it('más ruido, más cuentas', async () => {
    const [bajo, alto] = [Number(await leerADC(40)), Number(await leerADC(120))];
    expect(alto).toBeGreaterThan(bajo);
  });

  it('un GPIO sin canal declarado no inventa una lectura', async () => {
    expect(await leerADC(80, 5)).toBe('E:SIN_MODELO_CANAL');
  });

  it('otra atenuación tampoco: el perfil declara una sola', async () => {
    expect(await leerADC(80, 4, 0)).toBe('E:SIN_MODELO_CANAL');
  });
});
