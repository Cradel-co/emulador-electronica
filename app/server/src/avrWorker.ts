import type { MessagePort } from 'node:worker_threads';
import type { SalidaChip } from '@emu/shared';
import { AvrSimulador, RelojAvr, type PinMcu } from './avrSim.js';
import type { BusI2c } from './bus/busI2c.js';
import { armarBusI2c, LineasCompartidas } from './bus/armarBus.js';
import type { ChipEnBus } from './bus/proyectoChips.js';
import { ControlDepuracionAvr, type EventoAvr, type PedidoAvr, type RespuestaAvr } from './debug/avrControl.js';

/**
 * Lado del hilo (worker_thread) del emulador AVR: acá corre la CPU, así el server
 * no se traba mientras el Arduino emulado ejecuta millones de instrucciones por
 * segundo. Lo arranca avrWorker.mjs (que carga este archivo con tsx) y habla con
 * avrEmulator.ts por mensajes.
 */

export type MensajeAlWorker =
  | { t: 'iniciar'; hex: string; frecuenciaHz: number; pines: PinMcu[]; chips?: ChipEnBus[]; arranqueMs?: number }
  /** El usuario movió el entorno de un chip (temperatura...). */
  | { t: 'entorno'; id: string; valores: Record<string, number> }
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
  /** Lo que publicó un chip para mostrar (pantalla, valores). */
  | { t: 'chip'; id: string; salida: SalidaChip }
  /** Avisos del bus y de los chips ("[i2c] ..."), para la consola. */
  | { t: 'log'; linea: string }
  /** Un chip guardó su memoria no volátil (EEPROM, la hora con pila). */
  | { t: 'guardado'; id: string; datos: unknown }
  /** Respuesta a 'parar': los chips ya se apagaron y mandaron lo que guardan. */
  | { t: 'detenido' }
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
  // Entradas del micro: las manejan la app (botones, motor eléctrico) y los chips (INT, SQW).
  const lineas = new LineasCompartidas((gpio, nivel) => sim?.ponerEntrada(gpio, nivel));
  let ultimoAvisoVelocidad = 0;

  const enviar = (m: MensajeDelWorker): void => puerto.postMessage(m);
  const control = new ControlDepuracionAvr({ sim: () => sim, reloj: () => reloj }, (evento) => enviar({ t: 'depurar-evento', evento }));

  // Chips del dibujo en el bus I2C. Viven más que la CPU: un reset del micro no apaga el sensor,
  // así que el bus se arma una vez por corrida y el tiempo sigue corriendo entre resets.
  let chips: ChipEnBus[] = [];
  let arranqueMs = 0;
  let bus: BusI2c | null = null;
  let tiempoAntesUs = 0; // µs simulados de las CPU anteriores (resets)
  const salidas = new Map<string, SalidaChip>();
  let salidaTimer: NodeJS.Timeout | null = null;
  const mandarSalidas = (): void => {
    salidaTimer = null;
    for (const [id, salida] of salidas) enviar({ t: 'chip', id, salida });
    salidas.clear();
  };
  const armarBus = (): void => {
    tiempoAntesUs = 0;
    const ahora = (): number => tiempoAntesUs + (sim?.micros ?? 0);
    bus = armarBusI2c(chips, arranqueMs, {
      ahoraUs: ahora,
      alLog: (linea) => enviar({ t: 'log', linea }),
      alGuardar: (id, datos) => enviar({ t: 'guardado', id, datos }),
      alPin: (id, pin, nivel) => {
        const c = chips.find((x) => x.id === id);
        if (c) lineas.desdeChip(c, pin, nivel);
      },
      // El despertador de un chip (el cambio de segundo de un reloj) se agenda en el reloj de la CPU.
      programar: (tUs, fn) => {
        if (!sim) return;
        sim.cpu.addClockEvent(fn, Math.max(1, Math.round(((tUs - ahora()) / 1e6) * frecuenciaHz)));
      },
      // Una pantalla puede publicar cientos de veces por segundo: se manda como mucho cada 50 ms.
      alSalida: (id, salida) => {
        salidas.set(id, salida);
        salidaTimer ??= setTimeout(mandarSalidas, 50);
      },
    });
  };

  const crear = (): void => {
    reloj?.parar();
    if (sim) tiempoAntesUs += sim.micros;
    sim = new AvrSimulador(hex, {
      onSerial: (b) => serial.push(b),
      onPin: (pin, nivel) => enviar({ t: 'pin', pin, nivel }),
    }, frecuenciaHz, pines);
    if (bus) {
      sim.conectarI2c(bus);
      bus.reengancharHost(); // despertadores y pines de los chips, en la CPU nueva
    }
    // Tras un reset, los módulos y los chips siguen manejando sus entradas como antes.
    lineas.reaplicar();
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
          chips = m.chips ?? [];
          arranqueMs = m.arranqueMs ?? 0;
          sim = null;
          armarBus();
          crear();
          enviar({ t: 'listo' });
          break;
        case 'entrada':
          lineas.desdeApp(m.pin, m.nivel);
          break;
        case 'entorno':
          bus?.ponerEntorno(m.id, m.valores);
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
          if (salidaTimer) clearTimeout(salidaTimer);
          bus?.apagar(); // los chips guardan lo último (EEPROM, la hora) antes de cortar
          enviar({ t: 'detenido' });
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
