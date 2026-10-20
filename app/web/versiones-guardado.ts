export class ErrorRevision extends Error {
  constructor(message: string, readonly status = 412) { super(message); }
}

/** La base cambia sólo al cargar contenido o aceptar un guardado, nunca por un aviso externo. */
export class VersionesGuardado {
  private bases = new Map<string, string>();
  private bloqueados = new Set<string>();
  private colas = new Map<string, Promise<unknown>>();

  cargar(recurso: string, revision: string): void {
    this.bases.set(recurso, revision);
    this.bloqueados.delete(recurso);
  }
  bloquear(recurso: string): void { this.bloqueados.add(recurso); }
  bloqueado(recurso: string): boolean { return this.bloqueados.has(recurso); }
  enCurso(recurso: string): boolean { return this.colas.has(recurso); }
  revision(recurso: string): string | undefined { return this.bases.get(recurso); }

  guardar<T extends { revision: string }>(recurso: string, enviar: (revision: string) => Promise<T>, explicita?: string): Promise<T> {
    const trabajo = (this.colas.get(recurso) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.bloqueados.has(recurso) && !explicita) throw new ErrorRevision('Resolvé el conflicto antes de volver a guardar.');
      const revision = explicita ?? this.bases.get(recurso);
      if (!revision) throw new ErrorRevision('Falta la revisión del contenido cargado.', 428);
      try {
        const respuesta = await enviar(revision);
        this.cargar(recurso, respuesta.revision);
        return respuesta;
      } catch (error) {
        if (error instanceof ErrorRevision) this.bloquear(recurso);
        throw error;
      }
    });
    this.colas.set(recurso, trabajo);
    const limpiar = () => { if (this.colas.get(recurso) === trabajo) this.colas.delete(recurso); };
    void trabajo.then(limpiar, limpiar);
    return trabajo;
  }
}

export interface ConflictoGuardado {
  recurso: string;
  proyecto: string;
  titulo: string;
  local: string;
  remoto: string;
  revisionRemota?: string;
}
