import { promises as fs } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { EmulatorState } from '@emu/shared';
import type { BuildArtifacts } from './buildService.js';
import type { EmulatorEvents, EmulatorStatus } from './emulator.js';
import type { Emulador, OpcionesArranque, PuenteSim } from './emulatorBackend.js';
import { AvrSimulador, PINES_UNO, RelojAvr, type PinMcu } from './avrSim.js';
import type { MensajeAlWorker, MensajeDelWorker } from './avrWorker.js';
import { ControlDepuracionAvr, type EventoAvr, type PedidoAvr, type RespuestaAvr } from './debug/avrControl.js';
import type { SalidaChip } from '@emu/shared';
import { armarBusChips, LineasCompartidas } from './bus/armarBus.js';
import type { BusChips } from './bus/busChips.js';
import type { ChipEnBus } from './bus/proyectoChips.js';

/** Largo máximo de una línea del Serial antes de cortarla (un sketch sin println). */
const MAX_LINEA = 1024;
/**
 * Una línea sin "\n" se muestra igual cuando lleva 200 ms de tiempo SIMULADO sin
 * terminarse (aviso 'flush' del núcleo: AvrSimulador.lineaVencida). Esto es solo el
 * respaldo por reloj de pared, holgado: con la PC cargada el Arduino va más lento que el
 * tiempo real y cortar por reloj de pared partía líneas ("H" / "ola...").
 */
const FLUSH_MS = 10_000;

/**
 * Motor de emulación del Arduino Uno (ATmega328P) con avr8js. Tiene la misma cara
 * que EmulatorManager (esp-emu), así index.ts no distingue: arranca, para, resetea,
 * manda el Serial como `emu.log` y los pines como mensajes del puente (`@OUT`).
 *
 * No hay puente dentro del firmware: el emulador ve los registros del chip, así que
 * "el puente" está listo apenas arranca la CPU y las entradas van directo al pad.
 *
 * Modo 'worker' (el normal): la CPU corre en un worker_thread. Modo 'local': en el
 * mismo hilo, por tramos (para pruebas, o si un worker no se puede crear).
 */
export class AvrEmulator implements Emulador {
  private status: EmulatorStatus = AvrEmulator.emptyStatus();
  private lineas: string[] = [];
  private linea = '';
  private flushTimer: NodeJS.Timeout | null = null;
  private worker: Worker | null = null;
  private local: { sim: AvrSimulador; reloj: RelojAvr } | null = null;
  private puente: PuenteSim | null = null;
  private hex = '';
  private frecuenciaHz = 16_000_000;
  private pines: PinMcu[] = PINES_UNO;
  private avisoLento = false;
  private chips: ChipEnBus[] = [];
  private arranqueMs = 0;
  /** Último entorno de cada chip (el que movió el usuario) y lo último que publicó cada uno. */
  private readonly entornos = new Map<string, Record<string, number>>();
  private readonly salidasChips = new Map<string, SalidaChip>();
  private busLocal: BusChips | null = null;
  private lineasLocal: LineasCompartidas | null = null;
  /** Avisa cuando un chip publica algo (pantalla, valores): lo usa index.ts para la UI. */
  oyenteChips: ((id: string, salida: SalidaChip) => void) | null = null;
  /** Un chip guardó su memoria no volátil: index.ts la escribe en el proyecto. */
  oyenteGuardado: ((id: string, datos: unknown) => void) | null = null;
  private alDetenerse: (() => void) | null = null;
  private readonly decodificador = new TextDecoder('utf-8');
  // Modo debug (debug/adaptadorAvr.ts): pedidos al control de depuración que vive junto a la CPU.
  private readonly pedidosDepuracion = new Map<number, (r: RespuestaAvr) => void>();
  private siguientePedido = 1;
  private controlLocal: ControlDepuracionAvr | null = null;
  /** Avisos del depurador (frenó en un breakpoint, siguió). */
  oyenteDepuracion: ((e: EventoAvr) => void) | null = null;

  constructor(
    private readonly events: EmulatorEvents,
    private readonly modo: 'worker' | 'local' = 'worker',
  ) {}

  private static emptyStatus(): EmulatorStatus {
    return { state: 'stopped', running: false, pid: null, project: null, ports: null, ip: null, startedAt: null, exitInfo: null };
  }

