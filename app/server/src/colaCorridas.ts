/** Serializa arranques y conserva el error de cada tarea sin bloquear las siguientes. */
export class ColaCorridas {
  private cola: Promise<unknown> = Promise.resolve();
  private proyecto: string | null = null;

  get enCurso(): string | null { return this.proyecto; }

  ejecutar<T>(proyecto: string, tarea: () => Promise<T>): Promise<T> {
    const job = this.cola.catch(() => {}).then(async () => {
      this.proyecto = proyecto;
      try { return await tarea(); }
      finally { this.proyecto = null; }
    });
    this.cola = job;
    return job;
  }

  /** La parada sigue esperando la cola que existe al llamar, aunque haya fallado. */
  esperar(): Promise<unknown> { return this.cola.catch(() => {}); }
}
