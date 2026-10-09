/** Vigencia global: una solución DC incluye todas las placas del circuito. */
export class VigenciaElectrica {
  private revision = 0;
  private cambios = 0;

  invalidar(): void { this.revision++; }

  /** Una respuesta REST/MCP también debe pertenecer al contexto en que empezó a calcularse. */
  capturar(sigueCorrida: () => boolean = () => true): () => boolean {
    const revision = this.revision;
    return () => this.cambios === 0 && revision === this.revision && sigueCorrida();
  }

  async consultar<T>(
    resolver: () => Promise<T>,
    aplicar: (resultado: T, vigente: () => boolean) => void | Promise<void>,
    sigueCorrida: () => boolean = () => true,
  ): Promise<void> {
    const vigente = this.capturar(sigueCorrida);
    if (!vigente()) return;
    const resultado = await resolver();
    if (vigente()) await aplicar(resultado, vigente);
  }

  /** Invalida antes y después: tampoco sobreviven consultas iniciadas durante stop/start. */
  async cambiar<T>(operacion: () => Promise<T>): Promise<T> {
    this.revision++;
    this.cambios++;
    try { return await operacion(); }
    finally { this.cambios--; this.revision++; }
  }
}
