export {};
// Aproximación inicial de consumo constante: 70 mA a 3,3 V (ver SDD-ARDUCAM.md).
declare const module: { exports: unknown };
interface Circuito { pin(n: string): string; resistencia(a: string, b: string, ohms: number, nombre: string): void }
interface Lectura { vEntre(a: string, b: string): number }
module.exports = {
  circuito(c: Circuito) {
    c.resistencia(c.pin('VCC'), c.pin('GND'), 3.3 / 0.070, 'camara');
    c.resistencia(c.pin('SDA'), c.pin('VCC'), 10000, 'sda');
    c.resistencia(c.pin('SCL'), c.pin('VCC'), 10000, 'scl');
    c.resistencia(c.pin('CS'), c.pin('VCC'), 100000, 'cs');
  },
  observar(l: Lectura) {
    const v = l.vEntre('VCC', 'GND');
    return { ui: { on: v >= 3 && v <= 5.5 }, avisos: v > 5.5 ? [{ severidad: 'peligro', mensaje: 'ArduCAM: alimentación excesiva.' }] : [] };
  },
};
