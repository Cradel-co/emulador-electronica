import { beforeAll, describe, expect, it } from 'vitest';
import { ModuleDefSchema, PruebaModuloSchema } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../../../../server/src/catalog.js';
import { compilarFuente } from '../../../../server/src/fuenteSandbox.js';
import { correrPrueba, probarModulo } from '../../../../server/src/sim/pruebasModulo.js';
import { precalentar } from '../../../../server/src/sim/spice.js';

const def: ModuloCatalogo = {
  ...ModuleDefSchema.parse({
    type: 'modelo-fallido', name: 'Modelo fallido', category: 'Pruebas', svg: 'module.svg',
    model: 'model.ts', width: 40, height: 40,
    pins: [{ name: 'VCC', x: 10, y: 40, kind: 'power' }, { name: 'GND', x: 30, y: 40, kind: 'ground' }],
  }),
  builtin: false,
  modeloCodigo: compilarFuente(`import type { ModeloModulo } from '@emu/shared';
export default {
  circuito(ctx) { ctx.resistencia(ctx.pin('VCC'), ctx.pin('GND'), 1000, 'r'); },
  observar() { throw new Error('fallo deliberado al observar'); },
} satisfies ModeloModulo;`, 'model.ts'),
};
let catalogo: ModuloCatalogo[];
const buscar = (tipo: string) => tipo === def.type ? def : catalogo.find(m => m.type === tipo);

beforeAll(async () => {
  catalogo = await loadCatalog();
  await precalentar();
});

describe('banco de pruebas con una simulación fallida', () => {
  it('rechaza la prueba de humo aunque no declare mediciones esperadas', async () => {
    const informe = await probarModulo(def, buscar);
    expect(informe.ok).toBe(false);
    expect(informe.pruebas).toHaveLength(1);
    expect(informe.pruebas[0]).toMatchObject({ ok: false });
    expect(informe.pruebas[0]?.fallas.join(' ')).toContain('fallo deliberado al observar');
    expect(informe.pruebas[0]?.medido.avisos).toContain('No se pudo resolver el circuito eléctrico');
  });

  it.each([false, true])('rechaza un caso irresuelto sin depender de sinAvisos=%s', async sinAvisos => {
    const prueba = PruebaModuloSchema.parse({
      nombre: 'alimentación nominal', banco: { VCC: { fuente: 5 }, GND: 'tierra' }, espera: { sinAvisos },
    });
    const resultado = await correrPrueba(def, prueba, buscar);
    expect(resultado.ok).toBe(false);
    expect(resultado.fallas.join(' ')).toContain('No se pudo resolver el circuito eléctrico');
    expect(resultado.medido.avisos).toContain('fallo deliberado al observar');
  });
});
