import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProjectSchema, sonidosDelCircuito, type EventoSonido, type Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { analizarCircuito } from './analisis.js';
import { precalentar } from './spice.js';

/**
 * La plantilla "volumen con potenciómetro": un potenciómetro como divisor entre la fuente y un
 * buzzer. Girar el cursor baja la tensión que le llega y la amplitud cae sola — nadie programa
 * un volumen, sale de la Ley de Ohm más la ley de −6 dB por mitad de tensión.
 *
 * Sirve de prueba de integración de todo el camino del audio: motor → modelo del módulo →
 * sonidosDelCircuito.
 */

let cat: ModuloCatalogo[] = [];
const b = (t: string) => cat.find((m) => m.type === t);

beforeAll(async () => {
  cat = await loadCatalog();
  await precalentar();
}, 60_000);

const plantilla = (): Project => ProjectSchema.parse(JSON.parse(readFileSync(
  new URL('../../../../projects/_template/volumen-con-potenciometro/project.json', import.meta.url), 'utf8',
)));

/** El circuito de la plantilla con el cursor en `posicion`. */
async function conCursor(posicion: number): Promise<{ v: number; mA: number; on: boolean | undefined; resuelto: boolean; sonido: EventoSonido }> {
  const base = plantilla();
  const p: Project = { ...base, modules: base.modules.map((m) => (m.id === 'pot1' ? { ...m, props: { ...m.props, posicion } } : m)) };
  const r = await analizarCircuito(p, b, {});
  const sonido = sonidosDelCircuito(p.modules, (t) => b(t)?.salidas, r.tensiones, (id) => r.modulos[id]?.ui)[0]!;
  return {
    v: (r.tensiones['bz1.IN'] ?? 0) - (r.tensiones['bz1.GND'] ?? 0),
    mA: (r.elementos.find((e) => e.id === 'bz1.bobina')?.i ?? 0) * 1000,
    on: r.modulos.bz1?.ui?.on,
    resuelto: r.resuelto,
    sonido,
  };
}

describe('plantilla volumen-con-potenciometro', () => {
  it('la plantilla es un proyecto válido con los tres módulos cableados', () => {
    const p = plantilla();
    expect(p.modules.map((m) => m.type).sort()).toEqual(['buzzer-activo', 'fuente-regulable', 'potenciometro']);
    expect(p.wires).toHaveLength(4);
  });

  it('arranca sonando: la posición por defecto deja el buzzer en marcha', async () => {
    const base = plantilla();
    const r = await analizarCircuito(base, b, {});
    const s = sonidosDelCircuito(base.modules, (t) => b(t)?.salidas, r.tensiones, (id) => r.modulos[id]?.ui)[0]!;
    expect(s.sonando).toBe(true);
  });

  it('girar el cursor baja el volumen: la amplitud sigue a la tensión', async () => {
    const [a, b2, c] = [await conCursor(0), await conCursor(20), await conCursor(40)];
    expect([a.sonido.sonando, b2.sonido.sonando, c.sonido.sonando]).toEqual([true, true, true]);
    // Monótono: más posición, menos tensión, menos amplitud y menos consumo.
    expect(a.v).toBeGreaterThan(b2.v);
    expect(b2.v).toBeGreaterThan(c.v);
    expect(a.sonido.ganancia).toBeGreaterThan(b2.sonido.ganancia);
    expect(b2.sonido.ganancia).toBeGreaterThan(c.sonido.ganancia);
    expect(a.mA).toBeGreaterThan(c.mA);
    // Y los dB bajan de verdad: del extremo a mitad de carrera se pierden unos 6 dB.
    expect(a.sonido.dbA! - c.sonido.dbA!).toBeGreaterThan(4);
  });

  it('pasada la mitad el oscilador no arranca y se calla', async () => {
    for (const pos of [50, 70, 100]) {
      const r = await conCursor(pos);
      expect(r.resuelto, `posición ${pos}`).toBe(true);
      expect(r.sonido.sonando, `posición ${pos}`).toBe(false);
      expect(Math.abs(r.mA), `posición ${pos}`).toBeLessThan(0.1);
    }
  });

  /**
   * La regresión que originó esta prueba: el umbral estaba declarado en dos lados —el
   * `interruptorControlado` del modelo (con histéresis) y el `umbralV` de `salidas`— y podían
   * discrepar. A 2,44 V el modelo conducía y el sonido decía silencio; a 2,50 V al revés.
   */
  it('el dibujo y el sonido nunca se contradicen, en ninguna posición', async () => {
    for (const pos of [0, 10, 20, 30, 40, 42, 44, 50, 60, 80, 100]) {
      const r = await conCursor(pos);
      if (!r.resuelto) continue;
      expect(r.sonido.sonando, `posición ${pos}: ui.on=${r.on} vs sonando=${r.sonido.sonando}`).toBe(r.on === true);
    }
  });
});
