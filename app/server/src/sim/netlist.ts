import type { ModeloDiodo, Primitiva } from '@emu/shared';
import type { ResultadoSpice } from './spice.js';
import type { ParametrosTransitorio } from './transitorio.js';
import { MAX_VECTORES_TRANSITORIO, validarCantidadValoresTransitorio } from './validacionSpice.js';
import { ErrorSpice, validarDiagnosticosSpice, validarPrimitivaSpice, valorSpice } from './validacionSpice.js';

/**
 * Arma un netlist de ngspice a partir de elementos físicos (las primitivas de los modelos
 * de módulo y los de la placa) y después lee los resultados por elemento.
 *
 * Convenciones:
 *  - Corriente de un elemento: la que ENTRA por su terminal `a`, lo atraviesa y sale por `b`.
 *    Para medirla, cada elemento que no es una resistencia lleva un "amperímetro" (fuente de
 *    0 V) en serie del lado de `a`. En las resistencias sale exacta de (Va − Vb) / R.
 *  - Potencia: (Va − Vb) · I. Positiva = la disipa; negativa = la entrega (una fuente).
 *  - Tierra: el nodo que el que arma decide (la de la placa, o la de una fuente si no hay
 *    placa) es el "0" de SPICE. Todo nodo tiene además 1 TΩ a tierra (`rshunt`), así un
 *    circuito flotante (una fuente aislada) se resuelve igual en vez de dar matriz singular.
 */

/** Recorte de las fuentes CV/CC: casi ideal (≈3 mV a 100 mA) y con buena convergencia. */
const MODELO_RECORTE = 'D(IS=1e-6 N=0.01)';
const RSERIE_MIN = 1e-3; // ninguna fuente de tensión es ideal: evita lazos de fuentes en paralelo
const RON = 0.05;
const ROFF = 1e9;

export interface ElementoArmado {
  /** Nombre único global: "<dueño>.<local>". */
  id: string;
  dueno: string;
  local: string;
  tipo: Primitiva['tipo'] | 'X';
  /** Nodos SPICE de sus terminales. */
  a: string;
  b: string;
  /** Resistencia equivalente (R, S): la corriente sale de las tensiones. */
  ohms?: number;
  /** Amperímetro en serie (los demás tipos). */
  medidor?: string;
  /** −1 si el amperímetro mide al revés del sentido a→b del elemento. */
  signo?: 1 | -1;
  /** Nodos de control (interruptor controlado por tensión). */
  control?: [string, string];
  /** Condición de habilitación de una salida regulada; no es una unión Vin↔Vout. */
  regulador?: { tierra: string; caida: number };
}

export interface ElementoResuelto {
  id: string;
  dueno: string;
  local: string;
  tipo: ElementoArmado['tipo'];
  a: string;
  b: string;
  va: number;
  vb: number;
  i: number;
  p: number;
  /** Resistencia equivalente (resistencias e interruptores). */
  ohms?: number;
  regulador?: { tierra: string; activo: boolean };
}

const limpio = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_');

export class Netlist {
  private readonly lineas: string[] = [];
  private readonly modelos = new Map<string, string>();
  readonly elementos: ElementoArmado[] = [];
  private cuenta = 0;
  private readonly reactivos = new Map<string, { linea: number; inicial?: number }>();
  private readonly fuentes = new Map<string, { linea: number; limitada: boolean; negativa: boolean }>();
  private readonly resistencias = new Map<string, number>();

  constructor(private readonly titulo: string) {}

  /** Nombre SPICE corto y único para un elemento (ngspice no distingue mayúsculas). */
  private nombre(dueno: string, local: string): string {
    return `${limpio(dueno)}_${limpio(local)}_${++this.cuenta}`.toLowerCase();
  }

