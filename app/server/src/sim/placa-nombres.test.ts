import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { ModuleDefSchema } from '@emu/shared';
import { Netlist } from './netlist.js';
import { armarPlaca } from './placa.js';

it('placas con IDs válidos no colisionan entre consumo de chip y consumo del regulador', async () => {
  const module = JSON.parse(await readFile(new URL('../../../../modules/arduino-uno/module.json', import.meta.url), 'utf8'));
  module.board.power.regulators.logic3v3.quiescentCurrentMa = 5;
  const desc = ModuleDefSchema.parse(module).board!;
  const n = new Netlist('nombres multiplaca');
  for (const [index, id] of ['a-ldo-q', 'chip-a'].entries()) {
    expect(id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
    armarPlaca(n, { id, desc, usb: true, chipEncendido: true, vinCableado: false,
      rieles: { n5v: `v5_${index}`, n3v3: `v33_${index}`, nvin: `vin_${index}` },
      gpios: new Map(), salidas: new Map(), pullups: new Set() });
  }
  const names = n.texto().split('\n').filter(line => /^[brvdi]\S+\s/i.test(line)).map(line => line.split(/\s/)[0]!.toLowerCase());
  expect(names.length).toBe(new Set(names).size);
});