  getStatus(): EmulatorStatus {
    return { ...this.status };
  }

  getRecentLog(limit = 200): string[] {
    return this.lineas.slice(-limit);
  }

  /** Chips del dibujo que están en el bus de esta corrida, con su entorno actual y lo último que publicaron. */
  chipsEnCorrida(): { id: string; instancia: string; chip: string; nombre: string; alimentado: boolean; entorno: Record<string, number>; salida?: SalidaChip }[] {
    return this.chips.map((c) => ({
      id: c.id, instancia: c.instancia, chip: c.chip, nombre: c.nombre, alimentado: c.alimentado,
      entorno: { ...this.entornos.get(c.id) }, salida: this.salidasChips.get(c.id),
    }));
  }

  /**
   * El usuario movió el entorno de una instancia (sin reiniciar nada): cada chip de esa placa
   * toma las magnitudes que mide. false si la instancia no tiene chips en el bus.
   */
  ponerEntorno(instancia: string, valores: Record<string, number>): boolean {
    let alguno = false;
    for (const c of this.chips) {
      if (c.instancia !== instancia) continue;
      const actual = this.entornos.get(c.id)!;
      const suyos = Object.fromEntries(Object.entries(valores).filter(([k]) => k in actual));
      alguno = true;
      if (Object.keys(suyos).length === 0) continue;
      Object.assign(actual, suyos);
      this.busLocal?.ponerEntorno(c.id, suyos);
      this.mandar({ t: 'entorno', id: c.id, valores: suyos });
    }
    return alguno;
  }

  getBridge(): PuenteSim | null {
    return this.puente;
  }

  markBridgeReady(): void {
    this.setState('bridge');
  }

  async start(projectName: string, artifacts: BuildArtifacts, opts: OpcionesArranque = {}): Promise<EmulatorStatus> {
    if (this.status.running) await this.stop();
    this.hex = await fs.readFile(artifacts.firmware, 'utf8');
    this.frecuenciaHz = opts.frecuenciaHz ?? 16_000_000;
    this.pines = opts.pinesMcu ?? PINES_UNO;
    this.chips = opts.chips ?? [];
    this.arranqueMs = opts.arranqueMs ?? 0;
    this.entornos.clear();
    this.salidasChips.clear();
    for (const c of this.chips) this.entornos.set(c.id, { ...c.entorno });
    this.lineas = [];
    this.linea = '';
    this.avisoLento = false;
    this.status = { ...AvrEmulator.emptyStatus(), state: 'starting', running: true, project: projectName, startedAt: Date.now() };
    this.emitState();
    this.log(`$ avr8js atmega328p @ ${this.frecuenciaHz / 1e6} MHz ${artifacts.firmware}`);

    this.puente = {
      watch: (pin) => this.mandar({ t: 'vigilar', pin }),
      setInput: (pin, level) => this.mandar({ t: 'entrada', pin, nivel: level ? 1 : 0 }),
      sendRf: () => this.log('[avr] RF 433 MHz todavía no se simula en el Arduino Uno.'),
    };

    if (this.modo === 'worker') {
      try {
        this.arrancarWorker();
      } catch (err) {
        this.log(`[avr] no se pudo crear el hilo del emulador (${(err as Error).message}): corre en el hilo principal.`);
        this.arrancarLocal();
      }
    } else {
      this.arrancarLocal();
    }
    return this.getStatus();
  }

  private arrancarWorker(): void {
    const worker = new Worker(new URL('./avrWorker.mjs', import.meta.url));
    this.worker = worker;
    worker.on('message', (m: MensajeDelWorker) => {
      if (this.worker === worker) this.recibir(m);
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      this.log(`[avr] el emulador falló: ${err.message}`);
      this.teardown(`falló: ${err.message}`, 'crashed');
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.log(`[emu] el emulador terminó (code=${code})`);
      this.teardown(`terminó con código ${code}`);
    });
    worker.postMessage({ t: 'iniciar', hex: this.hex, frecuenciaHz: this.frecuenciaHz, pines: this.pines, chips: this.chips, arranqueMs: this.arranqueMs } satisfies MensajeAlWorker);
  }