  private modeloDiodo(m: ModeloDiodo): string {
    const params = [`IS=${m.is}`, `N=${m.n}`];
    if (m.rs !== undefined) params.push(`RS=${m.rs}`);
    if (m.bv !== undefined) params.push(`BV=${m.bv}`);
    if (m.ibv !== undefined) params.push(`IBV=${m.ibv}`);
    return this.modelo(`D(${params.join(' ')})`);
  }

  /** Nombre de un `.model` (se declara una sola vez por cuerpo). */
  modelo(cuerpo: string): string {
    let n = this.modelos.get(cuerpo);
    if (!n) {
      n = `m${this.modelos.size + 1}`;
      this.modelos.set(cuerpo, n);
    }
    return n;
  }

  /** Un elemento físico entre dos nodos SPICE ya resueltos. */
  agregar(dueno: string, p: Primitiva & { a: string; b: string; cp?: string; cn?: string; tierra?: string }): ElementoArmado {
    validarPrimitivaSpice(p);
    if (this.elementos.some(e => e.id === `${dueno}.${p.nombre}`)) throw new ErrorSpice(`Elemento duplicado: ${dueno}.${p.nombre}`, [], this.texto());
    const n = this.nombre(dueno, p.nombre);
    const el: ElementoArmado = { id: `${dueno}.${p.nombre}`, dueno, local: p.nombre, tipo: p.tipo, a: p.a, b: p.b };
    // Amperímetro en serie para todo lo que no sea una resistencia.
    const conMedidor = (): string => {
      const x = `x_${n}`;
      el.medidor = `vam_${n}`;
      this.lineas.push(`${el.medidor} ${p.a} ${x} DC 0`);
      return x;
    };
    switch (p.tipo) {
      case 'R':
        el.ohms = p.ohms;
        this.resistencias.set(el.id, this.lineas.length);
        this.lineas.push(`r_${n} ${p.a} ${p.b} ${p.ohms}`);
        break;
      case 'S':
        el.ohms = p.cerrado ? (p.ron ?? RON) : (p.roff ?? ROFF);
        this.lineas.push(`r_${n} ${p.a} ${p.b} ${el.ohms}`);
        break;
      case 'C': {
        const x = conMedidor();
        this.reactivos.set(el.id, { linea: this.lineas.length, inicial: p.v0 });
        this.lineas.push(`c_${n} ${x} ${p.b} ${p.faradios}${p.v0 !== undefined ? ` IC=${p.v0}` : ''}`);
        break;
      }
      case 'L': {
        const x = conMedidor();
        this.reactivos.set(el.id, { linea: this.lineas.length, inicial: p.i0 });
        this.lineas.push(`l_${n} ${x} ${p.b} ${p.henrios}${p.i0 !== undefined ? ` IC=${p.i0}` : ''}`);
        break;
      }
      case 'D': {
        const x = conMedidor();
        this.lineas.push(`d_${n} ${x} ${p.b} ${this.modeloDiodo(p.modelo)}`);
        break;
      }
      case 'I': {
        const x = conMedidor();
        this.lineas.push(`i_${n} ${x} ${p.b} DC ${p.amperios}`);
        break;
      }
      case 'SV': {
        el.control = [p.cp!, p.cn!];
        const x = conMedidor();
        const m = this.modelo(`SW(VT=${p.umbral} VH=${p.histeresis ?? 0} RON=${p.ron ?? RON} ROFF=${p.roff ?? ROFF})`);
        this.lineas.push(`s_${n} ${x} ${p.b} ${p.cp} ${p.cn} ${m}`);
        break;
      }
      case 'V': {
        const x = conMedidor();
        const linea = this.fuente(n, x, p.b, p.voltios, p);
        this.fuentes.set(el.id, { linea, limitada: p.limiteA !== undefined || Boolean(p.soloEntrega), negativa: p.voltios < 0 });
        break;
      }
      case 'REG':
        this.regulador(n, el, dueno, p);
        break;
    }
    this.elementos.push(el);
    return el;
  }

