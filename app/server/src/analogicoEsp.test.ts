import { beforeAll, describe, expect, it } from 'vitest';
import { perfilEspPrueba, proyectoEspPrueba } from './fixtures/analogicoEsp.js';
import { PerfilAnalogicoEspSchema, type PerfilAnalogicoEsp } from '@emu/shared';
import { PuenteAnalogicoEsp, estadoAnalogicoEspDesdeCircuito, type EstadoAnalogicoEsp } from './analogicoEsp.js';
import { loadCatalog, type ModuloCatalogo } from './catalog.js';
import { analizarCircuito } from './sim/analisis.js';

const estado = (v: number | null): EstadoAnalogicoEsp => ({ resuelto: true, vcc: 3.3, canales: { 4: v } });
function puente(perfil: PerfilAnalogicoEsp | undefined = perfilEspPrueba()) {
  const lineas: string[] = [];
  const adc = new PuenteAnalogicoEsp('esp32s3', perfil, l => lineas.push(l));
  adc.actualizar(estado(1.6));
  return { adc, lineas };
}
describe('ADC MicroPython explícito', () => {
  it('cuantiza por GPIO/atenuación: oráculo independiente de mitades, escalones y saturación', () => {
    const { adc, lineas } = puente();
    for (const [id, v, atten] of [[1, 0, 3], [2, 1.6, 3], [3, 3.2, 3], [4, 3.3, 3], [5, 0.5, 0], [6, 0.5002, 0]]) {
      adc.actualizar(estado(v ?? null)); adc.recibir(`@ADC ${id} 4 ${atten}`);
    }
    expect(lineas).toEqual(['@ADCR 1 0', '@ADCR 2 2048', '@ADCR 3 4095', '@ADCR 4 4095', '@ADCR 5 2048', '@ADCR 6 2049']);
  });
  it('sin perfil o sin GPIO/atenuación declarado devuelve error explícito', () => {
    const lineas: string[] = [];
    const sin = new PuenteAnalogicoEsp('esp32s3', undefined, l => lineas.push(l));
    sin.actualizar(estado(1)); sin.recibir('@ADC 7 4 3');
    expect(lineas).toEqual(['@ADCR 7 E:SIN_MODELO']);
    const p = puente(); p.adc.recibir('@ADC 8 4 2'); p.adc.recibir('@ADC 9 5 3');
    expect(p.lineas).toEqual(['@ADCR 8 E:SIN_MODELO_CANAL', '@ADCR 9 E:SIN_MODELO_CANAL']);
  });
  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])('rechaza voltaje desconocido/inválido %s', v => {
    const p = puente(); p.adc.actualizar(estado(v)); p.adc.recibir('@ADC 1 4 3');
    expect(p.lineas).toEqual(['@ADCR 1 E:ENTRADA_DESCONOCIDA']);
  });
  it('rechaza snapshot no resuelto, rail ausente/fuera de rango, entrada fuera de dominio y ADC2', () => {
    const p = puente();
    const estados: EstadoAnalogicoEsp[] = [{ ...estado(1), resuelto: false }, { ...estado(1), vcc: null }, { ...estado(1), vcc: 2 }, estado(-0.01), estado(3.4)];
    estados.forEach((e, i) => { p.adc.actualizar(e); p.adc.recibir(`@ADC ${i} 4 3`); });
    p.adc.recibir('@ADC 5 11 3');
    expect(p.lineas).toEqual(['@ADCR 0 E:SIN_SOLUCION', '@ADCR 1 E:ALIMENTACION_DESCONOCIDA', '@ADCR 2 E:ALIMENTACION_FUERA_DOMINIO', '@ADCR 3 E:ENTRADA_FUERA_DOMINIO', '@ADCR 4 E:ENTRADA_FUERA_DOMINIO', '@ADCR 5 E:GPIO_SIN_ADC1']);
  });
  it('copia snapshot/perfil y cada placa mantiene su lectura independiente', () => {
    const perfil = perfilEspPrueba(), e = { ...estado(1.6), canales: { 4: 1.6 } }, lineas: string[] = [];
    const a = new PuenteAnalogicoEsp('esp32s3', perfil, l => lineas.push(l)); a.actualizar(e);
    const b = puente(); b.adc.actualizar(estado(0.8));
    e.canales[4] = 0;
    const canal = perfil.canales[0]; if (!canal) throw new Error('Falta canal de prueba');
    canal.voltajeFondoEscalaV = 100;
    a.recibir('@ADC 1 4 3'); b.adc.recibir('@ADC 1 4 3');
    expect(lineas).toEqual(['@ADCR 1 2048']); expect(b.lineas).toEqual(['@ADCR 1 1024']);
  });
  it('rechaza perfil de otro chip y peticiones malformadas sin ejecutar otro protocolo', () => {
    expect(() => new PuenteAnalogicoEsp('esp32c3', perfilEspPrueba(), () => {})).toThrow(/chip/);
    const p = puente(); p.adc.recibir('@I2C 1 4 3'); p.adc.recibir('@ADC 2 4.5 3'); p.adc.recibir('@ADC 3 4 8'); p.adc.recibir('@ADC 4 4 3 extra');
    expect(p.lineas).toEqual(['@ADCR 2 E:PETICION_INVALIDA', '@ADCR 3 E:PETICION_INVALIDA', '@ADCR 4 E:PETICION_INVALIDA']);
  });
  it('valida parámetros y procedencia, rangos, duplicados y mapeo por chip', () => {
    expect(PerfilAnalogicoEspSchema.safeParse(perfilEspPrueba()).success).toBe(true);
    for (const cambios of [{ fuente: '' }, { chip: 'esp32' }, { rangoVAlimentacion: { min: 0, max: 3.3 } }, { desconocido: true }]) {
      expect(PerfilAnalogicoEspSchema.safeParse({ ...perfilEspPrueba(), ...cambios }).success).toBe(false);
    }
    const base = perfilEspPrueba().canales[0];
    for (const cambios of [{ gpio: 11 }, { gpio: 1.5 }, { voltajeCeroV: 4 }, { voltajeFondoEscalaV: Infinity }, { rangoVEntrada: { min: 2, max: 1 } }]) {
      expect(PerfilAnalogicoEspSchema.safeParse({ ...perfilEspPrueba(), canales: [{ ...base, ...cambios }] }).success).toBe(false);
    }
    expect(PerfilAnalogicoEspSchema.safeParse({ ...perfilEspPrueba(), canales: [base, base] }).success).toBe(false);
  });
  it.each([['esp32s3', 10, 11], ['esp32c3', 4, 5], ['esp32c6', 6, 7]] as const)('valida el límite ADC1 de %s sin admitir ADC2', (chip, ultimo, fuera) => {
    const p = perfilEspPrueba(); p.chip = chip;
    p.canales = p.canales.map(c => ({ ...c, gpio: ultimo }));
    expect(PerfilAnalogicoEspSchema.safeParse(p).success).toBe(true);
    p.canales = p.canales.map(c => ({ ...c, gpio: fuera }));
    expect(PerfilAnalogicoEspSchema.safeParse(p).success).toBe(false);
  });
  it('el rango declarado restringe la lectura aunque siga dentro de GND..VCC', () => {
    const perfil = perfilEspPrueba();
    perfil.canales = perfil.canales.map(c => ({ ...c, rangoVEntrada: { min: 0.2, max: 1.5 } }));
    const p = puente(perfil); p.adc.recibir('@ADC 1 4 3');
    p.adc.actualizar(estado(0.1)); p.adc.recibir('@ADC 2 4 3');
    expect(p.lineas).toEqual(['@ADCR 1 E:ENTRADA_FUERA_DOMINIO', '@ADCR 2 E:ENTRADA_FUERA_DOMINIO']);
  });
});

