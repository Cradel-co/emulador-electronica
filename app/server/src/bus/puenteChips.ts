import type { SalidaChip } from '@emu/shared';
import { armarBusChips } from './armarBus.js';
import type { EntradaChip } from './chipSandbox.js';
import { ErrorContencionSpi, type BusChips } from './busChips.js';
import type { ChipEnBus } from './proyectoChips.js';

/**
 * Chips del dibujo en un ESP32 con MicroPython. esp-emu no acepta dispositivos I2C/SPI propios, así
 * que el puente (templates/micropythonBridge.ts) reemplaza `machine.I2C`, `SoftI2C`, `SPI` y
 * `SoftSPI`: cada llamada del programa viaja como una línea por la UART del puente y la contesta
 * esta clase con los mismos chips y el mismo bus que usa el Uno (BusChips). La matriz GPIO deja
 * usar cualquier par de pines: hay un bus por par (los del programa tienen que coincidir con los
 * cables del dibujo, como en la placa real).
 *
 * El reloj es el del ESP32: cada línea trae su `ticks_us` (30 bits, se desenrolla acá), y el puente
 * manda `@T` cada ~50 ms para que los despertadores de los chips (una conversión, el segundo del
 * reloj, un cuadro de la pantalla) corran aunque el programa no hable.
 *
 * Protocolo (líneas; datos en base64):
 *   ESP32 → app  @T <ticks>                                  latido del reloj
 *                @P <gpio> <0|1> <ticks>                     el programa escribió un pin que vigilan los chips (CS, DC, RST)
 *                @I2C <id> <ticks> <sda> <scl> <hz> <ops>    ops: W<dir hex>:<b64> | R<dir hex>:<n> | P (STOP), separadas por ';'
 *                @I2CS <id> <ticks> <sda> <scl> <hz>         scan()
 *                @SPI <id> <ticks> <sck> <mosi> <miso> <hz> <modo> <lsb> <b64> <0|1>   1 = espera respuesta
 *   app → ESP32  @CHIPPINS <gpio>...                         qué pines avisar con @P
 *                @I2CR <id> <res;res...>                     W → bytes con ACK, R → b64, N → la dirección no contestó
 *                @I2CR <id> <dir,dir...>                     respuesta a scan()
 *                @SPIR <id> <b64>                            lo que entró por MISO
 *                @SPIR <id> E:CONTENCION_MISO                 el byte no tiene valor lógico válido
 */

const VUELTA_TICKS = 2 ** 30; // utime.ticks_us() de MicroPython: 30 bits

export interface EventosPuenteChips {
  /** Manda una línea al ESP32 por el puente. */
  enviar: (linea: string) => void;
  alSalida?: (id: string, salida: SalidaChip) => void;
  alLog?: (linea: string) => void;
  alGuardar?: (id: string, datos: unknown) => void;
  alPin?: (id: string, pin: string, nivel: 0 | 1 | null) => void;
}

export class PuenteChips {
  private readonly i2c = new Map<string, BusChips>();
  private readonly spi = new Map<string, BusChips>();
  /** µs del ESP32 desde que arrancó (desenrollado). */
  private t = 0;
  private ultimoCrudo: number | null = null;
  private agenda: { t: number; fn: () => void }[] = [];
  private apagado = false;

  constructor(readonly chips: ChipEnBus[], private readonly ev: EventosPuenteChips) {
    const grupos = new Map<string, ChipEnBus[]>();
    for (const c of chips) {
      const clave = c.i2cGpio ? `i2c:${c.i2cGpio.sda},${c.i2cGpio.scl}` : c.spi?.sck !== undefined ? `spi:${c.spi.sck},${c.spi.mosi}` : null;
      if (!clave) continue;
      grupos.set(clave, [...(grupos.get(clave) ?? []), c]);
    }
    for (const [clave, cs] of grupos) {
      const bus = armarBusChips(cs, 0, {
        ahoraUs: () => this.t,
        alSalida: (id, salida) => {
          const chip = this.chips.find(c => c.id === id);
          if (chip?.chip === 'ov2640' && typeof salida.cameraConfig === 'boolean') this.entradaCamara(chip.instancia, { tipo: 'configuracion', soportada: salida.cameraConfig });
          ev.alSalida?.(id, salida);
        },
        alLog: ev.alLog,
        alGuardar: ev.alGuardar,
        alPin: ev.alPin,
        programar: (t, fn) => this.agenda.push({ t, fn }),
      });
      if (!bus) continue;
      (clave.startsWith('i2c:') ? this.i2c : this.spi).set(clave.slice(4), bus);
    }
  }

