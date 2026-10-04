import { describe, expect, it } from 'vitest';
import type { AlimentacionPlaca } from './sim/tipos.js';
import { estadoAlimentacion, puedeArrancar, motivoSinArranque } from './estadoAlimentacion.js';

const ok: AlimentacionPlaca = {
  estado: 'ok', via: 'usb', pin: null, entrada: null, fuenteId: null,
  v: 3.3, consumoMa: 100, consumeDe: null, mensaje: 'Alimentación dentro del rango del modelo.',
};

describe('alimentación sin daño permanente supuesto', () => {
  it('sobretensión impide ejecutar pero reparar la alimentación permite volver a arrancar', () => {
    const riesgo = estadoAlimentacion({ ...ok, estado: 'quema', mensaje: 'Sobretensión fuera del rango del modelo.', v: 7 }, true);
    expect(puedeArrancar(riesgo)).toBe(false);
    expect(riesgo.quemada).toBe(false);
    expect(motivoSinArranque(riesgo)).toBe('Sobretensión fuera del rango del modelo.');
    const reparada = estadoAlimentacion(ok, true);
    expect(puedeArrancar(reparada)).toBe(true);
    expect(reparada.quemada).toBe(false);
    expect(motivoSinArranque(reparada)).toBeNull();
  });

  it('un análisis inválido no permite arrancar aunque haya un estado ok anterior', () => {
    const invalido = estadoAlimentacion(ok, false);
    expect(puedeArrancar(invalido)).toBe(false);
    expect(motivoSinArranque(invalido)).toMatch(/no.*válid/i);
    expect(invalido.quemada).toBe(false);
  });

  it.each(['sin-energia', 'baja', 'quema'] as const)('%s bloquea sin afirmar que hubo daño permanente', estado => {
    const a = estadoAlimentacion({ ...ok, estado, mensaje: 'No puede ejecutarse.' });
    expect(puedeArrancar(a)).toBe(false);
    expect(a.quemada).toBe(false);
    expect(motivoSinArranque(a)).toBe('No puede ejecutarse.');
  });
});