  /**
   * Fuente de tensión de `pos` a `neg`. Con límite de corriente es una fuente de laboratorio
   * CV/CC: una fuente de corriente con el límite y un diodo que recorta al voltaje ajustado
   * (lo que sobra vuelve por el recorte). Con `soloEntrega`, un diodo de bloqueo en la salida
   * (no absorbe corriente de afuera, como un regulador o un USB).
   */
  private fuente(n: string, pos: string, neg: string, v: number, o: { rSerie?: number; limiteA?: number; soloEntrega?: boolean }): number {
    const limite = o.limiteA ?? (o.soloEntrega ? 10 : undefined);
    if (limite === undefined) {
      const y = `y_${n}`;
      this.lineas.push(`r_${n} ${pos} ${y} ${Math.max(o.rSerie ?? RSERIE_MIN, RSERIE_MIN)}`);
      this.lineas.push(`v_${n} ${y} ${neg} DC ${v}`);
      return this.lineas.length - 1;
    }
    const recorte = this.modelo(MODELO_RECORTE);
    const r = `r_${n}`;
    const salida = o.soloEntrega ? `q_${n}` : pos; // con bloqueo, el recorte queda detrás del diodo
    const linea = this.lineas.length;
    this.lineas.push(`vref_${n} ${r} ${neg} DC ${v}`);
    if (v >= 0) {
      this.lineas.push(`ilim_${n} ${neg} ${salida} DC ${limite}`);
      this.lineas.push(`drec_${n} ${salida} ${r} ${recorte}`);
      if (o.soloEntrega) this.lineas.push(`dblq_${n} ${salida} ${pos} ${recorte}`);
    } else {
      this.lineas.push(`ilim_${n} ${salida} ${neg} DC ${limite}`);
      this.lineas.push(`drec_${n} ${r} ${salida} ${recorte}`);
      if (o.soloEntrega) this.lineas.push(`dblq_${n} ${pos} ${salida} ${recorte}`);
    }
    return linea;
  }

  /**
   * Regulador lineal de un módulo. Mismo circuito que el de la placa (sim/placa.ts), pero
   * referido a la tierra del módulo y no al 0 de SPICE: referencia Vout = min(V, Vin − caída),
   * límite de corriente, diodo de bloqueo (solo entrega) y una fuente controlada que toma de
   * la entrada lo mismo que entrega la salida. Para leerlo, el cuerpo es un elemento de la
   * entrada a la salida: lleva la corriente que entrega y disipa (Vin − Vout)·I, así Kirchhoff
   * y la energía cierran en cada nodo. El consumo propio (`iq`) es otro elemento, entrada→tierra.
   */
  private regulador(n: string, el: ElementoArmado, dueno: string, p: Extract<Primitiva, { tipo: 'REG' }> & { a: string; b: string }): void {
    const t = p.tierra;
    el.regulador = { tierra: t, caida: p.caida };
    const v = (nodo: string): string => (nodo === '0' ? '0' : `V(${nodo})`);
    const vin = t === '0' ? v(p.a) : `(${v(p.a)}-${v(t)})`;
    const m = this.modelo(MODELO_RECORTE);
    el.medidor = `vam_${n}`;
    this.lineas.push(
      `b${n}_ref ${n}_r ${t} V=max(0,min(${p.voltios},${vin}-${p.caida}))`,
      `i${n}_lim ${t} ${n}_q DC ${p.limiteA}`,
      `d${n}_rec ${n}_q ${n}_r ${m}`,
      `d${n}_blq ${n}_q ${n}_x ${m}`,
      `${el.medidor} ${n}_x ${p.b} DC 0`,
      `b${n}_in ${p.a} ${t} I=max(0,i(${el.medidor}))`,
    );
    if (p.iq !== undefined && p.iq > 0) {
      // Consumo propio: arranca con la entrada (rampa hasta 1 V) para no tirar de un nodo sin tensión.
      const med = `vam_${n}_iq`;
      this.lineas.push(`${med} ${p.a} ${n}_y DC 0`, `b${n}_iq ${n}_y ${t} I=${p.iq}*min(1,max(0,${vin}))`);
      this.elementos.push({ id: `${dueno}.${p.nombre}_iq`, dueno, local: `${p.nombre}_iq`, tipo: 'REG', a: p.a, b: t, medidor: med });
    }
  }

