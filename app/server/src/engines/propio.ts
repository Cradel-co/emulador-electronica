import type { MotorEmulacion } from './tipos.js';
import { EmuladorPropio } from '../propio/emulador.js';

export const propio: MotorEmulacion = {
  nombre: 'propio', descripcion: 'Motor funcional propio: GPIO y temporización de un subconjunto de MicroPython, en TypeScript.',
  disponible: true, modosIo: ['native'], crear: eventos => new EmuladorPropio(eventos),
  opcionesArranque: desc => ({ pinesPropios: Object.values(desc.pins).map(p => p.gpio),
    capacidadesPropias: Object.values(desc.pins).map(p => ({ gpio: p.gpio, entrada: p.caps.includes('digital-in'), salida: p.caps.includes('digital-out') })),
  }),
};
