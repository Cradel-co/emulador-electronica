import type { Project } from '@emu/shared';
import type { PerfilAnalogicoEsp } from '@emu/shared';

export const perfilEspPrueba = (): PerfilAnalogicoEsp => ({
  tipo: 'micropython-lineal-explicito-12bits', chip: 'esp32s3', id: 'oraculo-sintetico',
  fuente: 'Escenario analítico de prueba; no caracterización de silicio', condiciones: 'DC, ADC1, sin adquisición RC',
  rangoVAlimentacion: { min: 3, max: 3.6 },
  canales: [
    { gpio: 4, atenuacion: '11db', rangoVEntrada: { min: 0, max: 3.3 }, voltajeCeroV: 0, voltajeFondoEscalaV: 3.2 },
    { gpio: 4, atenuacion: '0db', rangoVEntrada: { min: 0, max: 3.3 }, voltajeCeroV: 0.1, voltajeFondoEscalaV: 0.9 },
  ],
});
export const proyectoEspPrueba = (): Project => ({ schemaVersion: 1, name: 'adc-esp-fisico', board: 'esp32-s3-devkitc-1', language: 'micropython',
  boards: [{ id: 'board', board: 'esp32-s3-devkitc-1', language: 'micropython' }],
  modules: [{ id: 'board', type: 'esp32-s3-devkitc-1', props: { usb: true }, x: 0, y: 0 },
    { id: 'r1', type: 'resistor', props: { ohms: 1000 }, x: 0, y: 0 }, { id: 'r2', type: 'resistor', props: { ohms: 1000 }, x: 0, y: 0 }],
  wires: [{ from: 'board.3V3', to: 'r1.1' }, { from: 'r1.2', to: 'board.GPIO4' }, { from: 'board.GPIO4', to: 'r2.1' }, { from: 'r2.2', to: 'board.GND' }],
  sim: { wifiSsid: 'x', wifiPassword: 'y', autoReload: false } });
