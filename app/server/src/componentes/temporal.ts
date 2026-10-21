import { AgendaTemporal, ErrorAgenda, MAX_TIEMPO_PS, type EstadoAgenda, type EventoTemporal, type TokenTemporal, type ValorParametroComponente, type NivelDigital, type DriveDigital, type PerfilDigital, type ContextoDespacho } from '@emu/shared';
import type { ReferenciaComponente } from '@emu/shared';
import { CatalogoComponentes } from './catalogo.js';
import { elaborarComponente, validarParametrosComponente, type GrafoComponentes, type InstanciaElaborada, type OpcionesElaboracion } from './elaboracion.js';
import { analizarGrafoElaboradoDc, type ResultadoGrafoDc } from './electrico.js';
import { PaquetesComponentes } from './paquetes.js';
import { leerEstadoDigital, type EstadoDigitalComponente, type CambioEntradaDigital } from './digital.js';
import { EnrutadorIrq, type CambioEntradaIrq, type EntregaIrq } from './irq.js';

export interface ContextoModeloTemporal {
  readonly ahoraPs: bigint;
  readonly ruta: readonly string[];
  readonly parametros: Readonly<Record<string, ValorParametroComponente>>;
  programarEn(instantePs: bigint, tipo: string, datos?: EventoTemporal['datos'], fase?: 'entrada' | 'modelo' | 'observacion'): TokenTemporal;
  cancelar(token: TokenTemporal): boolean;
  ponerParametro(nombre: string, valor: ValorParametroComponente): void;
  leerTension(ruta: readonly string[], puerto: string): number;
  leerDigital(puerto: string): NivelDigital;
  escribirDigital(puerto: string, nivel: DriveDigital): void;
  leerIrq(puerto: string): NivelDigital;
  escribirIrq(puerto: string, nivel: NivelDigital): void;
}
/** Adaptadores TypeScript de confianza. La fábrica produce estado nuevo por hoja y reinicio. */
export interface ModeloTemporalComponente {
  iniciar?(contexto: ContextoModeloTemporal): void;
  entradaDigital?(contexto: ContextoModeloTemporal, cambio: CambioEntradaDigital): void | Promise<void>;
  entradaIrq?(contexto: ContextoModeloTemporal, cambio: CambioEntradaIrq): void | Promise<void>;
  evento(contexto: ContextoModeloTemporal, evento: EventoTemporal): void | Promise<void>;
}
export interface OpcionesSimulacionTemporal extends OpcionesElaboracion {
  crearModelo?: (instancia: InstanciaElaborada) => ModeloTemporalComponente | undefined;
  resolver?: typeof analizarGrafoElaboradoDc;
  limitesAgenda?: Partial<{ pendientes: number; eventosPorAvance: number }>;
  maxBarrerasPorAvance?: number;
  retardoIrqPs?: bigint;
}
export interface MedicionTemporal { instantePs: bigint; dc: Extract<ResultadoGrafoDc, { resuelto: true }> }
export interface FalloTemporal { instantePs: bigint; ruta?: string[]; mensaje: string; dc?: ResultadoGrafoDc }
const clave = (ruta: readonly string[]): string => JSON.stringify(ruta);
const BARRERA = '$barrera-dc';
const INICIO_DIGITAL = '$digital:inicio', ENTRADA_DIGITAL = '$digital:entrada';
const ENTRADA_IRQ = '$irq:entrada';

/** Coordinación cuasiestática: eventos comunes y puntos DC; no integra transitorios analógicos. */
export class SimulacionTemporalComponentes {
  private readonly agenda: AgendaTemporal;
  private readonly original: GrafoComponentes;
  private grafo: GrafoComponentes;
  private irq: EnrutadorIrq;
  private readonly retardoIrq: bigint;
  private readonly entregasIrq = new Map<string, { entrega: EntregaIrq; token: TokenTemporal }>();
  private siguienteIrq = 0n;
  private readonly modelos = new Map<string, ModeloTemporalComponente>();
  private readonly instancias = new Map<string, InstanciaElaborada>();
  private barreras = new Set<bigint>();
  private readonly perfiles = new Map<string, { instancia: InstanciaElaborada; perfil: PerfilDigital }>();
  private readonly digitales = new Map<string, EstadoDigitalComponente>();
  private readonly reiniciosDigitales = new Set<string>();
  private medida: MedicionTemporal | null = null;
  private fallo: FalloTemporal | null = null;
  private readonly crearModelo: NonNullable<OpcionesSimulacionTemporal['crearModelo']>;
  private readonly resolver: typeof analizarGrafoElaboradoDc;
  private readonly maxBarreras: number;
  private enCurso = false;