let catalogo: ModuloCatalogo[] = [];
beforeAll(async () => { catalogo = await loadCatalog(); });
const buscar = (t: string) => catalogo.find(m => m.type === t);
it('solver real → snapshot ADC ESP relativo a GND, entradas sin cable/flotantes unknown', async () => {
  const project = proyectoEspPrueba(), desc = buscar(project.board ?? '')?.board;
  if (!desc) throw new Error('Falta placa');
  const r = await analizarCircuito(project, buscar);
  const e = estadoAnalogicoEspDesdeCircuito('board', desc, r);
  expect(e.resuelto).toBe(true); expect(e.vcc).toBeCloseTo(3.3, 3); expect(e.canales[4]).toBeCloseTo(1.65, 3); expect(e.canales[5]).toBeNull();
  const desplazado = estadoAnalogicoEspDesdeCircuito('board', desc, { ...r, tensiones: Object.fromEntries(Object.entries(r.tensiones).map(([pin, v]) => [pin, v + 4])) });
  expect(desplazado.vcc).toBeCloseTo(e.vcc ?? -1, 9); expect(desplazado.canales[4]).toBeCloseTo(e.canales[4] ?? -1, 9);
  project.wires = [{ from: 'board.GPIO4', to: 'r1.1' }];
  const flotante = estadoAnalogicoEspDesdeCircuito('board', desc, await analizarCircuito(project, buscar));
  expect(flotante.canales[4]).toBeNull();
});