  /** Líneas SPICE escritas a mano (solo modelos internos de confianza, como la placa). */
  crudo(...lineas: string[]): void {
    this.lineas.push(...lineas);
  }

  /** Registra un elemento armado a mano para poder leerlo (un amperímetro propio). */
  registrar(el: ElementoArmado): void {
    this.elementos.push(el);
  }

  texto(): string {
    return this.renderizar(this.lineas, ['.op']);
  }

  /** Actualización local de un R ya armado: conserva nombre, terminales y topología. */
  actualizarResistencia(id: string, ohms: number): void {
    const el = this.elementos.find(e => e.id === id);
    const indice = this.resistencias.get(id);
    const linea = indice === undefined ? undefined : this.lineas[indice];
    if (!el || el.tipo !== 'R' || indice === undefined || linea === undefined) throw new ErrorSpice(`No existe una resistencia actualizable: ${id}`, [], '');
    validarPrimitivaSpice({ tipo: 'R', nombre: el.local, a: el.a, b: el.b, ohms });
    this.lineas[indice] = linea.replace(/\S+$/, String(ohms));
    el.ohms = ohms;
  }

  /** IC y estímulos se aplican a una copia; el punto de operación conserva su netlist. */
  textoTransitorio(parametros: ParametrosTransitorio): string {
    this.validarPresupuestoTransitorio(Math.ceil(parametros.duracionS / parametros.pasoS) + 1);
    const lineas = [...this.lineas];
    for (const id of Object.keys(parametros.condicionesIniciales ?? {})) {
      if (!this.reactivos.has(id)) throw new ErrorSpice(`Condición inicial para elemento desconocido o no reactivo: ${id}`, [], '');
    }
    for (const [id, reactivo] of this.reactivos) {
      const linea = lineas[reactivo.linea];
      if (linea === undefined) throw new ErrorSpice(`No se encontró el elemento ${id}`, [], '');
      const base = linea.replace(/ IC=\S+$/, '');
      if (parametros.inicializacion === 'explicita') {
        const inicial = parametros.condicionesIniciales?.[id] ?? reactivo.inicial;
        if (inicial === undefined) throw new ErrorSpice(`Falta condición inicial para ${id}`, [], '');
        lineas[reactivo.linea] = `${base} IC=${inicial}`;
      } else lineas[reactivo.linea] = base;
    }
    for (const [id, puntos] of Object.entries(parametros.estimulos ?? {})) {
      const fuente = this.fuentes.get(id);
      if (!fuente) throw new ErrorSpice(`Estímulo para fuente de tensión desconocida: ${id}`, [], '');
      if (fuente.limitada && puntos.some(p => fuente.negativa ? p.valor > 0 : p.valor < 0)) {
        throw new ErrorSpice(`El estímulo de ${id} cambia la polaridad de una fuente limitada; ese cambio de topología no está modelado`, [], '');
      }
      const linea = lineas[fuente.linea];
      const primero = puntos[0];
      if (linea === undefined || primero === undefined) throw new ErrorSpice(`Estímulo inválido para ${id}`, [], '');
      lineas[fuente.linea] = linea.replace(/ DC \S+$/, ` DC ${primero.valor} PWL(${puntos.map(p => `${p.t} ${p.valor}`).join(' ')})`);
    }
    return this.renderizar(lineas, [
      `.save ${this.vectoresTransitorios().join(' ')}`,
      '.options reltol=1e-5 abstol=1e-12 vntol=1e-8',
      `.tran ${parametros.pasoS} ${parametros.duracionS} 0 ${parametros.pasoS}${parametros.inicializacion === 'explicita' ? ' uic' : ''}`,
    ]);
  }