  constructor(private readonly catalogo: CatalogoComponentes, referencia: ReferenciaComponente, private readonly paquetes: PaquetesComponentes, opciones: OpcionesSimulacionTemporal = {}) {
    this.original = elaborarComponente(catalogo, referencia, opciones);
    this.grafo = structuredClone(this.original);
    this.irq = new EnrutadorIrq(this.grafo);
    this.retardoIrq = opciones.retardoIrqPs ?? 1n;
    if (typeof this.retardoIrq !== 'bigint' || this.retardoIrq < 1n || this.retardoIrq > MAX_TIEMPO_PS) throw new ErrorAgenda('Retardo IRQ inválido');
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
  get estadosDigitales(): EstadoDigitalComponente[] | null { return this.medida ? structuredClone([...this.digitales.values()]) : null; }
  get ultimoFallo(): FalloTemporal | null { return structuredClone(this.fallo); }
  get grafoActual(): GrafoComponentes { return structuredClone(this.grafo); }

  private inicializar(): void {
    this.entregasIrq.clear();
    this.perfiles.clear(); this.digitales.clear(); this.reiniciosDigitales.clear();
    this.instancias.clear(); this.modelos.clear(); this.barreras.clear(); this.medida = null; this.fallo = null;
    try {
      for (const i of this.grafo.instancias) {
        this.instancias.set(clave(i.ruta), i);
        if (i.tipo !== 'hoja-legada') continue;
        const def = this.catalogo.resolver(i.definicion);
        if (def.tipo === 'hoja-legada' && def.perfilDigital) {
          this.perfiles.set(clave(i.ruta), { instancia: i, perfil: def.perfilDigital });
          for (const salida of Object.values(def.perfilDigital.salidas)) i.parametros[salida.parametro] = 'Z';
          continue;
        }
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
      for (const i of this.grafo.instancias) if (this.modelos.has(clave(i.ruta))) this.programarIrq(this.irq.sincronizar(i.ruta, this.ahoraPs));
    } catch (error) { this.agenda.detener(); this.entregasIrq.clear(); throw error; }
  }
  private solicitarBarrera(): void {
    const instantePs = this.ahoraPs;
    if (this.barreras.has(instantePs)) return;
    this.agenda.programar({ ruta: [], instantePs, fase: 'electrico', tipo: BARRERA });
    this.barreras.add(instantePs);
  }
  programar(evento: EventoTemporal): TokenTemporal {
    if (evento.fase === 'electrico' || evento.tipo === BARRERA || evento.tipo.startsWith('$digital:') || evento.tipo.startsWith('$irq:')) throw new ErrorAgenda('La fase eléctrica y las notificaciones internas pertenecen al coordinador', evento.ruta);
    if (this.perfiles.has(clave(evento.ruta)) && this.digitales.get(clave(evento.ruta))?.estado !== 'activo') throw new ErrorAgenda('La hoja digital no está operativa', evento.ruta);
    if (!this.modelos.has(clave(evento.ruta))) throw new ErrorAgenda('La hoja activa no tiene adaptador temporal', evento.ruta);
    return this.agenda.programar(evento);
  }
  private programarIrq(entregas: EntregaIrq[]): void {
    for (const e of entregas) {
      const id = (this.siguienteIrq++).toString();
      const token = this.agenda.programar({ ruta: e.ruta, instantePs: e.emisionPs + this.retardoIrq,
        fase: 'modelo', tipo: ENTRADA_IRQ, datos: { id, puerto: e.puerto, nivel: String(e.nivel), emisionPs: e.emisionPs.toString(), origen: e.origen, generacion: e.generacion } });
      this.entregasIrq.set(id, { entrega: e, token });
    }
  }
  private retirarIrq(ruta: readonly string[]): void {
    for (const [id, { entrega, token }] of this.entregasIrq) {
      if (ruta.every((p, i) => entrega.ruta[i] === p) || !this.irq.vigente(entrega)) {
        this.agenda.cancelar(token); this.entregasIrq.delete(id);
      }
    }
  }
  private contexto(instancia: InstanciaElaborada, fase: EventoTemporal['fase'], vigente: () => boolean) {
    let abierto = true;
    const comprobar = (): void => {
      if (!abierto || !vigente() || this.estado === 'detenida' || this.estado === 'fallida') throw new ErrorAgenda('Contexto temporal vencido', instancia.ruta);
    };
    const aplicarParametro = (nombre: string, valor: ValorParametroComponente): void => {
      comprobar();
      if (fase !== 'entrada' && fase !== 'modelo') throw new ErrorAgenda('Una fase de observación no puede modificar el circuito', instancia.ruta);
      const valores = validarParametrosComponente(this.catalogo.resolver(instancia.definicion), { ...instancia.parametros, [nombre]: valor }, instancia.ruta);
      if (Object.is(instancia.parametros[nombre], valores[nombre])) return;
      this.solicitarBarrera(); instancia.parametros = valores; this.medida = null;
    };
    const perfil = this.perfiles.get(clave(instancia.ruta))?.perfil;
    const api: ContextoModeloTemporal = {
      ahoraPs: this.ahoraPs, ruta: Object.freeze([...instancia.ruta]), parametros: Object.freeze({ ...instancia.parametros }),
      programarEn: (instantePs, tipo, datos, fase = 'modelo') => {
        comprobar();
        const token = this.programar({ ruta: [...instancia.ruta], instantePs, tipo, datos, fase });
        return token;
      },
      cancelar: token => { comprobar(); return this.agenda.cancelar(token, instancia.ruta); },
      leerIrq: puerto => { comprobar(); return this.irq.leer(instancia.ruta, puerto); },
      escribirIrq: (puerto, nivel) => {
        comprobar();
        if (fase !== 'entrada' && fase !== 'modelo') throw new ErrorAgenda('Una observación no puede emitir IRQ', instancia.ruta);
        if (perfil && this.digitales.get(clave(instancia.ruta))?.estado !== 'activo') throw new ErrorAgenda('La hoja digital no está operativa', instancia.ruta);
        this.programarIrq(this.irq.escribir(instancia.ruta, puerto, nivel, this.ahoraPs));
      },
      ponerParametro: (nombre, valor) => {
        comprobar();
        if (perfil && Object.values(perfil.salidas).some(s => s.parametro === nombre)) throw new ErrorAgenda('El drive digital se modifica mediante escribirDigital', instancia.ruta);
        aplicarParametro(nombre, valor);
      },
      escribirDigital: (puerto, nivel) => {
        comprobar();
        const salida = perfil && Object.hasOwn(perfil.salidas, puerto) ? perfil.salidas[puerto] : undefined;
        if (!salida || ![0, 1, 'Z'].includes(nivel)) throw new ErrorAgenda('Salida o drive digital inválido', instancia.ruta);
        if (this.digitales.get(clave(instancia.ruta))?.estado !== 'activo') throw new ErrorAgenda('La hoja digital no está operativa', instancia.ruta);
        aplicarParametro(salida.parametro, String(nivel));
      },
      leerDigital: puerto => {
        comprobar();
        if (!this.medida) throw new ErrorAgenda('Sin medidas eléctricas válidas para leer digital', instancia.ruta);
        const entradas = this.digitales.get(clave(instancia.ruta))?.entradas;
        if (!entradas || !Object.hasOwn(entradas, puerto)) throw new ErrorAgenda('Entrada digital no declarada', instancia.ruta);
        return entradas[puerto] ?? 'X';
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
  private actualizarDigitales(dc: Extract<ResultadoGrafoDc, { resuelto: true }>): boolean {
    let cambioElectrico = false;
    for (const [k, { instancia, perfil }] of this.perfiles) {
      const siguiente = leerEstadoDigital(perfil, instancia.ruta, dc), anterior = this.digitales.get(k);
      if (anterior?.estado !== siguiente.estado) {
        this.agenda.cancelarSubarbol(instancia.ruta);
        const entregas = this.irq.invalidar(instancia.ruta, this.ahoraPs);
        this.retirarIrq(instancia.ruta); this.programarIrq(entregas);
        this.modelos.delete(k); this.reiniciosDigitales.add(k);
      }
      this.digitales.set(k, siguiente);
      if (siguiente.estado === 'activo') continue;
      const valores = { ...instancia.parametros };
      let modificado = false;
      for (const salida of Object.values(perfil.salidas)) if (valores[salida.parametro] !== 'Z') { valores[salida.parametro] = 'Z'; modificado = true; }
      if (modificado) {
        instancia.parametros = validarParametrosComponente(this.catalogo.resolver(instancia.definicion), valores, instancia.ruta);
        cambioElectrico = true;
      }
    }
    return cambioElectrico;
  }
  private notificarDigitales(anteriores: Map<string, EstadoDigitalComponente>): void {
    for (const [k, { instancia, perfil }] of this.perfiles) {
      const actual = this.digitales.get(k);
      if (actual?.estado !== 'activo') continue;
      const instantePs = this.ahoraPs + BigInt(perfil.retardoPs), reiniciar = this.reiniciosDigitales.has(k);
      if (reiniciar) this.agenda.programar({ ruta: [...instancia.ruta], instantePs, fase: 'modelo', tipo: INICIO_DIGITAL });
      for (const [puerto, nivel] of Object.entries(actual.entradas)) {
        const anterior = anteriores.get(k)?.entradas[puerto] ?? 'X';
        if (!reiniciar && anterior === nivel) continue;
        this.agenda.programar({ ruta: [...instancia.ruta], instantePs, fase: 'modelo', tipo: ENTRADA_DIGITAL,
          datos: { puerto, anterior: String(anterior), actual: String(nivel), muestraPs: this.ahoraPs.toString() } });
      }
    }
    this.reiniciosDigitales.clear();
  }
  pausar(): void { this.agenda.pausar(); }
  reanudar(): void { this.agenda.reanudar(); }
  cancelarSubarbol(ruta: readonly string[]): void {
    this.agenda.cancelarSubarbol(ruta);
    const entregas = this.irq.invalidar(ruta, this.ahoraPs);
    this.retirarIrq(ruta);
    if (this.estado === 'activa' || this.estado === 'pausada') this.programarIrq(entregas);
    if (!ruta.length) {
      this.barreras.clear();
      // Cancelar eventos no cambia el circuito. Reponer solo una barrera que aún haga falta.
      if (this.medida === null && (this.estado === 'activa' || this.estado === 'pausada')) this.solicitarBarrera();
    }
  }
  detener(): void { this.agenda.detener(); this.entregasIrq.clear(); this.irq.invalidar([], this.ahoraPs); this.barreras.clear(); this.medida = null; }
  reiniciar(): void {
    this.agenda.reiniciar(); this.grafo = structuredClone(this.original); this.irq = new EnrutadorIrq(this.grafo); this.inicializar();
  }
  async avanzarHasta(horizontePs: bigint): Promise<void> {
    if (this.enCurso) throw new ErrorAgenda('Hay un avance en curso');
    this.enCurso = true;
    let barreras = 0;
    try {
      const despachar = async (e: EventoTemporal, contexto: ContextoDespacho, adelantada = false): Promise<void> => {
        if (e.tipo === ENTRADA_IRQ && typeof e.datos?.id === 'string') this.entregasIrq.delete(e.datos.id);
        if (e.tipo === BARRERA) {
          if (!adelantada) this.barreras.delete(e.instantePs);
          if (this.medida?.instantePs === e.instantePs) return;
          this.medida = null;
          const anteriores = structuredClone(this.digitales);
          for (;;) {
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
            if (this.actualizarDigitales(dc)) continue;
            this.notificarDigitales(anteriores);
            this.medida = { instantePs: e.instantePs, dc: structuredClone(dc) };
            return;
          }
        }
        const i = this.instancias.get(clave(e.ruta));
        if (!i) throw new ErrorAgenda('Instancia temporal ausente', e.ruta);
        if ((this.perfiles.has(clave(e.ruta)) || e.tipo === ENTRADA_IRQ) && !this.medida) {
          // Un cambio anterior del circuito no puede dejar ejecutar un timer sin verificar energía/reset.
          await despachar({ ruta: [], instantePs: e.instantePs, fase: 'electrico', tipo: BARRERA },
            { vigente: this.agenda.capturarVigencia([]) }, true);
          if (!contexto.vigente()) return;
        }
        if (e.tipo === INICIO_DIGITAL) {
          if (this.digitales.get(clave(e.ruta))?.estado !== 'activo') return;
          const nuevo = this.crearModelo(structuredClone(i));
          if (nuevo) this.modelos.set(clave(e.ruta), nuevo);
        }
        const modelo = this.modelos.get(clave(e.ruta));
        if (!modelo && (e.tipo.startsWith('$digital:') || e.tipo === ENTRADA_IRQ)) return;
        if (!modelo) throw new ErrorAgenda('Modelo temporal ausente', e.ruta);
        let entrega: EntregaIrq | undefined;
        if (e.tipo === ENTRADA_IRQ) {
          const d = e.datos;
          if (typeof d?.puerto !== 'string' || typeof d.emisionPs !== 'string' || typeof d.origen !== 'number' || typeof d.generacion !== 'string'
            || !['0', '1', 'X'].includes(String(d.nivel))) throw new ErrorAgenda('Notificación IRQ inválida', e.ruta);
          entrega = { ruta: e.ruta, puerto: d.puerto, emisionPs: BigInt(d.emisionPs), origen: d.origen, generacion: d.generacion,
            nivel: d.nivel === '0' ? 0 : d.nivel === '1' ? 1 : 'X' };
          if (!this.irq.vigente(entrega)) return;
        }
        const recibida = entrega;
        const vigente = () => contexto.vigente() && (!recibida || this.irq.vigente(recibida));
        const c = this.contexto(i, e.fase, vigente);
        try {
          if (e.tipo === INICIO_DIGITAL) {
            const retorno: unknown = modelo.iniciar?.(c.api);
            if (retorno !== undefined) throw new ErrorAgenda('La inicialización debe ser síncrona', e.ruta);
            this.programarIrq(this.irq.sincronizar(i.ruta, this.ahoraPs));
          } else if (e.tipo === ENTRADA_DIGITAL) {
            const nivel = (valor: unknown): NivelDigital => valor === '0' ? 0 : valor === '1' ? 1 : 'X';
            if (typeof e.datos?.puerto !== 'string' || typeof e.datos.muestraPs !== 'string') throw new ErrorAgenda('Notificación digital inválida', e.ruta);
            await modelo.entradaDigital?.(c.api, { puerto: e.datos.puerto, anterior: nivel(e.datos.anterior), actual: nivel(e.datos.actual), instanteMuestraPs: BigInt(e.datos.muestraPs) });
          } else if (entrega) {
            const cambio = this.irq.recibir(entrega);
            if (cambio) await modelo.entradaIrq?.(c.api, cambio);
          } else await modelo.evento(c.api, e);
        }
        catch (error) {
          if (vigente()) {
            const mensaje = error instanceof Error ? error.message : String(error);
            this.fallo = { instantePs: e.instantePs, ruta: [...e.ruta], mensaje };
            throw new ErrorAgenda(mensaje, e.ruta);
          }
        }
        finally { c.cerrar(); }
      };
      await this.agenda.avanzarHasta(horizontePs, despachar);
    } catch (error) {
      if (this.estado === 'fallida' || this.estado === 'detenida') {
        this.entregasIrq.clear();
        this.medida = null;
        this.fallo ??= { instantePs: this.ahoraPs, mensaje: error instanceof Error ? error.message : String(error) };
      }
      throw error;
    } finally { this.enCurso = false; }
  }
}
