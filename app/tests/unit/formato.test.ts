import { describe, expect, it } from 'vitest';
import { fmtMw, fmtOhm } from '../../web/formato.js';

describe('formato de mediciones eléctricas', () => {
  it('muestra resistencias en Ω, kΩ o MΩ y deja guion cuando el componente no es resistivo', () => {
    expect(fmtOhm(220)).toBe('220 Ω');
    expect(fmtOhm(10_000)).toBe('10.00 kΩ');
    expect(fmtOhm(1_000_000)).toBe('1.00 MΩ');
    expect(fmtOhm(1_000_000_000)).toBe('1.00 GΩ');
    expect(fmtOhm(null)).toBe('—');
  });

  it('muestra potencia pequeña en mW y potencia alta en W', () => {
    expect(fmtMw(37.4)).toBe('37 mW');
    expect(fmtMw(1250)).toBe('1.25 W');
  });
});
