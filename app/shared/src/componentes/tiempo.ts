import { z } from 'zod';

/** Unidad común: picosegundos enteros; no depende del reloj del host. */
export const PS_POR_SEGUNDO = 1_000_000_000_000n;
export const MAX_TIEMPO_PS = (1n << 127n) - 1n;
export const FASES_TEMPORALES = ['entrada', 'modelo', 'electrico', 'observacion'] as const;
const Ruta = z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(16);
const Tiempo = z.bigint().min(0n).max(MAX_TIEMPO_PS);
const EventoSchema = z.object({
  ruta: Ruta, instantePs: Tiempo, fase: z.enum(FASES_TEMPORALES),
  tipo: z.string().min(1).max(80),
  datos: z.record(z.string().min(1).max(40), z.union([z.string().max(500), z.number().finite(), z.boolean()]))
    .refine(d => Object.keys(d).length <= 16).optional(),
}).strict();
export type EventoTemporal = z.infer<typeof EventoSchema>;
export interface TokenTemporal { readonly secuencia: bigint }
interface Entrada { evento: EventoTemporal; token: TokenTemporal }
export type EstadoAgenda = 'activa' | 'pausada' | 'detenida' | 'fallida';
export interface ContextoDespacho { vigente(): boolean }
export const LIMITES_AGENDA = { pendientes: 10_000, eventosPorAvance: 100_000 } as const;
type LimitesAgenda = { [K in keyof typeof LIMITES_AGENDA]: number };
const clave = (ruta: readonly string[]): string => JSON.stringify(ruta);
const descendiente = (ruta: readonly string[], padre: readonly string[]): boolean => padre.every((p, i) => ruta[i] === p);

export class ErrorAgenda extends Error {
  override readonly name = 'ErrorAgenda';
  readonly ruta: readonly string[];
  constructor(mensaje: string, ruta: readonly string[] = []) { super(`${mensaje} (ruta: ${clave(ruta)})`); this.ruta = [...ruta]; }
}

/** Cola acotada ordenada; las cancelaciones retiran entradas, sin acumular tombstones. */
export class AgendaTemporal {
  private cola: Entrada[] = [];
  private secuencia = 0n;
  private instante = 0n;
  private fase = -1;
  private situacion: EstadoAgenda = 'activa';
  private enCurso = false;
  private epoca = 0n;
  private readonly generaciones = new Map<string, bigint>();
  private readonly rutas: string[][];
  private readonly limites: LimitesAgenda;

  constructor(rutas: readonly (readonly string[])[], limites: Partial<LimitesAgenda> = {}) {
    if (!rutas.length || rutas.length > 2000) throw new ErrorAgenda('Cantidad de propietarios inválida');
    this.rutas = rutas.map(r => Ruta.parse(r));
    for (const ruta of this.rutas) {
      if (this.generaciones.has(clave(ruta))) throw new ErrorAgenda('Propietario duplicado', ruta);
      this.generaciones.set(clave(ruta), 0n);
    }
    this.limites = { ...LIMITES_AGENDA, ...limites };
    for (const [k, max] of Object.entries(LIMITES_AGENDA)) {
      const n = this.limites[k as keyof LimitesAgenda];
      if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new ErrorAgenda(`Presupuesto inválido: ${k}`);
    }
  }
  get ahoraPs(): bigint { return this.instante; }
  get estado(): EstadoAgenda { return this.situacion; }
  get pendientes(): number { return this.cola.length; }
  get proximoPs(): bigint | null { return this.cola[0]?.evento.instantePs ?? null; }

