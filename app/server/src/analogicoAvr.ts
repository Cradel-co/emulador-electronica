import { adcConfig, ADCMuxInputType, ADCReference, AVRADC, type ADCMuxInput, type CPU } from 'avr8js';
import type { BoardDescriptor, Project } from '@emu/shared';
import type { AnalisisCircuito } from './sim/analisis.js';

/** Voltajes respecto de GND del MCU. null significa desconocido, no cero voltios. */
export interface EstadoAnalogicoAvr {
  resuelto: boolean;
  vcc: number | null;
  avcc: number | null;
  aref: number | null;
  canales: Readonly<Record<number, number | null>>;
}
export class ErrorAnalogicoAvr extends Error {
  constructor(mensaje: string) { super(`ADC AVR: ${mensaje}`); this.name = 'ErrorAnalogicoAvr'; }
}
const desconocido = (): EstadoAnalogicoAvr => ({ resuelto: false, vcc: null, avcc: null, aref: null, canales: {} });

/**
 * ADC ideal de 10 bits y referencias nominales de avr8js, alimentado por el solver.
 * Fuente primaria: Microchip ATmega328P, §23.7 (VIN·1024/VREF) y §23.5.2.
 * https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf
 * No modela impedancia/sample-and-hold, ruido, error ADC, asentamiento al cambiar referencia,
 * tolerancia/temperatura de bandgap ni auto-trigger; muestra a inicio de conversión.
 */
export class AdaptadorAnalogicoAvr {
  private estado = desconocido();
  constructor(private readonly cpu: CPU, private readonly adc: AVRADC) {
    adc.onADCRead = input => {
      const resultado = this.convertir(input);
      cpu.addClockEvent(() => adc.completeADCRead(resultado), adc.sampleCycles);
    };
  }
  actualizar(estado: EstadoAnalogicoAvr): void {
    this.estado = { ...estado, canales: { ...estado.canales } };
  }
  private numero(v: number | null | undefined, nombre: string, positivo = false): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || (positivo && v <= 0)) throw new ErrorAnalogicoAvr(`${nombre} desconocido o inválido; no se fabrica una lectura de cero.`);
    return v;
  }
  private convertir(input: ADCMuxInput): number {
    const mux = (this.cpu.data[adcConfig.ADMUX] ?? 0) & 0x0f;
    // avr8js sustituye los MUX reservados por GND: no es una lectura física válida.
    if (mux >= 9 && mux <= 13) throw new ErrorAnalogicoAvr(`MUX ${mux} reservado en ATmega328P.`);
    if ((this.cpu.data[adcConfig.ADCSRA] ?? 0) & 0x20) throw new ErrorAnalogicoAvr('auto-trigger sin modelo; se admiten conversiones individuales.');
    const e = this.estado;
    if (!e.resuelto) throw new ErrorAnalogicoAvr('el circuito no tiene una solución válida.');
    const vcc = this.numero(e.vcc, 'VCC', true), avcc = this.numero(e.avcc, 'AVCC', true);
    if (avcc < 2.7 || avcc > 5.5 || Math.abs(avcc - vcc) > 0.3 + 1e-6) throw new ErrorAnalogicoAvr('AVCC fuera del rango del modelo (2,7–5,5 V y ±0,3 V de VCC).');
    this.adc.avcc = avcc;
    let referencia: number;
    switch (this.adc.referenceVoltageType) {
      case ADCReference.AVCC: referencia = avcc; break;
      case ADCReference.AREF:
        referencia = this.numero(e.aref, 'AREF externa', true);
        if (referencia < 1 || referencia > avcc) throw new ErrorAnalogicoAvr('AREF externa fuera del rango 1 V..AVCC.');
        this.adc.aref = referencia;
        break;
      case ADCReference.Internal1V1: referencia = 1.1; break;
      default: throw new ErrorAnalogicoAvr('selección de referencia reservada/no soportada en ATmega328P.');
    }
    let voltaje: number;
    if (input.type === ADCMuxInputType.SingleEnded) {
      if (input.channel > 5) throw new ErrorAnalogicoAvr(`ADC${input.channel} no está expuesto en Arduino Uno PDIP.`);
      voltaje = this.numero(e.canales[input.channel], `ADC${input.channel}`);
    } else if (input.type === ADCMuxInputType.Constant) voltaje = input.voltage;
    else throw new ErrorAnalogicoAvr('temperatura o entrada diferencial sin modelo calibrado.');
    if (voltaje < -1e-6 || voltaje > avcc + 1e-6) throw new ErrorAnalogicoAvr('entrada fuera del dominio GND..AVCC; no se simula como una lectura válida saturada.');
    return Math.min(1023, Math.max(0, Math.floor(voltaje * 1024 / referencia)));
  }
}

/** Adaptación específica Uno: AVCC está conectado al riel 5V; no supone esa unión en otras placas. */
export function estadoAnalogicoDesdeCircuito(project: Project, boardId: string, desc: BoardDescriptor, r: AnalisisCircuito): EstadoAnalogicoAvr {
  const tipo = project.modules.find(m => m.id === boardId)?.type ?? project.boards?.find(b => b.id === boardId)?.board ?? (boardId === 'board' ? project.board : null);
  if (desc.chip !== 'atmega328p' || tipo !== 'arduino-uno') return desconocido();
  const valor = (pin: string): number | null => {
    const v = r.tensiones[`${boardId}.${pin}`];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const tierra = valor('GND');
  const relativo = (pin: string): number | null => {
    const v = valor(pin);
    return v !== null && tierra !== null ? v - tierra : null;
  };
  const vcc = relativo('5V');
  const canales: Record<number, number | null> = {};
  for (const [nombre, pin] of Object.entries(desc.pins)) {
    if (pin.port !== 'C' || pin.bit === undefined || pin.bit > 5 || !pin.caps.includes('adc')) continue;
    const entrada = r.entradas.find(e => (e.boardId ?? 'board') === boardId && e.gpio === pin.gpio);
    // A4/SDA y A5/SCL son el mismo pad. Un alias ausente no borra el valor del otro.
    canales[pin.bit] = entrada?.flotante ? null : (canales[pin.bit] ?? relativo(nombre));
  }
  return { resuelto: r.resuelto, vcc, avcc: vcc, aref: relativo('AREF'), canales };
}
