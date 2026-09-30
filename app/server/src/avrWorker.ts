import type { MessagePort } from 'node:worker_threads';
import { AvrSimulador, RelojAvr, type PinMcu } from './avrSim.js';
import { ControlDepuracionAvr, type EventoAvr, type PedidoAvr, type RespuestaAvr } from './debug/avrControl.js';

/**
 * Lado del hilo (worker_thread) del emulador AVR: acá corre la CPU, así el server
 * no se traba mientras el Arduino emulado ejecuta millones de instrucciones por
 * segundo. Lo arranca avrWorker.mjs (que carga este archivo con tsx) y habla con
 * avrEmulator.ts por mensajes.
 */

export type MensajeAlWorker =
  | { t: 'iniciar'; hex: string; frecuenciaHz: number; pines: PinMcu[] }
  | { t: 'entrada'; pin: number; nivel: 0 | 1 | null }
  | { t: 'vigilar'; pin: number }
  | { t: 'serial'; datos: number[] }
  | { t: 'reset' }
  | { t: 'parar' }
  /** Modo debug (debug/avrControl.ts): leer memoria/registros, breakpoints, pausa, paso. */
  | { t: 'depurar'; id: number; pedido: PedidoAvr };

export type MensajeDelWorker =
  | { t: 'listo' }
  | { t: 'serial'; datos: number[] }
  /** La línea del Serial a medio escribir ya lleva 200 ms simulados: mostrarla igual. */
  | { t: 'flush' }
  | { t: 'pin'; pin: number; nivel: 0 | 1 }
  | { t: 'velocidad'; valor: number }
  | { t: 'error'; mensaje: string }
  | { t: 'depurar'; id: number; respuesta: RespuestaAvr }
  | { t: 'depurar-evento'; evento: EventoAvr };

export function atenderWorker(puerto: MessagePort): void {
  let sim: AvrSimulador | null = null;
  let reloj: RelojAvr | null = null;
  let hex = '';
  let frecuenciaHz = 16_000_000;
  let pines: PinMcu[] = [];
  let serial: number[] = [];
  const entradas = new Map<number, 0 | 1 | null>();
  let ultimoAvisoVelocidad = 0;

  const enviar = (m: MensajeDelWorker): void => puerto.postMessage(m);
  const control = new ControlDepuracionAvr({ sim: () => sim, reloj: () => reloj }, (evento) => enviar({ t: 'depurar-evento', evento }));

  const crear = (): void => {
    reloj?.parar();
    sim = new AvrSimulador(hex, {
      onSerial: (b) => serial.push(b),
      onPin: (pin, nivel) => enviar({ t: 'pin', pin, nivel }),
    }, frecuenciaHz, pines);
    // Tras un reset, los módulos siguen manejando sus entradas como antes.
    for (const [pin, nivel] of entradas) sim.ponerEntrada(pin, nivel);
    control.alCrearSim(sim);
    reloj = new RelojAvr(sim, () => {
      if (serial.length > 0) {
        enviar({ t: 'serial', datos: serial });
        serial = [];
      }
      if (sim?.lineaVencida()) enviar({ t: 'flush' });
      const ahora = Date.now();
      if (ahora - ultimoAvisoVelocidad > 5000 && reloj) {
        ultimoAvisoVelocidad = ahora;
        enviar({ t: 'velocidad', valor: reloj.velocidad() });
      }
      control.alTerminarTramo(); // ¿frenó en un breakpoint? (después de mandar el Serial de hasta ahí)
    });
    reloj.arrancar();
  };

  puerto.on('message', (m: MensajeAlWorker) => {
    try {
      switch (m.t) {
        case 'iniciar':
          hex = m.hex;
          frecuenciaHz = m.frecuenciaHz;
          pines = m.pines;
          crear();
          enviar({ t: 'listo' });
          break;
        case 'entrada':
          if (m.nivel === null) entradas.delete(m.pin);
          else entradas.set(m.pin, m.nivel);
          sim?.ponerEntrada(m.pin, m.nivel);
          break;
        case 'vigilar':
          sim?.vigilar(m.pin);
          break;
        case 'serial':
          sim?.escribirSerial(m.datos);
          break;
        case 'reset':
          if (hex) crear();
          break;
        case 'parar':
          reloj?.parar();
          puerto.close();
          break;
        case 'depurar':
          enviar({ t: 'depurar', id: m.id, respuesta: control.atender(m.pedido) });
          break;
      }
    } catch (err) {
      enviar({ t: 'error', mensaje: (err as Error).message });
    }
  });
}