  actualizarCamaras(nuevos: ChipEnBus[]): void {
    for (const c of this.chips.filter(x => x.chip === 'ov2640' || x.chip === 'arduchip')) {
      const nuevo = nuevos.find(x => x.id === c.id && x.chip === c.chip);
      const alimentado = !!nuevo?.alimentado && JSON.stringify(nuevo.spi) === JSON.stringify(c.spi) && JSON.stringify(nuevo.i2cGpio) === JSON.stringify(c.i2cGpio);
      for (const bus of [...this.i2c.values(), ...this.spi.values()]) bus.alimentar(c.id, alimentado);
      c.alimentado = alimentado;
    }
  }

  entradaCamara(instancia: string, datos: EntradaChip): void {
    const controlador = this.chips.find(c => c.instancia === instancia && c.chip === 'arduchip');
    if (!controlador || this.apagado) return;
    for (const bus of this.spi.values()) bus.externo(controlador.id, datos);
  }

  /** Pines que el ESP32 tiene que avisar cuando el programa los escribe. */
  pinesVigilados(): number[] {
    return [...new Set([...this.i2c.values(), ...this.spi.values()].flatMap((b) => b.gpiosVigilados()))].sort((a, b) => a - b);
  }

  /** El puente arrancó (o se reinició): qué pines vigilar. */
  alListo(): void {
    this.ev.enviar(`@CHIPPINS ${this.pinesVigilados().join(' ')}`.trimEnd());
  }

  /** Una línea del puente. true si era para los chips. */
  recibir(linea: string): boolean {
    if (this.apagado) return false;
    const p = linea.trim().split(' ');
    const tag = p[0];
    try {
      switch (tag) {
        case '@READY':
          this.alListo();
          return false; // el resto de la app también la usa
        case '@T':
          this.avanzar(num(p[1]));
          return true;
        case '@P': {
          this.avanzar(num(p[3]));
          const g = num(p[1]);
          const nivel = num(p[2]) ? 1 : 0;
          for (const b of this.spi.values()) b.pinMcu(g, nivel);
          for (const b of this.i2c.values()) b.pinMcu(g, nivel);
          return true;
        }
        case '@I2C':
          this.avanzar(num(p[2]));
          this.ev.enviar(`@I2CR ${num(p[1])} ${this.transaccionI2c(`${num(p[3])},${num(p[4])}`, num(p[5]), p[6] ?? '')}`);
          return true;
        case '@I2CS': {
          this.avanzar(num(p[2]));
          const bus = this.i2c.get(`${num(p[3])},${num(p[4])}`);
          const hay: string[] = [];
          if (bus) {
            bus.velocidad(num(p[5]));
            for (let dir = 0x08; dir < 0x78; dir++) {
              bus.inicio();
              if (bus.conectar(dir, true)) hay.push(dir.toString(16));
              bus.parada();
            }
          }
          this.ev.enviar(`@I2CR ${num(p[1])} ${hay.join(',')}`.trimEnd());
          return true;
        }
        case '@SPI': {
          const id = num(p[1]);
          this.avanzar(num(p[2]));
          const bus = this.spi.get(`${num(p[3])},${num(p[4])}`);
          const hz = num(p[6]), modo = num(p[7]), lsb = num(p[8]) === 1;
          if ((p[9]?.length ?? 0) > 2048) throw new Error('transferencia SPI excesiva (máximo 1536 bytes)');
          const mosi = Buffer.from(p[9] ?? '', 'base64');
          const miso = Buffer.alloc(mosi.length, 0xff);
          if (bus) for (let i = 0; i < mosi.length; i++) miso[i] = bus.spiByte(mosi[i] ?? 0, { modo, lsbPrimero: lsb, hz, misoGpio: num(p[5]) });
          if (p[10] === '1') this.ev.enviar(`@SPIR ${id} ${miso.toString('base64')}`);
          return true;
        }
        default:
          return false;
      }
    } catch (err) {
      if (err instanceof ErrorContencionSpi) {
        this.ev.alLog?.(err.message);
        if (tag === '@SPI' && p[10] === '1') this.ev.enviar(`@SPIR ${num(p[1])} E:${err.codigo}`);
        return true;
      }
      this.ev.alLog?.(`[chips] línea del puente que no se entendió (${linea.slice(0, 60)}): ${(err as Error).message}`);
      return true;
    }
  }

