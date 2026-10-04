import type { SalidaChip } from '@emu/shared';
import type { EntradaChip } from '../bus/chipSandbox.js';
import type { ServicioCamara } from './servicio.js';

/** Conecta señales del controlador con solicitudes HTTP sin exponer el servidor al sandbox. */
export class CoordinadorCapturas {
  constructor(private servicio: ServicioCamara, private log: (mensaje: string) => void) {}
  salida(project: string, id: string, salida: SalidaChip, entrada: (instance: string, datos: EntradaChip) => void) {
    if (!id.endsWith(':arduchip')) return;
    const instance = id.slice(0, -':arduchip'.length);
    if (salida.cameraAction === 'cancel') this.servicio.cancelar(project, instance, 'La captura fue cancelada por el circuito.');
    if (salida.cameraAction !== 'capture' || typeof salida.token !== 'number' || !Number.isSafeInteger(salida.token) || salida.token < 0) return;
    const token = salida.token;
    const fallo = (mensaje: string) => { entrada(instance, { tipo: 'fallo', token, mensaje }); this.log(`[ArduCAM] ${mensaje}`); };
    try { this.servicio.solicitar(project, instance, bytes => entrada(instance, { tipo: 'imagen', token, bytes: [...bytes] }), fallo); }
    catch (err) { fallo((err as Error).message); }
  }
}
