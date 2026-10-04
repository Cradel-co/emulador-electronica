import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ModuleDefSchema, type BoardDescriptor } from '@emu/shared';
import { Netlist } from './netlist.js';
import { armarPlaca } from './placa.js';
import { correrSpice } from './spice.js';

const unoUrl = new URL('../../../../modules/arduino-uno/module.json', import.meta.url);

async function descriptorUno(): Promise<BoardDescriptor> {
  const module = ModuleDefSchema.parse(JSON.parse(await readFile(unoUrl, 'utf8')));
  if (!module.board) throw new Error('El catálogo debe incluir el descriptor del Uno.');
  return module.board;
}

function montar(desc: BoardDescriptor, openDrain = new Set<number>(), nivel: 0 | 1 = 1): Netlist {
  const netlist = new Netlist('prueba del descriptor');
  armarPlaca(netlist, {
    desc, usb: true, chipEncendido: true,
    rieles: { n5v: 'v5', n3v3: 'v33', nvin: 'vin' },
    gpios: new Map([[7, 'pin7']]), salidas: new Map([[7, nivel]]),
    pullups: new Set(), openDrain,
  });
  return netlist;
}

describe('parámetros eléctricos específicos de placa', () => {
  it('el Uno limita 3V3 a los 50 mA del fabricante, no a 600 mA genéricos', async () => {
    const desc = await descriptorUno();
    expect(desc.power?.regulators?.logic3v3?.currentLimitMa).toBe(50);
    const text = montar(desc).texto();
    expect(text).toMatch(/ireg_board_ldo_lim 0 reg_board_ldo_q DC 0\.05\b/);
    expect(text).not.toMatch(/ireg_board_ldo_lim 0 reg_board_ldo_q DC 0\.6\b/);
  });

  it('usa tensión, dropout y límite configurados sin trasladar números de otra placa', async () => {
    const base = await descriptorUno();
    const desc: BoardDescriptor = {
      ...base,
      power: {
        ...base.power!,
        usb: { voltage: 4.8, currentLimitMa: 250 },
        regulators: { logic3v3: { voltage: 3.1, dropoutV: 0.4, currentLimitMa: 75 } },
      },
    };
    const text = montar(desc).texto();
    expect(text).toMatch(/vref_board_usb_\d+ r_board_usb_\d+ 0 DC 4\.8/);
    expect(text).toMatch(/ilim_board_usb_\d+ 0 q_board_usb_\d+ DC 0\.25/);
    expect(text).toContain('V=max(0,min(3.1,V(v5,0)-0.4))');
    expect(text).toContain('ireg_board_ldo_lim 0 reg_board_ldo_q DC 0.075');
  });

  it('conserva el descriptor antiguo cuando no declara reguladores ni fuente USB', async () => {
    const base = await descriptorUno();
    const desc = { ...base, power: { inputs: base.power!.inputs, currentMa: base.power!.currentMa } };
    const text = montar(desc).texto();
    expect(text).toContain('V=max(0,min(3.3,V(v5,0)-0.3))');
    expect(text).toContain('ireg_board_ldo_lim 0 reg_board_ldo_q DC 0.6');
  });

  it('rechaza un límite de corriente nulo en el descriptor', async () => {
    const module = JSON.parse(await readFile(unoUrl, 'utf8'));
    module.board.power.regulators.logic3v3.currentLimitMa = 0;
    expect(ModuleDefSchema.safeParse(module).success).toBe(false);
  });

  it('un umbral de brownout explícito conserva su valor y cambia el consumo del chip', async () => {
    const base = await descriptorUno();
    const desc: BoardDescriptor = { ...base, power: { ...base.power!, brownoutVoltage: 4.3 } };
    expect(montar(desc).texto()).toContain('V(xchip_board,0)/4.3');
  });
});

describe('salida open-drain', () => {
  it('un nivel alto libera el nodo pero conserva los diodos de protección', async () => {
    const n = montar(await descriptorUno(), new Set([7]), 1);
    expect(n.elementos.some(e => e.local === 'gpio7')).toBe(false);
    expect(n.elementos.filter(e => /^prot_/.test(e.local))).toHaveLength(2);
  });

  it('un nivel bajo hunde corriente, y una salida push-pull alta sigue entregando', async () => {
    const desc = await descriptorUno();
    const low = montar(desc, new Set([7]), 0).elementos.find(e => e.local === 'gpio7');
    expect(low).toMatchObject({ a: 'pin7', b: '0', ohms: 25 });
    const high = montar(desc).elementos.find(e => e.local === 'gpio7');
    expect(high).toMatchObject({ a: 'v5', b: 'pin7', ohms: 25 });
  });
});

describe('respuesta eléctrica del descriptor y drenador abierto', () => {
  it('una carga de 33 Ω en 3V3 del Uno entrega como máximo 50 mA y cae a ~1,65 V', async () => {
    const n = montar(await descriptorUno());
    n.agregar('carga', { tipo: 'R', nombre: 'r', a: 'v33', b: '0', ohms: 33 });
    const result = n.resolver(await correrSpice(n.texto()));
    const carga = result.find(e => e.id === 'carga.r');
    expect(carga?.i).toBeCloseTo(0.05, 4);
    expect(carga?.va).toBeCloseTo(1.65, 2);
  });

  it('open-drain liberado toma el alto del pull externo y bajo conduce según Ohm', async () => {
    const desc = await descriptorUno();
    for (const nivel of [1, 0] as const) {
      const n = montar(desc, new Set([7]), nivel);
      n.agregar('pull', { tipo: 'R', nombre: 'r', a: 'v33', b: 'pin7', ohms: 1000 });
      const result = n.resolver(await correrSpice(n.texto()));
      const pull = result.find(e => e.id === 'pull.r');
      expect(pull).toBeDefined();
      if (nivel === 1) {
        expect(pull?.vb).toBeCloseTo(3.3, 2);
        expect(Math.abs(pull?.i ?? Infinity)).toBeLessThan(1e-6);
      } else {
        expect(pull?.i).toBeCloseTo(3.3 / 1025, 4);
        expect(pull?.vb).toBeCloseTo(3.3 * 25 / 1025, 2);
      }
    }
  });
});
