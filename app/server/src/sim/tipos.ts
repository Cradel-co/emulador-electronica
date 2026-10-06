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
