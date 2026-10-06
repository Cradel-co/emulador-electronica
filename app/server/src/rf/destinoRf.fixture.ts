import { defaultProject, type Project } from '@emu/shared';
import type { AnalisisCircuito } from '../sim/analisis.js';

export function proyectoRfDePrueba(): Project {
  return { ...defaultProject('prueba-rf', 'esphome'), modules: [
    { id: 'board', type: 'esp32-s3-devkitc-1', props: { usb: true }, x: 0, y: 0 },
    { id: 'control', type: 'remote-433', props: { codeA: '1010', protocol: 1 }, x: 10, y: 10 },
    { id: 'rx', type: 'rxb6', props: {}, x: 20, y: 20 },
  ], wires: [
    { from: 'rx.VCC', to: 'board.3V3' }, { from: 'rx.GND', to: 'board.GND' },
    { from: 'rx.DATA', to: 'board.GPIO4' },
  ] };
}

/** Instantánea del modelo eléctrico, sin invocar ngspice en estas pruebas de enrutamiento. */
export function analisisRfDePrueba(): Pick<AnalisisCircuito, 'resuelto' | 'modulos'> {
  return { resuelto: true, modulos: { rx: { ui: { on: true } } } };
}
