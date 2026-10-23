import { ErrorAgenda, type NivelDigital } from '@emu/shared';
import { poseeDominio, type GrafoComponentes, type TerminalElaborado } from './elaboracion.js';

export interface CambioEntradaIrq {
  puerto: string; anterior: NivelDigital; actual: NivelDigital; instanteEmisionPs: bigint;
  origen?: { ruta: string[]; puerto: string };
}
export interface EntregaIrq {
  ruta: string[]; puerto: string; nivel: NivelDigital; emisionPs: bigint; origen: number; generacion: string;
}
interface Salida { terminal: TerminalElaborado; nivel: NivelDigital; generacion: bigint; destinos: Entrada[] }
interface Entrada { terminal: TerminalElaborado; nivel: NivelDigital; origen: number }
const clave = (ruta: readonly string[], puerto: string): string => JSON.stringify([ruta, puerto]);
const pertenece = (ruta: readonly string[], padre: readonly string[]): boolean => padre.every((id, i) => ruta[i] === id);

/** Conectividad funcional del grafo activo. Las interfaces compuestas no producen efectos. */
export class EnrutadorIrq {
  private readonly salidas: Salida[] = [];
  private readonly porSalida = new Map<string, Salida>();
  private readonly entradas = new Map<string, Entrada>();

  constructor(grafo: GrafoComponentes) {
    const hojas = new Set(grafo.instancias.filter(i => i.tipo === 'hoja-legada' && poseeDominio(i, 'funcional')).map(i => JSON.stringify(i.ruta)));
    for (const red of grafo.redes) {
      if (red.dominio !== 'interrupcion') continue;
      if (red.ancho !== 1 || red.terminales.some(t => t.direccion === 'bidireccional')) throw new ErrorAgenda('IRQ requiere puertos escalares de entrada o salida', red.terminales[0]?.ruta ?? []);
      const terminales = red.terminales.filter(t => hojas.has(JSON.stringify(t.ruta)));
      const drivers = terminales.filter(t => t.direccion === 'salida');
      if (drivers.length > 1) throw new ErrorAgenda('Múltiples emisores IRQ', drivers[0]?.ruta ?? []);
      const driver = drivers[0], indice = driver ? this.salidas.length : -1;
      const destinos = terminales.filter(t => t.direccion === 'entrada').map(terminal => {
        const entrada: Entrada = { terminal: structuredClone(terminal), nivel: 'X', origen: indice };
        this.entradas.set(clave(terminal.ruta, terminal.puerto), entrada);
        return entrada;
      });
      if (driver) {
        const salida: Salida = { terminal: structuredClone(driver), nivel: 'X', generacion: 0n, destinos };
        this.salidas.push(salida); this.porSalida.set(clave(driver.ruta, driver.puerto), salida);
      }
    }
  }
  leer(ruta: readonly string[], puerto: string): NivelDigital {
    const entrada = this.entradas.get(clave(ruta, puerto));
    if (!entrada) throw new ErrorAgenda('Entrada IRQ no declarada', ruta);
    return entrada.nivel;
  }
  private entrega(entrada: Entrada, emisionPs: bigint): EntregaIrq {
    const salida = this.salidas[entrada.origen];
    return { ruta: [...entrada.terminal.ruta], puerto: entrada.terminal.puerto, nivel: salida?.nivel ?? 'X',
      emisionPs, origen: entrada.origen, generacion: (salida?.generacion ?? 0n).toString() };
  }
  escribir(ruta: readonly string[], puerto: string, nivel: NivelDigital, ahoraPs: bigint): EntregaIrq[] {
    const salida = this.porSalida.get(clave(ruta, puerto));
    if (!salida || (nivel !== 0 && nivel !== 1 && nivel !== 'X')) throw new ErrorAgenda('Salida o nivel IRQ inválido', ruta);
    if (salida.nivel === nivel) return [];
    salida.nivel = nivel;
    return salida.destinos.map(e => this.entrega(e, ahoraPs));
  }
  sincronizar(ruta: readonly string[], ahoraPs: bigint): EntregaIrq[] {
    return [...this.entradas.values()].filter(e => JSON.stringify(e.terminal.ruta) === JSON.stringify(ruta)).map(e => this.entrega(e, ahoraPs));
  }
  vigente(entrega: EntregaIrq): boolean {
    return entrega.origen === -1 || this.salidas[entrega.origen]?.generacion.toString() === entrega.generacion;
  }
  recibir(entrega: EntregaIrq): CambioEntradaIrq | null {
    if (!this.vigente(entrega)) return null;
    const entrada = this.entradas.get(clave(entrega.ruta, entrega.puerto));
    if (!entrada || entrada.origen !== entrega.origen) throw new ErrorAgenda('Destino IRQ inválido', entrega.ruta);
    if (entrada.nivel === entrega.nivel) return null;
    const anterior = entrada.nivel; entrada.nivel = entrega.nivel;
    const origen = this.salidas[entrega.origen]?.terminal;
    return { puerto: entrega.puerto, anterior, actual: entrega.nivel, instanteEmisionPs: entrega.emisionPs,
      ...(origen ? { origen: { ruta: [...origen.ruta], puerto: origen.puerto } } : {}) };
  }
  invalidar(ruta: readonly string[], ahoraPs: bigint): EntregaIrq[] {
    for (const e of this.entradas.values()) if (pertenece(e.terminal.ruta, ruta)) e.nivel = 'X';
    const entregas: EntregaIrq[] = [];
    for (const s of this.salidas) if (pertenece(s.terminal.ruta, ruta)) {
      s.generacion++; s.nivel = 'X';
      entregas.push(...s.destinos.map(e => this.entrega(e, ahoraPs)));
    }
    return entregas;
  }
}
