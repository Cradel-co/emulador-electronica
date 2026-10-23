import { describe, expect, it } from 'vitest';
import { leerEstadoDigital } from '../../../../server/src/componentes/digital.js';
import type { ResultadoGrafoDc } from '../../../../server/src/componentes/electrico.js';
import type { PerfilDigital } from '../../../../shared/src/componentes/contratos.js';
const perfil: PerfilDigital = { alimentacion: { positivo: 'VCC', negativo: 'GND', minVoltios: 2, maxVoltios: 12 },
  entradas: { I: { vil: 0.3, vih: 0.7 }, RST: { vil: 0.3, vih: 0.7 } }, salidas: {}, reset: { puerto: 'RST', activo: 0 }, retardoPs: '1' };
function resultado(entrada: number | null, vcc: number | null = 20, reset: number | null = 20): Extract<ResultadoGrafoDc, { resuelto: true }> {
  return { resuelto: true, grafo: { instancias: [], redes: [] }, diagnosticos: [], elementos: [],
    tensiones: Object.entries({ VCC: vcc, GND: 10, I: entrada, RST: reset }).map(([puerto, voltios]) => ({ ruta: ['a'], puerto, voltios, referenciada: true })) };
}
describe('decodificación eléctrica de entradas y alimentación', () => {
  it.each([[10, 0], [13, 0], [15, 'X'], [17, 1], [20, 1]] as const)('usa GND local y umbrales: %s V → %s', (v, nivel) => {
    expect(leerEstadoDigital(perfil, ['a'], resultado(v))).toMatchObject({ estado: 'activo', alimentacionVoltios: 10, entradas: { I: nivel } });
  });
  it('una entrada sin medida es indeterminada; un reset indeterminado mantiene reset', () => {
    expect(leerEstadoDigital(perfil, ['a'], resultado(null)).entradas.I).toBe('X');
    expect(leerEstadoDigital(perfil, ['a'], resultado(20, 20, 15)).estado).toBe('reset');
  });
  it.each([null, 10, 23])('deshabilita el bloque si su alimentación no está dentro del perfil: %s', vcc => {
    expect(leerEstadoDigital(perfil, ['a'], resultado(20, vcc))).toMatchObject({ estado: 'apagado', entradas: { I: 'X', RST: 'X' } });
  });
  it('no comparte entradas ni usa por accidente medidas de otra instancia', () => {
    const dc = resultado(20); dc.tensiones.push(...resultado(10).tensiones.map(t => ({ ...t, ruta: ['b'] })));
    expect(leerEstadoDigital(perfil, ['a'], dc).entradas.I).toBe(1);
    expect(leerEstadoDigital(perfil, ['b'], dc).entradas.I).toBe(0);
  });
  it('admite reset activo en alto y no confunde falta de referencia con un cero', () => {
    const alto = { ...perfil, reset: { puerto: 'RST', activo: 1 as const } };
    expect(leerEstadoDigital(alto, ['a'], resultado(20)).estado).toBe('reset');
    expect(leerEstadoDigital(alto, ['a'], resultado(20, 20, 10)).estado).toBe('activo');
    const dc = resultado(10); const entrada = dc.tensiones.find(t => t.puerto === 'I');
    if (!entrada) throw new Error('fixture'); entrada.referenciada = false;
    expect(leerEstadoDigital(perfil, ['a'], dc).entradas.I).toBe('X');
  });

});
