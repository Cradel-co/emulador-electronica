/**
 * Lo que devuelve el motor eléctrico (sim/analisis.ts) y consumen el server, el MCP y la UI.
 */

/** `se-quema` es un código legacy de riesgo; no predice avería ni tiempo hasta dañarse. */
export type EstadoLed = 'ok' | 'sobreexigido' | 'se-quema';

/** Corriente DC por cada LED en la misma instantánea que tensiones y medidas. */
export interface LedElectrico {
  id: string;
  mA: number;
  estado: EstadoLed;
  /** Alias de mA conservado por compatibilidad; ya no es una hipótesis todos-los-GPIO-en-bajo. */
  mAFijo: number;
}

/**
 * ¿La placa tiene con qué andar? ok = arranca; sin-energia / baja = no arranca (con el motivo);
 * quema = riesgo por sobretensión o polaridad invertida en una entrada, no daño demostrado.
 */
export interface AlimentacionPlaca {
  estado: 'ok' | 'sin-energia' | 'baja' | 'quema';
  via: 'usb' | 'fuente' | 'sin-datos' | null;
  /** Pin de entrada por el que llega la fuente, y qué es según el descriptor. */
  pin: string | null;
  entrada: 'vin' | '5v' | '3v3' | null;
  fuenteId: string | null;
  v: number | null;
  /** Consumo típico de la placa andando (mA), del descriptor. */
  consumoMa: number | null;
  /** La fuente a la que la placa le pide corriente (andando, o intentando arrancar en modo CC). */
  consumeDe: string | null;
  mensaje: string;
}

/**
 * Lo que entrega cada fuente regulable (el "panel frontal" de la fuente de laboratorio).
 * CV = voltaje constante (la carga pide menos que el límite); CC = limitando corriente;
 * corto = su salida cableada directo contra otra tensión (entrega el límite con ~0 V);
 * apagada = salida apagada (proyecto sin placa sin energizar).
 */
export interface FuenteElectrica {
  id: string;
  vAjuste: number;
  limiteMa: number | null;
  /** Lo que pediría la carga sin límite (null en corto: sin carga que la limite). */
  demandaMa: number | null;
  mA: number | null;
  vSalida: number;
  potenciaW: number;
  modo: 'CV' | 'CC' | 'corto' | 'apagada';
}


export interface AvisoElectrico {
  severidad: 'peligro' | 'advertencia';
  mensaje: string;
  pin: number;
  /** Refs "id.PIN" involucradas (para resaltar el pin/cable exacto en el canvas). */
  refs?: string[];
}

export interface LecturaSalida {
  valida: boolean;
  led?: { mA: number; mAFijo?: number; estado?: string };
  modelo?: { on?: boolean };
}

/** null expresa ausencia de observación; false expresa una salida observada apagada. */
export function estadoSalidaDesdeFisica({ valida, led, modelo }: LecturaSalida): boolean | null {
  if (!valida) return null;
  if (led !== undefined) return Number.isFinite(led.mA) ? led.mA > 0.5 : null;
  return typeof modelo?.on === 'boolean' ? modelo.on : null;
}

/** La UI conserva su indicador binario: lo desconocido no enciende el dibujo. */
export function salidaDesdeFisica(lectura: LecturaSalida): boolean {
  return estadoSalidaDesdeFisica(lectura) === true;
}

export function riesgoDesdeFisica({ valida, led }: LecturaSalida): boolean {
  return valida && led !== undefined && Number.isFinite(led.mA)
    && (led.estado === 'se-quema' || led.estado === 'sobreexigido');
}

export interface ContextoElectrico {
  proyecto: string;
  placas: string[];
  /** Generación de ejecución; no es un identificador persistente entre servidores. */
  corrida: number;
  /** Huella del proyecto usado en el cálculo; no es una credencial de seguridad. */
  revision: string;
  /** Firma de módulos/propiedades y cables; mover el dibujo no cambia la física. */
  topologia: string;
}

export function firmaDiagramaElectrico(diagrama: Pick<import('./project.js').Project, 'modules' | 'wires'>): string {
  return JSON.stringify({ modules: diagrama.modules.map(m => ({ id: m.id, type: m.type, props: m.props, entorno: m.entorno })),
    wires: diagrama.wires });
}

export interface MedicionElectrica {
  modulo: string; moduloNombre: string; elemento: string; tipo: string;
  tensionV: number; corrienteMa: number; potenciaMw: number; resistenciaOhm: number | null;
}

export interface ObservacionElectrica {
  contexto: ContextoElectrico;
  estado: 'valida' | 'no-resuelta' | 'obsoleta';
  resuelto: boolean;
  /** GPIO reportados por firmware, por placa; distintos del nivel efectivo con PWM del motor. */
  nivelesPorPlaca: Record<string, Record<number, 0 | 1>>;
  leds: LedElectrico[];
  fuentes: FuenteElectrica[];
  placa: (AlimentacionPlaca & { quemada: false; resuelto: boolean }) | null;
  placas: Record<string, AlimentacionPlaca & { quemada: false; resuelto: boolean }>;
  energizado: boolean;
  tensiones: Record<string, number>;
  mediciones: MedicionElectrica[];
  modulos: Record<string, { on?: boolean; brillo?: number }>;
  sonidos: import('./audio.js').EventoSonido[];
}

/** Retira medidas no vigentes: no convierte ausencia o fallo en cero voltios. */
export function invalidarLecturaElectrica(lectura: ObservacionElectrica): ObservacionElectrica {
  return { ...lectura, resuelto: false, nivelesPorPlaca: {}, leds: [], fuentes: [], placa: null,
    placas: {}, energizado: false, tensiones: {}, mediciones: [], modulos: {}, sonidos: [] };
}
