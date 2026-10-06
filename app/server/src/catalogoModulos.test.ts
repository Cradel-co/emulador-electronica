import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PATHS } from './paths.js';
import { loadCatalog, type ModuloCatalogo } from './catalog.js';
import { modeloDe } from './sim/modelos.js';

/**
 * Invariantes de TODO el catálogo. Cada una está acá porque se rompió de verdad en un módulo y
 * costó encontrarla: ver docs/agregar-un-modulo.md, que explica el error que originó cada regla.
 *
 * La idea es que un módulo nuevo que se olvide de una de estas cosas ponga un test en rojo, en vez
 * de fallar callado en la app.
 */

let cat: ModuloCatalogo[] = [];
beforeAll(async () => { cat = await loadCatalog(); }, 60_000);

/** Props con sus valores por defecto, como los ve el modelo. */
const propsPorDefecto = (m: ModuloCatalogo): Record<string, string | number | boolean> => {
  const p: Record<string, string | number | boolean> = {};
  for (const [k, d] of Object.entries(m.props ?? {})) if (d.default !== undefined) p[k] = d.default;
  return p;
};

describe('catálogo de módulos: ninguno queda afuera en silencio', () => {
  it('cada carpeta de modules/ con module.json entra al catálogo', () => {
    const carpetas = readdirSync(PATHS.modules)
      .filter((d) => statSync(path.join(PATHS.modules, d)).isDirectory())
      .filter((d) => existsSync(path.join(PATHS.modules, d, 'module.json')));
    expect(cat.map((m) => m.type).sort()).toEqual(carpetas.sort());
  });

  it('el type coincide con el nombre de la carpeta', () => {
    for (const m of cat) expect(existsSync(path.join(PATHS.modules, m.type, 'module.json')), m.type).toBe(true);
  });
});

describe('catálogo de módulos: el modelo eléctrico carga y corre', () => {
  it('el archivo declarado en `model` existe', () => {
    for (const m of cat) {
      if (!m.model) continue;
      expect(m.modeloCodigo, `${m.type}: declara model "${m.model}" pero no se pudo leer`).toBeDefined();
    }
  });

  /**
   * Un modelo que tira en `circuito()` deja al módulo fuera del circuito con un aviso en la
   * consola del server: en la app se ve como un componente que "no hace nada".
   */
  it('`circuito()` corre con las props por defecto, sin tirar', () => {
    for (const m of cat) {
      if (!m.modeloCodigo) continue;
      const modelo = modeloDe(m);
      const entrada = {
        pines: m.pins.map((p) => p.name),
        props: propsPorDefecto(m),
        control: false,
        estado: {},
        vars: {} as Record<string, string>,
      };
      expect(() => modelo.circuito(entrada), `${m.type}: circuito() tiró`).not.toThrow();
    }
  });

  /**
   * Un modelo que nunca declara nada no participa del cálculo y en la app se ve como un
   * componente que "no hace nada". Se prueban los dos estados del control porque hay módulos que
   * legítimamente no declaran nada en uno: una fuente apagada no entrega nada.
   */
  it('declara algún elemento en alguno de los dos estados del control', () => {
    for (const m of cat) {
      if (!m.modeloCodigo) continue;
      const modelo = modeloDe(m);
      const conControl = (control: boolean) => modelo.circuito({
        pines: m.pins.map((p) => p.name), props: propsPorDefecto(m), control, estado: {}, vars: {},
      }).length;
      expect(conControl(false) + conControl(true), `${m.type}: circuito() nunca declara un elemento`).toBeGreaterThan(0);
    }
  });
});

describe('catálogo de módulos: las referencias apuntan a algo que existe', () => {
  const pines = (m: ModuloCatalogo) => new Set(m.pins.map((p) => p.name));

  it('`bridge.pin` es un pin del módulo', () => {
    for (const m of cat) {
      if (!m.bridge || m.bridge.pin === '-') continue;
      expect(pines(m).has(m.bridge.pin), `${m.type}: bridge.pin "${m.bridge.pin}" no existe`).toBe(true);
    }
  });

  it('`ohmsProp` y `source.voltageProp` son props del módulo', () => {
    for (const m of cat) {
      const props = new Set(Object.keys(m.props ?? {}));
      if (m.ohmsProp) expect(props.has(m.ohmsProp), `${m.type}: ohmsProp "${m.ohmsProp}"`).toBe(true);
      if (m.source) expect(props.has(m.source.voltageProp), `${m.type}: source.voltageProp`).toBe(true);
      if (m.source?.currentProp) expect(props.has(m.source.currentProp), `${m.type}: source.currentProp`).toBe(true);
    }
  });

  it('`vars` apunta a props que existen', () => {
    for (const m of cat) {
      const props = new Set(Object.keys(m.props ?? {}));
      for (const [k, v] of Object.entries(m.vars ?? {})) {
        expect(props.has(v.prop), `${m.type}: vars.${k} apunta a la prop "${v.prop}", que no existe`).toBe(true);
      }
    }
  });

  /** El mapeo va `pin del módulo` → `pin del chip`: las claves son del módulo. */
  it('`chips[].pines` parte de pines que el módulo tiene', () => {
    for (const m of cat) {
      for (const uso of m.chips ?? []) {
        for (const pin of Object.keys(uso.pines)) {
          expect(pines(m).has(pin), `${m.type}: el chip ${uso.id} parte del pin "${pin}", que el módulo no tiene`).toBe(true);
        }
      }
    }
  });
});

describe('catálogo de módulos: las salidas de sonido son coherentes', () => {
  it('`pins` de la salida son pines del módulo', () => {
    for (const m of cat) {
      const pines = new Set(m.pins.map((p) => p.name));
      for (const s of m.salidas ?? []) {
        for (const pin of s.pins) expect(pines.has(pin), `${m.type}: la salida usa el pin "${pin}"`).toBe(true);
      }
    }
  });

  /** Con el oscilador adentro, la frecuencia es un dato de la hoja de datos: sin `hz` no suena. */
  it('`fuente: "nivel"` declara su frecuencia', () => {
    for (const m of cat) {
      for (const s of m.salidas ?? []) {
        if (s.fuente !== 'nivel') continue;
        expect(s.hz, `${m.type}: fuente "nivel" sin hz no puede sonar`).toBeGreaterThan(0);
      }
    }
  });

  /** Con PWM la frecuencia la pone el firmware: declararla acá sería una mentira que no se usa. */
  it('`fuente: "pwm"` NO declara frecuencia', () => {
    for (const m of cat) {
      for (const s of m.salidas ?? []) {
        if (s.fuente !== 'pwm') continue;
        expect(s.hz, `${m.type}: fuente "pwm" no debe declarar hz: lo pone el programa`).toBeUndefined();
      }
    }
  });

  /** Sin la tensión y la distancia a las que se midió, un dBA solo no dice nada. */
  it('`dbA` viene con su `referencia`', () => {
    for (const m of cat) {
      for (const s of m.salidas ?? []) {
        if (s.dbA === undefined) continue;
        expect(s.referencia, `${m.type}: declara dbA sin referencia (tensión y distancia)`).toBeDefined();
      }
    }
  });
});
