import { describe, expect, it } from 'vitest';
import { DefinicionComponenteSchema, PerfilDigitalSchema } from '../../../../shared/src/componentes/contratos.js';
const puerto = (id: string) => ({ id, dominio: 'electrico', direccion: 'bidireccional', ancho: 1 });
function contrato() {
  return {
    schemaVersion: 1, id: 'perfil-digital', version: '1.0.0', nombre: 'Perfil declarado', tipo: 'hoja-legada',
    modulo: { id: 'perfil-digital', sha256: 'a'.repeat(64) }, puertos: ['VCC', 'GND', 'I', 'Q', 'RST'].map(puerto),
    parametros: { nivel: { tipo: 'texto', default: 'Z', valores: ['0', '1', 'Z'] } },
    perfilDigital: { alimentacion: { positivo: 'VCC', negativo: 'GND', minVoltios: 2, maxVoltios: 5.5 },
      entradas: { I: { vil: 0.3, vih: 0.7 }, RST: { vil: 0.3, vih: 0.7 } }, salidas: { Q: { parametro: 'nivel' } },
      reset: { puerto: 'RST', activo: 0 }, retardoPs: '1' },
  };
}
describe('contrato del perfil digital', () => {
  it('admite el perfil explícito y conserva las hojas anteriores sin el campo nuevo', () => {
    const c = contrato(); expect(DefinicionComponenteSchema.safeParse(c).success).toBe(true);
    const { perfilDigital: _perfil, ...anterior } = c;
    expect(Object.hasOwn(DefinicionComponenteSchema.parse(anterior), 'perfilDigital')).toBe(false);
  });
  it.each(['0', '-1', '1.5', '01', '1000000000000'])('rechaza retardo ambiguo o fuera de presupuesto: %s', retardoPs => {
    expect(PerfilDigitalSchema.safeParse({ ...contrato().perfilDigital, retardoPs }).success).toBe(false);
  });
  it('rechaza roles solapados, pines ausentes y reset sin umbrales', () => {
    for (const cambio of [
      (c: ReturnType<typeof contrato>) => { c.perfilDigital.alimentacion.positivo = 'Q'; },
      (c: ReturnType<typeof contrato>) => { c.puertos = c.puertos.filter(p => p.id !== 'I'); },
      (c: ReturnType<typeof contrato>) => { c.perfilDigital.reset.puerto = 'Q'; },
    ]) { const c = contrato(); cambio(c); expect(DefinicionComponenteSchema.safeParse(c).success).toBe(false); }
  });
  it('exige un parámetro por salida, enum 0/1/Z y arranque en alta impedancia', () => {
    for (const cambio of [
      (c: ReturnType<typeof contrato>) => { c.parametros.nivel.default = '1'; },
      (c: ReturnType<typeof contrato>) => { c.parametros.nivel.valores = ['0', '1']; },
      (c: ReturnType<typeof contrato>) => { c.perfilDigital.salidas.Q.parametro = 'ausente'; },
      (c: ReturnType<typeof contrato>) => { Object.assign(c.perfilDigital.salidas, { I: { parametro: 'nivel' } }); },
    ]) { const c = contrato(); cambio(c); expect(DefinicionComponenteSchema.safeParse(c).success).toBe(false); }
  });
  it('rechaza umbrales y rangos de alimentación incompatibles', () => {
    const c = contrato(); c.perfilDigital.entradas.I.vil = 0.8;
    expect(DefinicionComponenteSchema.safeParse(c).success).toBe(false);
    c.perfilDigital.entradas.I.vil = 0.3; c.perfilDigital.alimentacion.maxVoltios = 1;
    expect(DefinicionComponenteSchema.safeParse(c).success).toBe(false);
  });
});
