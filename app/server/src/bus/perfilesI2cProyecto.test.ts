import { beforeAll, describe, expect, it } from 'vitest';
import { ProjectSchema, type Project } from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from '../catalog.js';
import { descriptorDe } from '../diagramOps.js';
import { perfilI2cSintetico } from '../fixtures/perfilI2c.js';
import { chipsDelProyecto } from './proyectoChips.js';

let catalogo: ModuloCatalogo[];
beforeAll(async () => { catalogo = await loadCatalog(); });
const buscar = (tipo: string) => catalogo.find(m => m.type === tipo);

function proyecto(): Project {
  return ProjectSchema.parse({
    name: 'perfiles-i2c', language: 'arduino', board: 'arduino-uno',
    boards: ['board', 'segunda'].map(id => ({ id, board: 'arduino-uno', language: 'arduino' })),
    sim: { wifiSsid: 'x', wifiPassword: '', i2cFisico: {
      board: [{ sda: 18, scl: 19, perfil: perfilI2cSintetico }],
      segunda: [{ sda: 18, scl: 19, perfil: { ...perfilI2cSintetico, id: 'otra-placa' } }],
    } },
    modules: [
      ...['board', 'segunda'].map(id => ({ id, type: 'arduino-uno', x: 0, y: 0, props: { usb: true } })),
      ...['sensor', 'otro'].map(id => ({ id, type: 'bme280-adafruit', x: 0, y: 0, props: {} })),
    ],
    wires: [['sensor', 'board'], ['otro', 'segunda']].flatMap(([sensor, placa]) =>
      [['VIN', '5V'], ['GND', 'GND'], ['SCK', 'A5'], ['SDI', 'A4']].map(([desde, hasta]) =>
        ({ from: `${sensor}.${desde}`, to: `${placa}.${hasta}` }))),
  });
}

describe('perfiles I2C guardados por placa y cableado', () => {
  it('conserva los parámetros al serializar y selecciona cada perfil sin cruzar placas', () => {
    const p = ProjectSchema.parse(JSON.parse(JSON.stringify(proyecto())));
    for (const [id, sensor, perfilId] of [
      ['board', 'sensor', perfilI2cSintetico.id], ['segunda', 'otro', 'otra-placa'],
    ] as const) {
      const resultado = chipsDelProyecto(p, buscar, descriptorDe(p, buscar), undefined, undefined, id);
      expect(resultado.chips).toHaveLength(1);
      expect(resultado.chips[0]).toMatchObject({ id: sensor, i2cFisico: { id: perfilId } });
    }
  });

  it('no aplica un equivalente de otro par GPIO y avisa de la falta de modelo', () => {
    const p = proyecto();
    p.sim.i2cFisico = { board: [{ sda: 2, scl: 3, perfil: perfilI2cSintetico }] };
    const resultado = chipsDelProyecto(p, buscar, descriptorDe(p, buscar));
    expect(resultado.chips[0]?.i2cFisico).toBeUndefined();
    expect(resultado.avisos.join()).toContain('I2C 18/19 sin perfil eléctrico');
  });

  it('mantiene explícitamente sin perfil los proyectos anteriores', () => {
    const p = proyecto();
    delete p.sim.i2cFisico;
    const resultado = chipsDelProyecto(ProjectSchema.parse(p), buscar, descriptorDe(p, buscar));
    expect(resultado.chips[0]?.i2cFisico).toBeUndefined();
    expect(resultado.avisos).toEqual([]);
  });
});
