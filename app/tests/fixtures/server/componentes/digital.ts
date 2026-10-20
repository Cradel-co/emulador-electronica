import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefinicionComponenteSchema } from '../../../../shared/src/componentes/contratos.js';
import { ROOT } from '../../../../server/src/paths.js';
import { CatalogoComponentes } from '../../../../server/src/componentes/catalogo.js';
import { PaquetesComponentes } from '../../../../server/src/componentes/paquetes.js';
import { puerto, hijo, externo, referencia } from './divisor.js';

export async function circuitoDigital() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'componentes-digital-'));
  try {
    for (const id of ['resistor', 'fuente-regulable']) await fs.cp(path.join(ROOT, 'modules', id), path.join(dir, id), { recursive: true });
    const destino = path.join(dir, 'digital-prueba'); await fs.mkdir(destino);
    const pines = ['VCC', 'GND', 'I', 'Q', 'RST'];
    await fs.writeFile(path.join(destino, 'module.json'), JSON.stringify({
      type: 'digital-prueba', name: 'Perfil resistivo de prueba', category: 'Pruebas', width: 80, height: 40,
      pins: pines.map((name, x) => ({ name, x: x * 10, y: 0, kind: 'other' })), controls: [],
      props: { nivel: { type: 'string', default: 'Z', enum: ['0', '1', 'Z'], label: 'Salida' },
        ron: { type: 'number', default: 50, min: 1, max: 1_000_000, label: 'Resistencia de salida declarada' } },
      svg: 'module.svg', model: 'model.ts',
    }));
    await fs.writeFile(path.join(destino, 'module.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await fs.copyFile(path.join(ROOT, 'app/tests/fixtures/server/componentes/modeloDigital.ts'), path.join(destino, 'model.ts'));
    const paquetes = new PaquetesComponentes({ modulos: dir, chips: path.join(ROOT, 'chips') });
    const digital = DefinicionComponenteSchema.parse({
      schemaVersion: 1, id: 'digital-prueba', version: '1.0.0', nombre: 'Digital', tipo: 'hoja-legada',
      puertos: pines.map(puerto), modulo: { id: 'digital-prueba', sha256: (await paquetes.inspeccionar('digital-prueba')).sha256 },
      parametros: { nivel: { tipo: 'texto', default: 'Z', valores: ['0', '1', 'Z'] }, ron: { tipo: 'numero', default: 50, min: 1, max: 1_000_000, unidad: 'ohm' } },
      perfilDigital: {
        alimentacion: { positivo: 'VCC', negativo: 'GND', minVoltios: 2, maxVoltios: 5.5 },
        entradas: { I: { vil: 0.3, vih: 0.7 }, RST: { vil: 0.3, vih: 0.7 } },
        salidas: { Q: { parametro: 'nivel' } }, reset: { puerto: 'RST', activo: 0 }, retardoPs: '1',
      },
    });
    const bloque = DefinicionComponenteSchema.parse({ schemaVersion: 1, id: 'bloque', version: '1.0.0', nombre: 'Bloque jerárquico', tipo: 'compuesto',
      puertos: digital.puertos, instancias: [{ id: 'chip', definicion: referencia(digital), parametros: {} }],
      conexiones: pines.map((p, i) => ({ id: `puerto-${i}`, terminales: [externo(p), hijo('chip', p)] })),
    });
    const fuente = DefinicionComponenteSchema.parse({ schemaVersion: 1, id: 'fuente', version: '1.0.0', nombre: 'Fuente', tipo: 'hoja-legada',
      puertos: [puerto('V'), puerto('GND')], modulo: { id: 'fuente-regulable', sha256: (await paquetes.inspeccionar('fuente-regulable')).sha256 },
      parametros: { voltage: { tipo: 'numero', default: 3.3, min: -12, max: 12, unidad: 'V' }, currentLimitMa: { tipo: 'numero', default: 1000, min: 1, max: 5000, unidad: 'mA' } },
    });
    const r = DefinicionComponenteSchema.parse({ schemaVersion: 1, id: 'carga', version: '1.0.0', nombre: 'Carga', tipo: 'hoja-legada',
      puertos: [puerto('1'), puerto('2')], modulo: { id: 'resistor', sha256: (await paquetes.inspeccionar('resistor')).sha256 },
      parametros: { ohms: { tipo: 'numero', default: 10000, min: 1, max: 10_000_000, unidad: 'ohm' } },
    });
    const raiz = DefinicionComponenteSchema.parse({ schemaVersion: 1, id: 'circuito-digital', version: '1.0.0', nombre: 'Dos bloques digitales', tipo: 'compuesto', puertos: [],
      instancias: [
        ...['a', 'b'].map(id => ({ id, definicion: referencia(bloque), parametros: {} })),
        ...['fuente-a', 'fuente-b', 'reset-b'].map(id => ({ id, definicion: referencia(fuente), parametros: {} })),
        { id: 'carga', definicion: referencia(r), parametros: {} },
        { id: 'pull-reset', definicion: referencia(r), parametros: {} },
      ],
      conexiones: [
        { id: 'vcc-a', terminales: [hijo('a', 'VCC'), hijo('a', 'RST'), hijo('fuente-a', 'V')] },
        { id: 'vcc-b', terminales: [hijo('b', 'VCC'), hijo('fuente-b', 'V'), hijo('pull-reset', '1')] },
        { id: 'reset-b', terminales: [hijo('b', 'RST'), hijo('reset-b', 'V'), hijo('pull-reset', '2')] },
        { id: 'senal', terminales: [hijo('a', 'Q'), hijo('b', 'I'), hijo('carga', '1')] },
        { id: 'tierra', terminales: [hijo('a', 'GND'), hijo('b', 'GND'), hijo('a', 'I'), hijo('fuente-a', 'GND'), hijo('fuente-b', 'GND'), hijo('reset-b', 'GND'), hijo('carga', '2')] },
      ],
    });
    const definiciones = [digital, bloque, fuente, r, raiz];
    return { dir, paquetes, digital, raiz, definiciones, referencia: referencia(raiz), catalogo: new CatalogoComponentes(definiciones) };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
