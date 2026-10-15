/** Un grupo comparte promesa y conserva solamente el proyecto más recientemente solicitado. */
interface Grupo {
  nombre: string;
  promesa: Promise<void>;
  resolver: () => void;
  rechazar: (error: unknown) => void;
}

export interface ActualizadorElectrico {
  /** No acumula simuladores: como máximo hay uno activo y un grupo pendiente. */
  solicitar(nombre: string): Promise<void>;
}

/**
 * Agrupa eventos de GPIO/control mientras el solver asíncrono trabaja. El solicitante maneja
 * errores con la promesa de su grupo; un fallo no impide resolver las solicitudes siguientes.
 * La demora permite juntar eventos y se aplica sólo después de que termina el trabajo activo.
 */
export function crearActualizadorElectrico(
  trabajar: (nombre: string) => Promise<void>,
  demoraMs = 50,
): ActualizadorElectrico {
  if (!Number.isFinite(demoraMs) || demoraMs < 0) throw new RangeError('Demora eléctrica inválida');
  let activo = false;
  let pendiente: Grupo | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function agendar(): void {
    if (activo || timer !== null || pendiente === null) return;
    timer = setTimeout(() => {
      timer = null;
      const grupo = pendiente;
      if (!grupo) return;
      pendiente = null;
      activo = true;
      // Convierte también un throw síncrono del adaptador en rechazo del grupo.
      void Promise.resolve().then(() => trabajar(grupo.nombre)).then(
        () => terminar(grupo),
        error => terminar(grupo, { error }),
      );
    }, demoraMs);
  }

  function terminar(grupo: Grupo, fallo?: { error: unknown }): void {
    activo = false;
    agendar();
    if (fallo) grupo.rechazar(fallo.error);
    else grupo.resolver();
  }

  return {
    solicitar(nombre): Promise<void> {
      if (pendiente) {
        pendiente.nombre = nombre;
        return pendiente.promesa;
      }
      let resolver: () => void = () => undefined;
      let rechazar: (error: unknown) => void = () => undefined;
      const promesa = new Promise<void>((r, j) => { resolver = r; rechazar = j; });
      pendiente = { nombre, promesa, resolver, rechazar };
      agendar();
      return promesa;
    },
  };
}
