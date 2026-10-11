import { randomUUID } from 'node:crypto';
import { MuestraEntradaSonidoSchema, nivelDesdeDbfs, type EntradaSonido, type MuestraEntradaSonido, type Project } from '@emu/shared';
export class ErrorEntradaSonido extends Error {
  constructor(mensaje: string, readonly status = 409) { super(mensaje); }
}
interface Sesion { proyecto: string; instancia: string; id: string; vence: number; secuencia: number; entrada: EntradaSonido | null }
/** Una captura propietaria, temporal y acotada. Nunca escribe el proyecto ni almacena audio. */
export class ServicioEntradaSonido {
  private sesion: Sesion | null = null;
  constructor(private cambiar: (proyecto: string) => void, private ahora: () => number = Date.now) {}
  abrir(proyecto: string, instancia: string): { id: string } {
    this.vencer();
    if (this.sesion) throw new ErrorEntradaSonido('Otro micrófono está conectado al simulador. Detenelo antes de conectar este.');
    const id = randomUUID();
    this.sesion = { proyecto, instancia, id, vence: this.ahora() + 6000, secuencia: 0, entrada: null };
    return { id };
  }
  private propia(proyecto: string, instancia: string, id: string): Sesion {
    this.vencer(); const s = this.sesion;
    if (!s || s.proyecto !== proyecto || s.instancia !== instancia || s.id !== id) throw new ErrorEntradaSonido('La sesión de micrófono venció o pertenece a otra pestaña.');
    return s;
  }
  actualizar(proyecto: string, instancia: string, id: string, muestra: MuestraEntradaSonido): EntradaSonido {
    const parsed = MuestraEntradaSonidoSchema.safeParse(muestra);
    if (!parsed.success) throw new ErrorEntradaSonido('La muestra o su referencia no son válidas.', 400);
    const s = this.propia(proyecto, instancia, id);
    if (parsed.data.secuencia <= s.secuencia) throw new ErrorEntradaSonido('La muestra de micrófono llegó fuera de orden.');
    const entrada: EntradaSonido = { ...parsed.data, origen: 'microfono', nivelEstimado: nivelDesdeDbfs(parsed.data.dbfs, parsed.data.referencia), recibidoMs: this.ahora() };
    s.secuencia = entrada.secuencia; s.entrada = entrada; s.vence = this.ahora() + 6000;
    this.cambiar(proyecto); return entrada;
  }
  cerrar(proyecto: string, instancia: string, id: string): void {
    this.propia(proyecto, instancia, id); this.quitar();
  }
  private quitar(): void {
    const s = this.sesion; this.sesion = null;
    if (s?.entrada) this.cambiar(s.proyecto);
  }
  vencer(): void { if (this.sesion && this.sesion.vence <= this.ahora()) this.quitar(); }
  reconciliar(proyecto: string, modulos: Project['modules']): void {
    if (this.sesion?.proyecto === proyecto && !modulos.some(m => m.id === this.sesion?.instancia && m.type === 'sonometro-sen0232')) this.quitar();
  }
  leer(proyecto: string): Record<string, EntradaSonido> {
    this.vencer(); const s = this.sesion;
    return s?.proyecto === proyecto && s.entrada ? { [s.instancia]: structuredClone(s.entrada) } : {};
  }
  estado(proyecto: string, instancia: string): { activo: boolean; entrada: EntradaSonido | null } {
    this.vencer(); const s = this.sesion;
    return s?.proyecto === proyecto && s.instancia === instancia ? { activo: true, entrada: s.entrada ? structuredClone(s.entrada) : null } : { activo: false, entrada: null };
  }
}
export function aplicarEntradaSonido(proyecto: Project, entradas: Record<string, EntradaSonido>): Project {
  return { ...proyecto, modules: proyecto.modules.map(m => {
    const entrada = entradas[m.id];
    return m.type === 'sonometro-sen0232' && entrada
      ? { ...m, props: { ...m.props, dbA: entrada.nivelEstimado } } : m;
  }) };
}