  /** La alimentación pertenece al módulo: también apaga chips auxiliares como su EEPROM. */
  actualizarAlimentacion(porInstancia: Readonly<Record<string, boolean>>): void {
    if (this.apagado) return;
    for (const c of this.chips) {
      const on = porInstancia[c.instancia];
      if (!Object.hasOwn(porInstancia, c.instancia) || typeof on !== 'boolean') continue;
      c.alimentado = on;
      for (const bus of [...this.i2c.values(), ...this.spi.values()]) bus.ponerAlimentacion(c.id, on);
    }
  }

  /** Cambió el entorno de un chip (lo movió el usuario). */
  ponerEntorno(id: string, valores: Record<string, number>): void {
    for (const b of [...this.i2c.values(), ...this.spi.values()]) b.ponerEntorno(id, valores);
  }

  /** Se corta la alimentación: cada chip guarda lo último (la hora del RTC). */
  apagar(): void {
    if (this.apagado) return;
    for (const b of [...this.i2c.values(), ...this.spi.values()]) b.apagar();
    this.apagado = true;
  }

  /** Una llamada de MicroPython (writeto, readfrom_mem...): sus segmentos, con START repetido entre ellos. */
  private transaccionI2c(pines: string, hz: number, ops: string): string {
    const bus = this.i2c.get(pines);
    const res: string[] = [];
    if (bus) bus.velocidad(hz);
    for (const op of ops.split(';').filter(Boolean)) {
      if (op === 'P') { bus?.parada(); continue; }
      const [cab, dato = ''] = op.split(':');
      const dir = parseInt(cab!.slice(1), 16);
      const escritura = cab![0] === 'W';
      if (!bus) { res.push('N'); break; }
      bus.inicio();
      if (!bus.conectar(dir, escritura)) {
        bus.parada();
        res.push('N');
        break;
      }
      if (escritura) {
        let acks = 0;
        for (const b of Buffer.from(dato, 'base64')) { if (!bus.escribirByte(b)) break; acks++; }
        res.push(String(acks));
      } else {
        const n = num(dato);
        res.push(Buffer.from(Array.from({ length: n }, (_, i) => bus.leerByte(i < n - 1))).toString('base64'));
      }
    }
    return res.join(';');
  }

  /** El reloj del ESP32 llegó a `crudo` (ticks_us): corren los despertadores pendientes hasta ahí. */
  private avanzar(crudo: number): void {
    const hasta = this.ultimoCrudo === null ? Math.max(this.t, crudo) : this.t + ((crudo - this.ultimoCrudo + VUELTA_TICKS) % VUELTA_TICKS);
    this.ultimoCrudo = crudo;
    // Cada despertador corre en SU instante (como en el Uno), no en el de la línea que llegó.
    for (;;) {
      this.agenda.sort((a, b) => a.t - b.t);
      const prox = this.agenda[0];
      if (!prox || prox.t > hasta) break;
      this.agenda.shift();
      this.t = Math.max(this.t, prox.t);
      prox.fn();
    }
    this.t = hasta;
  }
}

function num(x: string | undefined): number {
  const n = Number(x);
  if (x === undefined || !Number.isFinite(n)) throw new Error(`número inválido: ${x}`);
  return n;
}
