import { AgendaTemporal, ErrorAgenda, type EstadoAgenda, type EventoTemporal, type TokenTemporal, type ValorParametroComponente } from '@emu/shared';
import type { ReferenciaComponente } from '@emu/shared';
import { CatalogoComponentes } from './catalogo.js';
import { elaborarComponente, validarParametrosComponente, type GrafoComponentes, type InstanciaElaborada, type OpcionesElaboracion } from './elaboracion.js';
import { analizarGrafoElaboradoDc, type ResultadoGrafoDc } from './electrico.js';
import { PaquetesComponentes } from './paquetes.js';

export interface ContextoModeloTemporal {
  readonly ahoraPs: bigint;
  readonly ruta: readonly string[];
  readonly parametros: Readonly<Record<string, ValorParametroComponente>>;
  programarEn(instantePs: bigint, tipo: string, datos?: EventoTemporal['datos'], fase?: 'entrada' | 'modelo' | 'observacion'): TokenTemporal;
  cancelar(token: TokenTemporal): boolean;
  ponerParametro(nombre: string, valor: ValorParametroComponente): void;
  leerTension(ruta: readonly string[], puerto: string): number;
}
/** Adaptadores TypeScript de confianza. La fábrica produce estado nuevo por hoja y reinicio. */
export interface ModeloTemporalComponente {
  iniciar?(contexto: ContextoModeloTemporal): void;
  evento(contexto: ContextoModeloTemporal, evento: EventoTemporal): void | Promise<void>;
}
export interface OpcionesSimulacionTemporal extends OpcionesElaboracion {
  crearModelo?: (instancia: InstanciaElaborada) => ModeloTemporalComponente | undefined;
  resolver?: typeof analizarGrafoElaboradoDc;
  limitesAgenda?: Partial<{ pendientes: number; eventosPorAvance: number }>;
  maxBarrerasPorAvance?: number;
}
export interface MedicionTemporal { instantePs: bigint; dc: Extract<ResultadoGrafoDc, { resuelto: true }> }
export interface FalloTemporal { instantePs: bigint; ruta?: string[]; mensaje: string; dc?: ResultadoGrafoDc }
const clave = (ruta: readonly string[]): string => JSON.stringify(ruta);
const BARRERA = '$barrera-dc';

/** Coordinación cuasiestática: eventos comunes y puntos DC; no integra transitorios analógicos. */
export class SimulacionTemporalComponentes {
  private readonly agenda: AgendaTemporal;
  private readonly original: GrafoComponentes;
  private grafo: GrafoComponentes;
  private readonly modelos = new Map<string, ModeloTemporalComponente>();
  private readonly instancias = new Map<string, InstanciaElaborada>();
  private barreras = new Set<bigint>();
  private medida: MedicionTemporal | null = null;
  private fallo: FalloTemporal | null = null;
  private readonly crearModelo: NonNullable<OpcionesSimulacionTemporal['crearModelo']>;
  private readonly resolver: typeof analizarGrafoElaboradoDc;
  private readonly maxBarreras: number;
  private enCurso = false;

  constructor(private readonly catalogo: CatalogoComponentes, referencia: ReferenciaComponente, private readonly paquetes: PaquetesComponentes, opciones: OpcionesSimulacionTemporal = {}) {
    this.original = elaborarComponente(catalogo, referencia, opciones);
    this.grafo = structuredClone(this.original);
    this.agenda = new AgendaTemporal(this.grafo.instancias.map(i => i.ruta), opciones.limitesAgenda);
    this.crearModelo = opciones.crearModelo ?? (() => undefined);
    this.resolver = opciones.resolver ?? analizarGrafoElaboradoDc;
    this.maxBarreras = opciones.maxBarrerasPorAvance ?? 100;
    if (!Number.isSafeInteger(this.maxBarreras) || this.maxBarreras < 1 || this.maxBarreras > 1000) throw new ErrorAgenda('Presupuesto de barreras inválido');
    this.inicializar();
  }
  get ahoraPs(): bigint { return this.agenda.ahoraPs; }
  get estado(): EstadoAgenda { return this.agenda.estado; }
  get pendientes(): number { return this.agenda.pendientes; }
  get resultado(): MedicionTemporal | null { return structuredClone(this.medida); }
  get ultimoFallo(): FalloTemporal | null { return structuredClone(this.fallo); }
  get grafoActual(): GrafoComponentes { return structuredClone(this.grafo); }

