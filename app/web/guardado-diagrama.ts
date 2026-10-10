/** Puertos del coordinador: no conoce DOM, React, cámara ni el transporte HTTP. */
export interface PuertosGuardadoDiagrama {
  proyecto(): string | null;
  contenido(): string;
  enviar(proyecto: string, contenido: string): Promise<unknown>;
  enviarAlSalir(proyecto: string, contenido: string): void;
  notificar(): void;
  alGuardar(): Promise<void>;
  alError(error: unknown): void;
}

/** Conserva el debounce y la cola locales. No arbitra conflictos entre clientes. */
export class GuardadoDiagrama {
  private version = 0;
  private guardada = 0;
  private epoca = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private guardado: Promise<unknown> = Promise.resolve();
  constructor(private readonly puertos: PuertosGuardadoDiagrama) {}

  get sucio(): boolean { return this.version !== this.guardada; }
  aceptarCarga(): void { this.descartar(); this.guardada = this.version; this.epoca++; this.guardado = Promise.resolve(); }

  get revision(): number { return this.version; }
  get pendiente(): boolean { return Boolean(this.timer); }

  private enviar(proyecto: string, contenido: string, revision = this.version): Promise<unknown> {
    const epoca = this.epoca;
    this.guardado = this.guardado.catch(() => {}).then(async () => {
      const respuesta = await this.puertos.enviar(proyecto, contenido);
      if (epoca === this.epoca && this.puertos.proyecto() === proyecto) this.guardada = Math.max(this.guardada, revision);
      return respuesta;
    });
    return this.guardado;
  }

  programar(): void {
    this.version++;
    this.puertos.notificar();
    if (this.timer !== null) clearTimeout(this.timer);
    const proyecto = this.puertos.proyecto();
    if (!proyecto) return;
    const contenido = this.puertos.contenido();
    const revision = this.version;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.enviar(proyecto, contenido, revision);
        if (this.puertos.proyecto() === proyecto) await this.puertos.alGuardar();
      } catch (error) { this.puertos.alError(error); }
    }, 300);
  }

  /** Cancela sólo el envío pendiente; un pedido ya enviado sigue perteneciendo a su contexto. */
  descartar(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  esperarPendiente(): Promise<unknown> {
    const proyecto = this.puertos.proyecto();
    if (this.timer && proyecto) {
      this.descartar();
      void this.enviar(proyecto, this.puertos.contenido());
    }
    return this.guardado;
  }

  async esperarCamara(proyecto: string): Promise<void> {
    while (true) {
      if (this.puertos.proyecto() !== proyecto) throw new Error('El proyecto cambió.');
      const revision = this.version;
      await this.esperarPendiente();
      if (this.puertos.proyecto() !== proyecto) throw new Error('El proyecto cambió.');
      if (this.version === revision && !this.timer) return;
    }
  }

  /** Mantiene el keepalive directo existente; no garantiza durabilidad ni orden con la cola. */
  alSalir(): void {
    const proyecto = this.puertos.proyecto();
    if (!this.timer || !proyecto) return;
    this.descartar();
    this.puertos.enviarAlSalir(proyecto, this.puertos.contenido());
  }
}