  /** El adaptador publica v/i/p por elemento y puede repetir un nodo bajo muchos pines. */
  validarPresupuestoTransitorio(muestras: number, cantidadPines = this.nodos().size + 1): void {
    if (this.elementos.length > 256) throw new ErrorSpice('El transitorio admite hasta 256 elementos', [], '');
    const vectores = this.vectoresTransitorios().length;
    if (vectores > MAX_VECTORES_TRANSITORIO) throw new ErrorSpice('El transitorio excede el límite de vectores', [], '');
    validarCantidadValoresTransitorio(muestras, vectores);
    validarCantidadValoresTransitorio(muestras, 1 + cantidadPines + 3 * this.elementos.length);
  }

  private vectoresTransitorios(): string[] {
    const vectores = ['time', ...[...this.nodos()].map(n => `v(${n})`)];
    for (const el of this.elementos) if (el.medidor) vectores.push(`i(${el.medidor})`);
    return [...new Set(vectores)];
  }

  private renderizar(lineas: readonly string[], analisis: readonly string[]): string {
    const modelos = [...this.modelos].map(([cuerpo, n]) => `.model ${n} ${cuerpo}`);
    return [
      // El lector raw del adaptador calcula offsets como caracteres, no bytes UTF-8.
      // Sólo normalizamos la cabecera SPICE; el nombre del proyecto no se modifica.
      this.titulo.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7E]/g, ' '),
      ...lineas,
      // ngspice no resuelve un circuito sin elementos: una resistencia suelta a tierra no cambia nada.
      ...(lineas.length === 0 ? ['r_vacio n_vacio 0 1'] : []),
      // 1 TΩ de cada nodo a tierra (como la aislación real): un módulo sin cablear o un circuito
      // flotante queda definido en vez de dar "matriz singular". `rshunt` solo no alcanza.
      ...[...this.nodos()].map((nodo, i) => `r_fuga${i} ${nodo} 0 1e12`),
      ...modelos,
      '.options rshunt=1e12 itl1=400 gmin=1e-12',
      ...analisis,
      '.end',
    ].join('\n');
  }

  /** Nodos de los elementos (los internos de cada fuente o medidor cuelgan de estos). */
  private nodos(): Set<string> {
    const out = new Set<string>();
    for (const el of this.elementos) for (const n of [el.a, el.b, ...(el.control ?? [])]) if (n !== '0') out.add(n);
    return out;
  }

  /** Tensión de un nodo SPICE en el resultado (0 para la tierra). */
  static tension(r: ResultadoSpice, nodo: string): number {
    if (nodo === '0') return 0;
    return valorSpice(r.valores, `v(${nodo})`, r.errores, '');
  }

  resolver(r: ResultadoSpice): ElementoResuelto[] {
    validarDiagnosticosSpice(r.errores, this.texto());
    return this.elementos.map((el) => {
      const va = Netlist.tension(r, el.a);
      const vb = Netlist.tension(r, el.b);
      let i: number;
      if (el.ohms !== undefined) i = (va - vb) / el.ohms;
      else if (el.medidor) i = (el.signo ?? 1) * valorSpice(r.valores, `i(${el.medidor})`, r.errores, this.texto());
      else throw new ErrorSpice(`El elemento ${el.id} no tiene medición de corriente`, r.errores, this.texto());
      const potencia = (va - vb) * i;
      if (!Number.isFinite(i) || !Number.isFinite(potencia)) throw new ErrorSpice(`Medición no finita en ${el.id}`, r.errores, this.texto());
      const regulador = el.regulador ? {
        tierra: el.regulador.tierra,
        activo: va - Netlist.tension(r, el.regulador.tierra) > el.regulador.caida
          && vb - Netlist.tension(r, el.regulador.tierra) > 1e-9,
      } : undefined;
      return { id: el.id, dueno: el.dueno, local: el.local, tipo: el.tipo, a: el.a, b: el.b, va, vb, i, p: potencia, ohms: el.ohms, regulador };
    });
  }
}
