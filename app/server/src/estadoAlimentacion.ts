import type { AlimentacionPlaca } from './sim/tipos.js';

/**
 * Estado operativo del modelo eléctrico, sin memoria de daños supuestos.
 * `quema` es un enum legacy para riesgo fuera del rango modelado: no determina avería.
 * `quemada:false` se conserva por compatibilidad; no existe un modelo térmico/destructivo
 * calibrado capaz de concluir daño permanente por una simple violación de tensión.
 */
export type EstadoAlimentacion = AlimentacionPlaca & { quemada: false; resuelto: boolean };

/** Una corrección del circuito se evalúa desde el diagnóstico actual, sin latch de daño. */
export function estadoAlimentacion(a: AlimentacionPlaca, resuelto = true): EstadoAlimentacion {
  return { ...a, quemada: false, resuelto };
}

/** Es una política de ejecución del simulador, no una garantía de seguridad de hardware real. */
export function puedeArrancar(a: EstadoAlimentacion): boolean {
  return a.resuelto && a.estado === 'ok';
}

export function motivoSinArranque(a: EstadoAlimentacion): string | null {
  if (!a.resuelto) return 'El análisis eléctrico no es válido: no se puede ejecutar la placa hasta resolver el diagnóstico.';
  return puedeArrancar(a) ? null : a.mensaje;
}
