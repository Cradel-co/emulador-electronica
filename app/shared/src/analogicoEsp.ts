import { z } from 'zod';

export const ChipAnalogicoEspSchema = z.enum(['esp32s3', 'esp32c3', 'esp32c6']);
export type ChipAnalogicoEsp = z.infer<typeof ChipAnalogicoEspSchema>;
export const AtenuacionAnalogicaEspSchema = z.enum(['0db', '2.5db', '6db', '11db']);

/** ADC1 solamente: ADC2 necesita arbitraje/WiFi, fuera de este modelo.
 * Mapeo oficial: MicroPython v1.29.0 ports/esp32/machine_adc.c (madc_obj).
 * https://github.com/micropython/micropython/blob/v1.29.0/ports/esp32/machine_adc.c
 */
export function gpioAdc1EspValido(chip: string, gpio: number): boolean {
  if (!Number.isInteger(gpio)) return false;
  return chip === 'esp32s3' ? gpio >= 1 && gpio <= 10
    : chip === 'esp32c3' ? gpio >= 0 && gpio <= 4
      : chip === 'esp32c6' ? gpio >= 0 && gpio <= 6 : false;
}

const voltaje = z.number().finite().nonnegative();
const rango = z.object({ min: voltaje, max: voltaje }).strict();
/** Perfil de escenario explícito, no curva/eFuse del fabricante ni calibración de laboratorio.
 * Q = clip(floor(4096 * (Vin - cero) / (fondoEscala - cero)), 0, 4095).
 * Los rangos declaran el dominio de aplicación, no garantías de seguridad del silicio.
 */
export const PerfilAnalogicoEspSchema = z.object({
  tipo: z.literal('micropython-lineal-explicito-12bits'),
  chip: ChipAnalogicoEspSchema,
  id: z.string().trim().min(1).max(120),
  fuente: z.string().trim().min(1).max(2000),
  condiciones: z.string().trim().min(1).max(2000),
  rangoVAlimentacion: rango,
  canales: z.array(z.object({
    gpio: z.number().int().nonnegative(),
    atenuacion: AtenuacionAnalogicaEspSchema,
    rangoVEntrada: rango,
    voltajeCeroV: voltaje,
    voltajeFondoEscalaV: voltaje,
  }).strict()).min(1).max(40),
}).strict().superRefine((perfil, ctx) => {
  const fallo = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (perfil.rangoVAlimentacion.min <= 0 || perfil.rangoVAlimentacion.max < perfil.rangoVAlimentacion.min) fallo(['rangoVAlimentacion'], 'Se requiere 0 < min <= max.');
  const vistos = new Set<string>();
  perfil.canales.forEach((canal, i) => {
    if (!gpioAdc1EspValido(perfil.chip, canal.gpio)) fallo(['canales', i, 'gpio'], 'GPIO sin ADC1 modelado en este chip.');
    if (canal.rangoVEntrada.max <= canal.rangoVEntrada.min) fallo(['canales', i, 'rangoVEntrada'], 'Se requiere min < max.');
    if (canal.voltajeFondoEscalaV <= canal.voltajeCeroV) fallo(['canales', i, 'voltajeFondoEscalaV'], 'El fondo de escala debe superar el cero.');
    const clave = `${canal.gpio}:${canal.atenuacion}`;
    if (vistos.has(clave)) fallo(['canales', i], 'GPIO/atenuación duplicados.');
    vistos.add(clave);
  });
});
export type PerfilAnalogicoEsp = z.infer<typeof PerfilAnalogicoEspSchema>;
