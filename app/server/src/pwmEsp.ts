/**
 * El PWM que el firmware declara por el puente: `@PWM <gpio> <hz> <duty_u16> <ticks>`, y
 * `@PWM <gpio> off 0 <ticks>` cuando el programa libera el pin.
 *
 * Es declarativo a propósito. El puente muestrea los registros de salida GPIO, así que un tono de
 * kilohercios no se puede reconstruir de los flancos: se perdería en el aliasing. El firmware
 * avisa una vez qué frecuencia y qué ciclo de trabajo puso, y de ahí sale el tono que sintetiza
 * el navegador y el valor medio que usa quien lo necesite. Ver SDD-AUDIO.md.
 */

/** Lo que el firmware declaró sobre un pin. `duty` normalizado a 0..1. */
export interface PwmPin {
  hz: number;
  duty: number;
}

const U16_MAX = 65535;
const enteroNoNegativo = (s: string | undefined): number | null => {
  if (s === undefined || !/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

export class PuentePwm {
  private readonly pines = new Map<number, PwmPin>();

  constructor(private readonly alCambiar?: () => void) {}

  /** Devuelve true solo si la línea era un `@PWM` bien formado. */
  recibir(linea: string): boolean {
    if (linea.length > 200) return false;
    const partes = linea.trim().split(/\s+/);
    if (partes[0] !== '@PWM' || partes.length !== 5) return false;
    const gpio = enteroNoNegativo(partes[1]);
    if (gpio === null) return false;
    if (partes[2] === 'off') {
      const habia = this.pines.delete(gpio);
      if (habia) this.alCambiar?.();
      return true;
    }
    const hz = enteroNoNegativo(partes[2]);
    const u16 = enteroNoNegativo(partes[3]);
    if (hz === null || u16 === null || u16 > U16_MAX) return false;
    const antes = this.pines.get(gpio);
    const duty = u16 / U16_MAX;
    if (antes && antes.hz === hz && antes.duty === duty) return true;
    this.pines.set(gpio, { hz, duty });
    this.alCambiar?.();
    return true;
  }

  estado(): ReadonlyMap<number, PwmPin> {
    return this.pines;
  }

  /** El PWM no sobrevive un reset del programa. */
  limpiar(): void {
    if (this.pines.size === 0) return;
    this.pines.clear();
    this.alCambiar?.();
  }
}
