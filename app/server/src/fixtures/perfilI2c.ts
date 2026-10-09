import type { PerfilI2cRc } from '@emu/shared';

const linea = { tensionPullupV: 3.3, resistenciaPullupOhm: 4700, capacitanciaF: 50e-12, resistenciaLowOhm: 50,
  corrienteSinkMaxA: 0.003, fugaA: 0, vilMaxV: 0.99, vihMinV: 2.31, entradaMaxV: 3.6 };
/** Valores sintéticos para oráculos y transporte; no caracterizan una placa comercial. */
export const perfilI2cSintetico: PerfilI2cRc = {
  id: 'sintetico', fuente: 'Oráculo RC; no hardware medido', condiciones: 'Una línea concentrada; maestro único',
  modo: 'standard', fraccionSclBaja: 0.54, sda: { ...linea }, scl: { ...linea },
};