  private arrancarLocal(): void {
    try {
      const sim = new AvrSimulador(this.hex, {
        onSerial: (b) => this.serial([b]),
        onPin: (pin, nivel) => this.recibir({ t: 'pin', pin, nivel }),
      }, this.frecuenciaHz, this.pines);
      // En modo local el bus se arma de nuevo en cada arranque (un reset rearma todo).
      this.lineasLocal = new LineasCompartidas((gpio, nivel) => sim.ponerEntrada(gpio, nivel));
      const lineas = this.lineasLocal;
      this.busLocal = armarBusChips(this.chips, this.arranqueMs, {
        ahoraUs: () => sim.micros,
        alLog: (linea) => this.recibir({ t: 'log', linea }),
        alSalida: (id, salida) => this.recibir({ t: 'chip', id, salida }),
        alGuardar: (id, datos) => this.recibir({ t: 'guardado', id, datos }),
        alPin: (id, pin, nivel) => {
          const c = this.chips.find((x) => x.id === id);
          if (c) lineas.desdeChip(c, pin, nivel);
        },
        programar: (tUs, fn) => sim.cpu.addClockEvent(fn, Math.max(1, Math.round(((tUs - sim.micros) / 1e6) * this.frecuenciaHz))),
      });
      if (this.busLocal) sim.conectarChips(this.busLocal);
      this.controlLocal ??= new ControlDepuracionAvr(
        { sim: () => this.local?.sim ?? null, reloj: () => this.local?.reloj ?? null },
        (evento) => this.recibir({ t: 'depurar-evento', evento }),
      );
      const reloj = new RelojAvr(sim, () => {
        if (sim.lineaVencida()) this.recibir({ t: 'flush' });
        this.controlLocal?.alTerminarTramo();
      });
      this.local = { sim, reloj };
      this.controlLocal.alCrearSim(sim);
      reloj.arrancar();
      this.recibir({ t: 'listo' });
    } catch (err) {
      this.log(`[avr] no se pudo cargar el firmware: ${(err as Error).message}`);
      this.teardown((err as Error).message, 'crashed');
    }
  }

  private mandar(m: MensajeAlWorker): void {
    if (this.worker) {
      this.worker.postMessage(m);
      return;
    }
    const l = this.local;
    if (!l) return;
    switch (m.t) {
      case 'entrada':
        if (this.lineasLocal) this.lineasLocal.desdeApp(m.pin, m.nivel);
        else l.sim.ponerEntrada(m.pin, m.nivel);
        break;
      case 'vigilar':
        l.sim.vigilar(m.pin);
        break;
      case 'serial':
        l.sim.escribirSerial(m.datos);
        break;
      default:
        break;
    }
  }

  private recibir(m: MensajeDelWorker): void {
    switch (m.t) {
      case 'listo':
        // Sin bootloader ni WiFi: la CPU arranca en el vector de reset y el sketch ya corre.
        this.setState('booted');
        this.events.onBridgeState(true);
        // Mismo aviso que manda el puente de los ESP32: la UI habilita el modo "En vivo".
        this.events.onBridgeMessage({ type: 'READY', version: 1, esphomeVersion: 'avr8js' });
        break;
      case 'serial':
        this.serial(m.datos);
        break;
      case 'flush':
        if (this.linea) this.emitirLinea(this.linea);
        this.linea = '';
        break;
      case 'pin':
        this.events.onBridgeMessage({ type: 'OUT', pin: m.pin, level: m.nivel });
        break;
      case 'velocidad':
        if (m.valor < 0.8 && !this.avisoLento) {
          this.avisoLento = true;
          this.log(`[avr] la PC no llega a tiempo real: el Arduino corre al ${Math.round(m.valor * 100)} % de su velocidad.`);
        }
        break;
      case 'error':
        this.log(`[avr] error: ${m.mensaje}`);
        break;
      case 'chip':
        this.salidasChips.set(m.id, m.salida);
        this.oyenteChips?.(m.id, m.salida);
        break;
      case 'log':
        this.log(m.linea);
        break;
      case 'guardado':
        this.oyenteGuardado?.(m.id, m.datos);
        break;
      case 'detenido':
        this.alDetenerse?.();
        break;
      case 'depurar':
        this.pedidosDepuracion.get(m.id)?.(m.respuesta);
        this.pedidosDepuracion.delete(m.id);
        break;
      case 'depurar-evento':
        this.oyenteDepuracion?.(m.evento);
        break;
    }
  }

