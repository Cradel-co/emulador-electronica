import { beforeAll, describe, expect, it } from 'vitest';
import type { Project, Wire } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { descriptorDe } from '../diagramOps.js';
import { analizarCircuito } from '../sim/analisis.js';
import { precalentar } from '../sim/spice.js';
import { chipsDelProyecto } from './proyectoChips.js';

/**
 * El módulo modules/tft-st7735-128x160 (la placa roja genérica de 8 pines) en el bus SPI del Uno:
 * SCK a D13, SDA (MOSI) a D11, CS, A0 (D/CX) y RESET a pines cualquiera.
 */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);
beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

const w = (from: string, to: string): Wire => ({ from, to });
function proyecto(cables: Wire[], props: Record<string, string | number | boolean> = {}): Project {
  return {
    schemaVersion: 1, name: 't', board: 'arduino-uno', language: 'arduino', sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false },
    modules: [
      { id: 'board', type: 'arduino-uno', x: 0, y: 0, props: { usb: true } },
      { id: 'tft', type: 'tft-st7735-128x160', x: 0, y: 0, props },
    ],
    wires: cables,
  };
}
const ALIM = [w('tft.VCC', 'board.5V'), w('tft.GND', 'board.GND'), w('tft.LED', 'board.3V3')];
const SPI = [w('tft.SCK', 'board.D13'), w('tft.SDA', 'board.D11'), w('tft.CS', 'board.D10'), w('tft.A0', 'board.D9'), w('tft.RESET', 'board.D8')];

describe('módulo TFT ST7735 en el bus SPI del Uno', () => {
  it('cableado como en el ejemplo de Adafruit: SPI con CS en D10, D/CX en D9 y RESX en D8, solo escritura', () => {
    const p = proyecto([...ALIM, ...SPI], { pestana: 'verde' });
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.avisos).toEqual([]);
    expect(r.chips).toHaveLength(1);
    const c = r.chips[0]!;
    expect(c.spi).toMatchObject({ csGpio: 10, dcGpio: 9, modos: [0, 3], soloEscritura: true });
    expect(c.entradas).toEqual({ 8: 'RESX' });
    expect(c.props.pestana).toBe('verde');
    expect(c.alimentado).toBe(true);
  });

  it('sin A0 (dato/comando) no puede andar y se dice por qué', () => {
    const p = proyecto([...ALIM, ...SPI.filter((x) => x.from !== 'tft.A0')]);
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.chips).toHaveLength(0);
    expect(r.avisos.join()).toMatch(/D\/CX \(dato\/comando\) no está cableado/);
  });

  it('SCK y SDA en pines que no son del bus: se dice adónde van', () => {
    const p = proyecto([...ALIM, w('tft.SCK', 'board.D6'), w('tft.SDA', 'board.D7'), w('tft.CS', 'board.D10'), w('tft.A0', 'board.D9')]);
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.chips).toHaveLength(0);
    expect(r.avisos.join()).toMatch(/D13 y D11/);
  });

  it('RESET sin cablear está bien (Adafruit acepta rst = -1 y usa SWRESET)', () => {
    const p = proyecto([...ALIM, ...SPI.filter((x) => x.from !== 'tft.RESET')]);
    const r = chipsDelProyecto(p, b, descriptorDe(p, b));
    expect(r.avisos).toEqual([]);
    expect(r.chips[0]!.entradas).toEqual({});
  });
});

describe('módulo TFT ST7735: electricidad', () => {
  it('con 5 V el controlador toma ~6 mA por el regulador y la retroiluminación desde 3,3 V prende', async () => {
    const r = await analizarCircuito(proyecto([...ALIM, ...SPI]), b);
    const el = (n: string) => r.elementos.find((e) => e.dueno === 'tft' && e.local === n)!;
    expect(el('st7735').i).toBeGreaterThan(0.005);
    expect(el('st7735').i).toBeLessThan(0.007);
    expect(el('backlight').i).toBeGreaterThan(0.005);
    expect(r.avisos.filter((a) => a.mensaje.includes('(tft)'))).toEqual([]);
  });

  it('con LED sin conectar avisa que se va a ver oscura', async () => {
    const r = await analizarCircuito(proyecto([w('tft.VCC', 'board.5V'), w('tft.GND', 'board.GND'), ...SPI]), b);
    expect(r.avisos.filter((a) => a.mensaje.includes('(tft)')).map((a) => a.mensaje).join()).toMatch(/retroiluminación/);
  });
});
