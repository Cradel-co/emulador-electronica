import type { NivelDigital } from './contratos.js';

export type ModoInterrupcion = 'ascendente' | 'descendente' | 'ambos' | 'alto' | 'bajo';
export interface FuenteInterrupcion { id: string; modo: ModoInterrupcion; habilitada?: boolean }
export interface EstadoInterrupcion {
  id: string; modo: ModoInterrupcion; habilitada: boolean; nivel: NivelDigital; pendiente: boolean;
}
const modos: readonly string[] = ['ascendente', 'descendente', 'ambos', 'alto', 'bajo'];

/** Estado funcional por instancia. La agenda y el adaptador son los dueños del tiempo y del servicio. */
export class ControladorInterrupciones {
  private readonly inicial: FuenteInterrupcion[];
  private fuentes = new Map<string, EstadoInterrupcion>();

  constructor(fuentes: readonly FuenteInterrupcion[]) {
    if (fuentes.length < 1 || fuentes.length > 64) throw new Error('Se requieren entre 1 y 64 fuentes de interrupción');
    const ids = new Set<string>();
    for (const f of fuentes) {
      if (typeof f.id !== 'string' || !/^[A-Za-z0-9_+\-/]{1,40}$/.test(f.id) || ids.has(f.id) || !modos.includes(f.modo)
        || (f.habilitada !== undefined && typeof f.habilitada !== 'boolean')) throw new Error('Fuente de interrupción inválida o duplicada');
      ids.add(f.id);
    }
    this.inicial = fuentes.map(f => ({ ...f }));
    this.reiniciar();
  }
  get estado(): EstadoInterrupcion[] { return [...this.fuentes.values()].map(f => ({ ...f })); }
  get irq(): boolean { return [...this.fuentes.values()].some(f => f.habilitada && f.pendiente); }

  private fuente(id: string): EstadoInterrupcion {
    const f = this.fuentes.get(id);
    if (!f) throw new Error(`Fuente de interrupción desconocida: ${id}`);
    return f;
  }
  muestrear(id: string, nivel: NivelDigital): void {
    const f = this.fuente(id);
    if (nivel !== 0 && nivel !== 1 && nivel !== 'X') throw new Error('Nivel de interrupción inválido');
    if (f.modo === 'alto' || f.modo === 'bajo') f.pendiente = nivel === (f.modo === 'alto' ? 1 : 0);
    else if (f.nivel !== 'X' && nivel !== 'X' && nivel !== f.nivel
      && (f.modo === 'ambos' || (f.modo === 'ascendente' ? nivel === 1 : nivel === 0))) f.pendiente = true;
    f.nivel = nivel;
  }
  habilitar(id: string, habilitada: boolean): void {
    const f = this.fuente(id);
    if (typeof habilitada !== 'boolean') throw new Error('Máscara de interrupción inválida');
    f.habilitada = habilitada;
  }
  reconocer(id: string): void {
    const f = this.fuente(id);
    // Los niveles activos se retiran únicamente al desactivar la entrada.
    if (f.modo !== 'alto' && f.modo !== 'bajo') f.pendiente = false;
  }
  reiniciar(): void {
    this.fuentes = new Map(this.inicial.map(f => [f.id, { id: f.id, modo: f.modo, habilitada: f.habilitada ?? false, nivel: 'X', pendiente: false }]));
  }
}
