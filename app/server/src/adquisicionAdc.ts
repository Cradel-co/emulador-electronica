import { PerfilAnalogicoAvrSchema, type CanalAnalogicoAvr, type PerfilAnalogicoAvr } from '@emu/shared';

export interface MuestraAdc {
  canal: CanalAnalogicoAvr;
  voltaje: number | null;
  referencia: number | null;
  avcc: number | null;
  /** Ventana máxima disponible hasta el sample-and-hold del MCU, en segundos. */
  ventanaS: number;
}
export interface ResultadoMuestraAdc {
  perfil: PerfilAnalogicoAvr['tipo'];
  voltajeRetenido: number;
  ruidoLsb: number;
  cuenta: number;
}

/**
 * Equivalente RC con Vin constante durante la adquisición:
 * Vhold'=Vin+(Vhold−Vin)·exp(−t/((Rfuente+Rinterruptor)·C)).
 * Fuente del fenómeno y memoria entre canales: TI SPNA061, §§4–6:
 * https://www.ti.com/lit/an/spna061/spna061.pdf
 * Los parámetros son explícitos: los ejemplos TMS470 de TI no caracterizan al Uno.
 * No incluye carga devuelta al solver, fuga, kickback, INL/DNL ni deriva térmica.
 */
export class AdquisicionAdc {
  readonly perfil: PerfilAnalogicoAvr['tipo'];
  private readonly parametros: PerfilAnalogicoAvr;
  private retenido: number;
  private semilla: number;
  constructor(perfil: PerfilAnalogicoAvr = { tipo: 'ideal-10bits' }) {
    this.parametros = PerfilAnalogicoAvrSchema.parse(perfil);
    this.perfil = this.parametros.tipo;
    this.retenido = this.parametros.tipo === 'rc-no-ideal' ? this.parametros.voltajeInicialV : 0;
    this.semilla = this.parametros.tipo === 'rc-no-ideal' ? this.parametros.ruido?.semilla ?? 0 : 0;
  }
  convertir(m: MuestraAdc): ResultadoMuestraAdc {
    const numero = (v: number | null | undefined, nombre: string): number => {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`ADC: ${nombre} desconocido o no finito.`);
      return v;
    };
    const vin = numero(m.voltaje, 'VIN'), vref = numero(m.referencia, 'referencia'), avcc = numero(m.avcc, 'AVCC');
    if (avcc <= 0 || vref <= 0 || vref > avcc || vin < 0 || vin > avcc) throw new Error('ADC: tensión fuera del dominio GND..AVCC o referencia inválida.');
    const p = this.parametros;
    let retenido = vin, ganancia = 1, offset = 0, ruidoLsb = 0, semilla = this.semilla;
    if (p.tipo === 'rc-no-ideal') {
      if (vin < p.rangoVEntrada.min || vin > p.rangoVEntrada.max) throw new Error(`ADC: VIN fuera del rango declarado por ${p.id}.`);
      if (this.retenido < 0 || this.retenido > avcc) throw new Error('ADC: voltaje retenido fuera de GND..AVCC; no hay modelo de clamps del capacitor.');
      const ventana = numero(m.ventanaS, 'ventana de adquisición');
      if (ventana <= 0 || p.adquisicionS > ventana) throw new Error('ADC: adquisición fuera de la ventana disponible del MCU.');
      const r = numero(p.resistenciasFuenteOhm[m.canal], `impedancia de ${m.canal}`) + p.resistenciaInterruptorOhm;
      const tau = r * p.capacitanciaF;
      if (!Number.isFinite(r) || !Number.isFinite(tau) || (r > 0 && tau === 0)) throw new Error('ADC: constante de tiempo RC no representable.');
      // expm1 evita cancelar los dígitos significativos cuando t/tau es muy pequeño.
      const carga = p.adquisicionS === 0 ? 0 : r === 0 ? 1 : -Math.expm1(-p.adquisicionS / tau);
      retenido = this.retenido + (vin - this.retenido) * carga;
      ganancia = p.ganancia; offset = p.offsetLsb;
      if (p.ruido) {
        // LCG32 reproducible, no criptográfico. Ruido uniforme sintético, no ruido medido.
        semilla = (Math.imul(1664525, semilla) + 1013904223) >>> 0;
        ruidoLsb = (((semilla + 0.5) / 4294967296) * 2 - 1) * p.ruido.amplitudLsb;
      }
    }
    const continuo = retenido * 1024 / vref * ganancia + offset + ruidoLsb;
    if (!Number.isFinite(continuo)) throw new Error('ADC: resultado del perfil no representable.');
    // Un error de dominio no consume carga ni un valor del generador de ruido.
    this.retenido = retenido; this.semilla = semilla;
    return { perfil: this.perfil, voltajeRetenido: retenido, ruidoLsb,
      cuenta: Math.min(1023, Math.max(0, Math.floor(continuo))) };
  }
}