  programar(entrada: EventoTemporal): TokenTemporal {
    if (this.situacion === 'detenida' || this.situacion === 'fallida') throw new ErrorAgenda('Agenda no ejecutable');
    const evento = EventoSchema.parse(entrada), fase = FASES_TEMPORALES.indexOf(evento.fase);
    if (!this.generaciones.has(clave(evento.ruta))) throw new ErrorAgenda('Propietario inexistente o inactivo', evento.ruta);
    if (evento.instantePs < this.instante || (evento.instantePs === this.instante && fase < this.fase)) throw new ErrorAgenda('Evento en el pasado o en una fase ya cerrada', evento.ruta);
    if (this.cola.length >= this.limites.pendientes) throw new ErrorAgenda('Presupuesto de eventos pendientes excedido', evento.ruta);
    const nueva: Entrada = { evento, token: Object.freeze({ secuencia: this.secuencia++ }) };
    let inferior = 0, superior = this.cola.length;
    while (inferior < superior) {
      const medio = (inferior + superior) >>> 1, anterior = this.cola[medio];
      if (!anterior) throw new ErrorAgenda('Cola inconsistente');
      const a = anterior.evento;
      const antes = a.instantePs < evento.instantePs || (a.instantePs === evento.instantePs && FASES_TEMPORALES.indexOf(a.fase) <= fase);
      if (antes) inferior = medio + 1; else superior = medio;
    }
    this.cola.splice(inferior, 0, nueva);
    return nueva.token;
  }
  cancelar(token: TokenTemporal, propietario?: readonly string[]): boolean {
    const i = this.cola.findIndex(e => e.token === token && (propietario === undefined || clave(e.evento.ruta) === clave(propietario)));
    if (i < 0) return false;
    this.cola.splice(i, 1); return true;
  }
  cancelarSubarbol(ruta: readonly string[]): void {
    if (!this.generaciones.has(clave(ruta))) throw new ErrorAgenda('Propietario inexistente', ruta);
    for (const r of this.rutas) if (descendiente(r, ruta)) {
      const k = clave(r); this.generaciones.set(k, (this.generaciones.get(k) ?? 0n) + 1n);
    }
    this.cola = this.cola.filter(e => !descendiente(e.evento.ruta, ruta));
  }
  pausar(): void { if (this.situacion === 'activa') this.situacion = 'pausada'; }
  reanudar(): void {
    if (this.situacion !== 'pausada') throw new ErrorAgenda('Solo se puede reanudar una agenda pausada');
    this.situacion = 'activa';
  }
  detener(): void { this.epoca++; this.cola = []; this.situacion = 'detenida'; }
  reiniciar(): void {
    if (this.enCurso) throw new ErrorAgenda('Hay un avance en curso');
    this.epoca++; this.cola = []; this.instante = 0n; this.fase = -1; this.situacion = 'activa';
  }

  async avanzarHasta(horizontePs: bigint, despachar: (evento: EventoTemporal, contexto: ContextoDespacho) => void | Promise<void>): Promise<void> {
    if (this.enCurso) throw new ErrorAgenda('Hay un avance en curso');
    Tiempo.parse(horizontePs);
    if (horizontePs < this.instante) throw new ErrorAgenda('Horizonte en el pasado');
    if (this.situacion === 'detenida' || this.situacion === 'fallida') throw new ErrorAgenda('Agenda no ejecutable');
    if (this.situacion === 'pausada') return;
    this.enCurso = true;
    let ejecutados = 0;
    try {
      while (this.situacion === 'activa') {
        const siguiente = this.cola[0];
        if (!siguiente || siguiente.evento.instantePs > horizontePs) break;
        if (ejecutados++ >= this.limites.eventosPorAvance) throw new ErrorAgenda('Presupuesto de eventos por avance excedido', siguiente.evento.ruta);
        this.cola.shift();
        const e = siguiente.evento;
        if (e.instantePs !== this.instante) this.fase = -1;
        this.instante = e.instantePs; this.fase = FASES_TEMPORALES.indexOf(e.fase);
        const epoca = this.epoca, generacion = this.generaciones.get(clave(e.ruta));
        await despachar(structuredClone(e), { vigente: () => this.epoca === epoca && this.generaciones.get(clave(e.ruta)) === generacion && this.situacion !== 'fallida' && this.situacion !== 'detenida' });
      }
      if (this.situacion === 'activa' && horizontePs > this.instante) { this.instante = horizontePs; this.fase = -1; }
    } catch (error) {
      if (this.estado !== 'detenida') { this.situacion = 'fallida'; this.epoca++; this.cola = []; }
      throw error;
    } finally { this.enCurso = false; }
  }
}

const mcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };
/** Conserva la fracción de picosegundo incluso al cambiar frecuencia, sin usar float. */
export class RelojComponente {
  private hz: bigint;
  private numerador = 0n;
  private denominador = 1n;
  constructor(hz: bigint) { this.hz = this.validarFrecuencia(hz); }
  private validarFrecuencia(hz: bigint): bigint {
    if (typeof hz !== 'bigint' || hz < 1n || hz > PS_POR_SEGUNDO) throw new ErrorAgenda('Frecuencia fuera de 1 Hz–1 THz');
    return hz;
  }
  cambiarFrecuencia(hz: bigint): void { this.hz = this.validarFrecuencia(hz); }
  avanzarTicks(ticks: bigint): bigint {
    Tiempo.parse(ticks);
    const n = this.numerador * this.hz + ticks * PS_POR_SEGUNDO * this.denominador;
    const d = this.denominador * this.hz, enteros = n / d, resto = n % d;
    if (enteros > MAX_TIEMPO_PS) throw new ErrorAgenda('Intervalo de reloj excedido');
    const divisor = mcd(resto, d), denominador = d / divisor;
    if (denominador.toString(2).length > 4096) throw new ErrorAgenda('Presupuesto de precisión racional excedido');
    this.numerador = resto / divisor; this.denominador = denominador;
    return enteros;
  }
}