  private inicializar(): void {
    this.instancias.clear(); this.modelos.clear(); this.barreras.clear(); this.medida = null; this.fallo = null;
    try {
      for (const i of this.grafo.instancias) {
        this.instancias.set(clave(i.ruta), i);
        if (i.tipo !== 'hoja-legada') continue;
        const modelo = this.crearModelo(structuredClone(i));
        if (modelo) this.modelos.set(clave(i.ruta), modelo);
      }
      this.solicitarBarrera();
      for (const i of this.grafo.instancias) {
        const modelo = this.modelos.get(clave(i.ruta));
        if (!modelo?.iniciar) continue;
        const contexto = this.contexto(i, 'modelo', () => true);
        try {
          const retorno: unknown = modelo.iniciar(contexto.api);
          if (retorno !== undefined) throw new ErrorAgenda('La inicialización debe ser síncrona y no devolver datos', i.ruta);
        } finally { contexto.cerrar(); }
      }
    } catch (error) { this.agenda.detener(); throw error; }
  }
  private solicitarBarrera(): void {
    const instantePs = this.ahoraPs;
    if (this.barreras.has(instantePs)) return;
    this.agenda.programar({ ruta: [], instantePs, fase: 'electrico', tipo: BARRERA });
    this.barreras.add(instantePs);
  }
  programar(evento: EventoTemporal): TokenTemporal {
    if (evento.fase === 'electrico' || evento.tipo === BARRERA) throw new ErrorAgenda('La fase eléctrica pertenece al coordinador', evento.ruta);
    if (!this.modelos.has(clave(evento.ruta))) throw new ErrorAgenda('La hoja activa no tiene adaptador temporal', evento.ruta);
    return this.agenda.programar(evento);
  }
  private contexto(instancia: InstanciaElaborada, fase: EventoTemporal['fase'], vigente: () => boolean) {
    let abierto = true;
    const comprobar = (): void => {
      if (!abierto || !vigente() || this.estado === 'detenida' || this.estado === 'fallida') throw new ErrorAgenda('Contexto temporal vencido', instancia.ruta);
    };
    const api: ContextoModeloTemporal = {
      ahoraPs: this.ahoraPs, ruta: Object.freeze([...instancia.ruta]), parametros: Object.freeze({ ...instancia.parametros }),
      programarEn: (instantePs, tipo, datos, fase = 'modelo') => {
        comprobar();
        const token = this.programar({ ruta: [...instancia.ruta], instantePs, tipo, datos, fase });
        return token;
      },
      cancelar: token => { comprobar(); return this.agenda.cancelar(token, instancia.ruta); },
      ponerParametro: (nombre, valor) => {
        comprobar();
        if (fase !== 'entrada' && fase !== 'modelo') throw new ErrorAgenda('Una fase de observación no puede modificar el circuito', instancia.ruta);
        const valores = validarParametrosComponente(this.catalogo.resolver(instancia.definicion), { ...instancia.parametros, [nombre]: valor }, instancia.ruta);
        if (Object.is(instancia.parametros[nombre], valores[nombre])) return;
        // Reservar capacidad antes de cambiar el estado; una cola llena no deja cambios sin barrera.
        this.solicitarBarrera(); instancia.parametros = valores; this.medida = null;
      },
      leerTension: (ruta, puerto) => {
        comprobar();
        if (!this.medida) throw new ErrorAgenda('Sin medidas eléctricas válidas: barrera pendiente o fallida', instancia.ruta);
        const t = this.medida.dc.tensiones.find(t => clave(t.ruta) === clave(ruta) && t.puerto === puerto);
        if (typeof t?.voltios !== 'number') throw new ErrorAgenda('Terminal sin tensión resuelta', ruta);
        return t.voltios;
      },
    };
    return { api, cerrar: () => { abierto = false; } };
  }
  pausar(): void { this.agenda.pausar(); }
  reanudar(): void { this.agenda.reanudar(); }
  cancelarSubarbol(ruta: readonly string[]): void {
    this.agenda.cancelarSubarbol(ruta);
    if (!ruta.length) {
      this.barreras.clear();
      // Cancelar eventos no cambia el circuito. Reponer solo una barrera que aún haga falta.
      if (this.medida === null && (this.estado === 'activa' || this.estado === 'pausada')) this.solicitarBarrera();
    }
  }
  detener(): void { this.agenda.detener(); this.barreras.clear(); this.medida = null; }
  reiniciar(): void {
    this.agenda.reiniciar(); this.grafo = structuredClone(this.original); this.inicializar();
  }
  async avanzarHasta(horizontePs: bigint): Promise<void> {
    if (this.enCurso) throw new ErrorAgenda('Hay un avance en curso');
    this.enCurso = true;
    let barreras = 0;
    try {
      await this.agenda.avanzarHasta(horizontePs, async (e, contexto) => {
        if (e.tipo === BARRERA) {
          this.barreras.delete(e.instantePs);
          this.medida = null;
          if (++barreras > this.maxBarreras) throw new ErrorAgenda('Presupuesto de barreras por avance excedido');
          let dc: ResultadoGrafoDc;
          try { dc = await this.resolver(this.catalogo, structuredClone(this.grafo), this.paquetes); }
          catch (error) { if (!contexto.vigente()) return; throw error; }
          if (!contexto.vigente()) return;
          const invalido = dc.resuelto && (!dc.elementos.length || !dc.tensiones.length ||
            dc.elementos.some(e => ![e.va, e.vb, e.i, e.p].every(Number.isFinite)) ||
            dc.tensiones.some(t => t.voltios !== null && !Number.isFinite(t.voltios)));
          if (!dc.resuelto || invalido) {
            const fallo: ResultadoGrafoDc = { ...dc, resuelto: false, tensiones: null, elementos: [],
              diagnosticos: invalido ? [...dc.diagnosticos, { mensaje: 'Barrera con medidas vacías o no finitas', severidad: 'peligro', pin: -1, origenes: [] }] : dc.diagnosticos };
            this.fallo = { instantePs: e.instantePs, mensaje: 'Barrera eléctrica sin resolver', dc: fallo };
            throw new ErrorAgenda('Barrera eléctrica sin resolver');
          }
          this.medida = { instantePs: e.instantePs, dc: structuredClone(dc) };
          return;
        }
        const i = this.instancias.get(clave(e.ruta)), modelo = this.modelos.get(clave(e.ruta));
        if (!i || !modelo) throw new ErrorAgenda('Modelo temporal ausente', e.ruta);
        const c = this.contexto(i, e.fase, contexto.vigente);
        try { await modelo.evento(c.api, e); }
        catch (error) {
          if (contexto.vigente()) {
            const mensaje = error instanceof Error ? error.message : String(error);
            this.fallo = { instantePs: e.instantePs, ruta: [...e.ruta], mensaje };
            throw new ErrorAgenda(mensaje, e.ruta);
          }
        }
        finally { c.cerrar(); }
      });
    } catch (error) {
      if (this.estado === 'fallida' || this.estado === 'detenida') {
        this.medida = null;
        this.fallo ??= { instantePs: this.ahoraPs, mensaje: error instanceof Error ? error.message : String(error) };
      }
      throw error;
    } finally { this.enCurso = false; }
  }
}