  /** Pedido al control de depuración (memoria, registros, breakpoints, pausa, paso). */
  depurar(pedido: PedidoAvr, timeoutMs = 3000): Promise<RespuestaAvr> {
    if (!this.worker) {
      return Promise.resolve(this.controlLocal && this.local ? this.controlLocal.atender(pedido) : { ok: false, error: 'el Arduino no está corriendo' });
    }
    const id = this.siguientePedido++;
    const worker = this.worker;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pedidosDepuracion.delete(id);
        resolve({ ok: false, error: 'el emulador no respondió al depurador' });
      }, timeoutMs);
      this.pedidosDepuracion.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      worker.postMessage({ t: 'depurar', id, pedido } satisfies MensajeAlWorker);
    });
  }

  /** Bytes del Serial → líneas del log (como el monitor serie del IDE de Arduino). */
  private serial(datos: number[]): void {
    this.linea += this.decodificador.decode(Uint8Array.from(datos), { stream: true });
    let i: number;
    while ((i = this.linea.indexOf('\n')) !== -1) {
      this.emitirLinea(this.linea.slice(0, i));
      this.linea = this.linea.slice(i + 1);
    }
    if (this.linea.length > MAX_LINEA) {
      this.emitirLinea(this.linea);
      this.linea = '';
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.linea) {
      this.flushTimer = setTimeout(() => {
        if (this.linea) this.emitirLinea(this.linea);
        this.linea = '';
      }, FLUSH_MS);
      this.flushTimer.unref();
    }
  }

  private emitirLinea(raw: string): void {
    this.log(raw.replace(/\r$/, ''));
  }

  private log(line: string): void {
    this.lineas.push(line);
    if (this.lineas.length > 2000) this.lineas.shift();
    this.events.onLog(line);
  }

  private setState(state: EmulatorState): void {
    if (this.status.state === state) return;
    this.status.state = state;
    this.log(`[emu] estado: ${state}`);
    this.emitState();
  }

  private emitState(): void {
    this.events.onState(this.getStatus());
  }

  writeConsole(data: string): boolean {
    if (!this.status.running) return false;
    this.mandar({ t: 'serial', datos: [...Buffer.from(data, 'utf8')] });
    return true;
  }

  /** Como apretar RESET en la placa: el sketch arranca de cero (las entradas siguen como estaban). */
  async reset(): Promise<string> {
    if (!this.status.running) throw new Error('El emulador no está corriendo');
    this.log('[emu] reset');
    if (this.worker) {
      this.worker.postMessage({ t: 'reset' } satisfies MensajeAlWorker);
    } else if (this.local) {
      this.local.reloj.parar();
      this.local = null;
      this.arrancarLocal();
    }
    this.events.onBridgeMessage({ type: 'READY', version: 1, esphomeVersion: 'avr8js' });
    return 'ok';
  }

  async stop(): Promise<void> {
    if (!this.status.running && !this.worker && !this.local) return;
    this.log('[emu] detenido por la app');
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      // Se espera (poco) a que los chips se apaguen y manden lo que guardan antes de cortar el hilo.
      const detenido = new Promise<void>((r) => {
        this.alDetenerse = r;
        setTimeout(r, 1000);
      });
      worker.on('message', (m: MensajeDelWorker) => this.recibir(m));
      worker.postMessage({ t: 'parar' } satisfies MensajeAlWorker);
      await detenido;
      this.alDetenerse = null;
      await worker.terminate().catch(() => undefined);
    } else {
      this.busLocal?.apagar();
    }
    this.teardown('parado');
  }

  private teardown(exitInfo: string, state: EmulatorState = 'stopped'): void {
    this.local?.reloj.parar();
    this.local = null;
    this.worker?.terminate().catch(() => undefined);
    this.worker = null;
    this.puente = null;
    for (const r of this.pedidosDepuracion.values()) r({ ok: false, error: 'el emulador se detuvo' });
    this.pedidosDepuracion.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const estabaCorriendo = this.status.running;
    this.status = { ...this.status, state, running: false, exitInfo };
    this.emitState();
    if (estabaCorriendo) this.events.onBridgeState(false);
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }
}
