import type { BoardDescriptor } from '@emu/shared';
import { gpioAdc1EspValido, PerfilAnalogicoEspSchema, type PerfilAnalogicoEsp } from '@emu/shared';
import type { AnalisisCircuito } from './sim/analisis.js';

/** Voltajes relativos al GND del MCU; null conserva datos desconocidos. */
export interface EstadoAnalogicoEsp {
  resuelto: boolean;
  vcc: number | null;
  canales: Readonly<Record<number, number | null>>;
}
const desconocido = (): EstadoAnalogicoEsp => ({ resuelto: false, vcc: null, canales: {} });
const atenuaciones = ['0db', '2.5db', '6db', '11db'] as const;
const conocido = (valor: number | null | undefined): valor is number => typeof valor === 'number' && Number.isFinite(valor);

/** Ruta exclusiva MicroPython: UART del shim → perfil explícito + última solución DC.
 * No toca registros SAR de esp-emu ni declara soporte de Arduino/ESPHome/IDF.
 */
export class PuenteAnalogicoEsp {
  private estado = desconocido();
  private readonly perfil: PerfilAnalogicoEsp | undefined;
  constructor(private readonly chip: string, perfil: PerfilAnalogicoEsp | undefined, private readonly enviar: (linea: string) => void) {
    this.perfil = perfil === undefined ? undefined : PerfilAnalogicoEspSchema.parse(perfil);
    if (this.perfil && this.perfil.chip !== chip) throw new Error('ADC MicroPython: el chip del perfil no coincide con la placa.');
  }
  actualizar(estado: EstadoAnalogicoEsp): void { this.estado = { ...estado, canales: { ...estado.canales } }; }
  recibir(linea: string): void {
    const partes = linea.trim().split(/\s+/);
    if (partes[0] !== '@ADC' || !/^\d+$/.test(partes[1] ?? '') || !Number.isSafeInteger(Number(partes[1]))) return;
    const id = partes[1];
    if (linea.length > 200 || partes.length !== 4 || !/^\d+$/.test(partes[2] ?? '') || !/^[0-3]$/.test(partes[3] ?? '')) {
      this.enviar(`@ADCR ${id} E:PETICION_INVALIDA`); return;
    }
    const resultado = this.leer(Number(partes[2]), Number(partes[3]));
    this.enviar(`@ADCR ${id} ${resultado}`);
  }
  private leer(gpio: number, atenuacion: number): number | string {
    const perfil = this.perfil;
    if (!perfil) return 'E:SIN_MODELO';
    if (!gpioAdc1EspValido(this.chip, gpio)) return 'E:GPIO_SIN_ADC1';
    const canal = perfil.canales.find(c => c.gpio === gpio && c.atenuacion === atenuaciones[atenuacion]);
    if (!canal) return 'E:SIN_MODELO_CANAL';
    const e = this.estado;
    if (!e.resuelto) return 'E:SIN_SOLUCION';
    if (!conocido(e.vcc)) return 'E:ALIMENTACION_DESCONOCIDA';
    if (e.vcc < perfil.rangoVAlimentacion.min || e.vcc > perfil.rangoVAlimentacion.max) return 'E:ALIMENTACION_FUERA_DOMINIO';
    const voltaje = e.canales[gpio];
    if (!conocido(voltaje)) return 'E:ENTRADA_DESCONOCIDA';
    if (voltaje < 0 || voltaje > e.vcc || voltaje < canal.rangoVEntrada.min || voltaje > canal.rangoVEntrada.max) return 'E:ENTRADA_FUERA_DOMINIO';
    // Sólo se satura dentro del dominio declarado. Los extremos evitan overflow con
    // parámetros finitos extremos; nada fuera del dominio se convierte en una cuenta válida.
    if (voltaje <= canal.voltajeCeroV) return 0;
    if (voltaje >= canal.voltajeFondoEscalaV) return 4095;
    return Math.min(4095, Math.floor((voltaje - canal.voltajeCeroV) / (canal.voltajeFondoEscalaV - canal.voltajeCeroV) * 4096));
  }
}
export function estadoAnalogicoEspDesdeCircuito(boardId: string, desc: BoardDescriptor, r: AnalisisCircuito): EstadoAnalogicoEsp {
  if (!['esp32s3', 'esp32c3', 'esp32c6'].includes(desc.chip)) return desconocido();
  const tierra = r.tensiones[`${boardId}.GND`];
  const relativo = (pin: string): number | null => {
    const v = r.tensiones[`${boardId}.${pin}`];
    return conocido(v) && conocido(tierra) ? v - tierra : null;
  };
  const canales: Record<number, number | null> = {};
  for (const [nombre, pin] of Object.entries(desc.pins)) {
    if (!pin.caps.includes('adc') || !gpioAdc1EspValido(desc.chip, pin.gpio)) continue;
    const entrada = r.entradas.find(e => (e.boardId ?? 'board') === boardId && e.gpio === pin.gpio);
    canales[pin.gpio] = entrada?.flotante ? null : (canales[pin.gpio] ?? relativo(nombre));
  }
  return { resuelto: r.resuelto, vcc: relativo('3V3'), canales };
}
