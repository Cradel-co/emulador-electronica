export interface LecturaSalida {
  /** La medición pertenece a una instantánea resuelta; no indica si corre firmware. */
  valida: boolean;
  led?: { mA: number; mAFijo?: number; estado?: string };
  modelo?: { on?: boolean };
}

/** El LED representa su corriente viva; un aviso de riesgo no simula una avería. */
export function salidaDesdeFisica({ valida, led, modelo }: LecturaSalida): boolean {
  if (!valida) return false;
  if (led !== undefined) return Number.isFinite(led.mA) && led.mA > 0.5;
  return modelo?.on === true;
}

/** Violación del límite simplificado, separada del estado de conducción del modelo. */
export function riesgoDesdeFisica({ valida, led }: LecturaSalida): boolean {
  return valida && led !== undefined && Number.isFinite(led.mA)
    && (led.estado === 'se-quema' || led.estado === 'sobreexigido');
}
