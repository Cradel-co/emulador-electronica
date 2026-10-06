import type { Emulador } from '../emulatorBackend.js';

export type TransporteRf = Pick<Emulador, 'getBridge' | 'capacidadRf'> & {
  getStatus(): Pick<ReturnType<Emulador['getStatus']>, 'state'>;
};

export function validarTramaRf(destino: TransporteRf, bits: string, protocolo: number): void {
  const capacidad = destino.capacidadRf?.();
  if (!capacidad) throw new Error('Esta corrida no tiene soporte RF: requiere firmware nativo con transporte RMT habilitado.');
  if (!/^[01]+$/.test(bits) || bits.length > capacidad.maxBits) throw new Error(`La trama RF debe contener entre 1 y ${capacidad.maxBits} bits para este transporte.`);
  if (!capacidad.protocolos.includes(protocolo)) throw new Error(`El transporte RF sólo admite protocolo ${capacidad.protocolos.join(', ')}.`);
}

/** Aceptación en el transporte del firmware; no es un ACK de radio. */
export function enviarTramaRf(destino: TransporteRf, bits: string, protocolo: number): boolean {
  const puente = destino.getBridge();
  if (!puente || destino.getStatus().state !== 'bridge') return false;
  // El backend RMT reserva 26 símbolos: sincronía + hasta 24 bits + hueco.
  // Comprobar también aquí evita que una ruta futura alcance el búfer sin guardas.
  validarTramaRf(destino, bits, protocolo);
  puente.sendRf(bits, protocolo);
  return true;
}
