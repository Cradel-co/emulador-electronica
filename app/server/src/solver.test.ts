import { describe, expect, it } from 'vitest';
import { solveMNA, type Circuit, type Solution } from './solver.js';

function ground(): Circuit['nodes'][0] {
  return { id: 'gnd', voltage: 0, kind: 'ground' };
}

function voltageSource(id: string, voltage: number): Circuit['nodes'][0] {
  return { id, voltage, kind: 'voltage_source', params: { voltage } };
}

function resistor(id: string, ohms: number, a: string, b: string): Circuit['branches'][0] {
  return { id, kind: 'resistor', ohms, nodes: [a, b] };
}

function diode(id: string, a: string, b: string, vf: number, rs = 0): Circuit['branches'][0] {
  return { id, kind: 'diode', vf, rs, nodes: [a, b] };
}

function node(id: string): Circuit['nodes'][0] {
  return { id, voltage: 0, kind: 'passive' };
}

/** Corriente de una rama; falla claro si el solver no la devolvió. */
function corriente(sol: Solution, id: string): number {
  const i = sol.branchCurrents[id];
  if (i === undefined) throw new Error(`El solver no devolvió corriente para la rama "${id}"`);
  return i;
}

describe('solver MNA – Test 1: pin pasivo (resistor a GND)', () => {
  it('resistor entre fuente de 3.3 V y GND: V_nodo = 3.3 V, I = 3.3 / R', () => {
    const circuit: Circuit = {
      nodes: [
        ground(),
        voltageSource('vdd', 3.3),
        node('n1'),
      ],
      branches: [
        resistor('r1', 220, 'vdd', 'n1'),
        resistor('r2', 100, 'n1', 'gnd'),
      ],
    };

    const sol: Solution = solveMNA(circuit);

    // Divisor: V_n1 = 3.3 * 100 / (220 + 100) = 1.03125 V
    expect(sol.voltages['n1']).toBeCloseTo(1.03125, 4);
    // Corriente: 3.3 / (220 + 100) = 0.0103125 A = 10.3125 mA
    const i = sol.branchCurrents['r1'];
    expect(i).toBeCloseTo(0.0103125, 5);
    // Corriente en r2 igual
    expect(sol.branchCurrents['r2']).toBeCloseTo(0.0103125, 5);
    // Potencia en n1 ≈ 0 (nodo pasivo)
    expect(Math.abs(sol.nodePowers?.n1 ?? 0)).toBeLessThan(1e-9);
  });

  it('resistor solo a GND (sin fuente): V = 0', () => {
    const circuit: Circuit = {
      nodes: [ground(), node('n1')],
      branches: [resistor('r1', 1000, 'n1', 'gnd')],
    };

    const sol = solveMNA(circuit);
    expect(sol.voltages['n1']).toBe(0);
    expect(sol.branchCurrents['r1']).toBe(0);
  });
});

describe('solver MNA – Test 2: dos LEDs en serie', () => {
  function ledBranch(id: string, a: string, b: string) {
    return diode(id, a, b, 2.0, 15); // Vf=2V, Rs=15Ω (como LED rojo del catálogo)
  }

  it('con 5 V fuente: ambos conducen (~10 mA)', () => {
    const circuit: Circuit = {
      nodes: [
        ground(),
        voltageSource('vdd', 5.0),
        node('n1'), // entre led1 y led2
        node('n2'), // entre led2 y GND
      ],
      branches: [
        resistor('r1', 100, 'vdd', 'n1'),    // R serie 100Ω
        ledBranch('led1', 'n1', 'n2'),       // LED1
        ledBranch('led2', 'n2', 'gnd'),      // LED2
      ],
    };

    const sol = solveMNA(circuit);

    // Con 5V: 5 - 2*Vf = 1V cae en R + 2*Rs = 100 + 30 = 130Ω -> I ≈ 7.7 mA
    // (Newton iterará para converger al punto real del diodo)
    expect(sol.branchCurrents['led1']).toBeGreaterThan(0.005); // > 5 mA
    expect(sol.branchCurrents['led1']).toBeLessThan(0.02);     // < 20 mA
    expect(corriente(sol, 'led2')).toBeCloseTo(corriente(sol, 'led1'), 4);
    expect(sol.voltages['n1']).toBeGreaterThan(2.0); // > Vf
    expect(sol.voltages['n2']).toBeGreaterThan(2.0); // > Vf
  });

  it('con 3.3 V fuente: corriente < 1 µA (no encienden)', () => {
    const circuit: Circuit = {
      nodes: [
        ground(),
        voltageSource('vdd', 3.3),
        node('n1'),
        node('n2'),
      ],
      branches: [
        resistor('r1', 100, 'vdd', 'n1'),
        ledBranch('led1', 'n1', 'n2'),
        ledBranch('led2', 'n2', 'gnd'),
      ],
    };

    const sol = solveMNA(circuit);
    // 3.3V < 2*Vf (4V) -> diodos en corte, corriente de fuga < 1 µA
    expect(Math.abs(corriente(sol, 'led1'))).toBeLessThan(1e-6);
    expect(Math.abs(corriente(sol, 'led2'))).toBeLessThan(1e-6);
  });
});
describe('solver MNA – Test 3: interruptor en serie', () => {
  it('cerrado conduce y abierto corta: GPIO en alto → pulsador → R → LED → GND', () => {
    // El circuito que no modela circuitPhysics: la placa alimenta y el pulsador está
    // en el camino de la corriente. El GPIO en alto es una fuente de 3.3 V con los
    // 33 Ω internos del pin (pinOutputOhm del ESP32-S3).
    const armar = (cerrado: boolean): Circuit => ({
      nodes: [ground(), voltageSource('gpio7', 3.3), node('n1'), node('n2'), node('n3')],
      branches: [
        resistor('rpin', 33, 'gpio7', 'n1'),
        { id: 'btn1', kind: 'switch', closed: cerrado, nodes: ['n1', 'n2'] },
        resistor('r1', 110, 'n2', 'n3'),
        diode('led1', 'n3', 'gnd', 2, 15),
      ],
    });

    const apretado = solveMNA(armar(true));
    // I = (3.3 − 2) / (33 + 110 + 15) = 8.23 mA
    expect(corriente(apretado, 'led1')).toBeCloseTo(0.00823, 5);

    const suelto = solveMNA(armar(false));
    expect(Math.abs(corriente(suelto, 'led1'))).toBeLessThan(1e-6);
  });
});
