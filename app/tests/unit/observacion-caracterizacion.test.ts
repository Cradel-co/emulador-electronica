import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { ProjectSchema, placasDelProyecto, firmaDiagramaElectrico, sonidosDelCircuito, type Project } from '@emu/shared';
import { observacionOriginal } from './fixtures/coordinacion-original.js';
import { crearServicioObservacion, finalizarObservacion, revisionElectrica, type ResultadoObservacion, type DependenciasObservacion } from '../../server/src/observacionElectrica.js';
import { analizarCircuito } from '../../server/src/sim/analisis.js';
import { loadCatalog } from '../../server/src/catalog.js';
import { conPlaca, gpioDe } from '../../server/src/diagramOps.js';
import { estadoAlimentacion } from '../../server/src/estadoAlimentacion.js';
import { diffDiagramVsCode } from '../../server/src/pinScan.js';
import { nivelesConPwm, type PwmPin } from '../../server/src/pwmEsp.js';
import { VigenciaElectrica } from '../../server/src/vigenciaElectrica.js';

function vieja(d: DependenciasObservacion): (p: Project) => Promise<ResultadoObservacion> {
  const entorno = {
    get runGeneration() { return d.contexto().generacion; }, get runningProject() { return d.contexto().corriendo; }, get proyectoEnergizado() { return d.contexto().energizado; },
    get nivelesPorPlaca() { return d.niveles(); }, pwmDePlaca: d.pwm, cerradosDe: d.cerrados, pinsDeCodigo: d.pins, loadCatalog: d.catalogo,
    estadosModulos: d.estados, direccionesTodas: d.direcciones, store: { read: d.leerProyecto }, vigenciaElectrica: { capturar: d.capturar },
    analizarCircuito: d.resolver ?? analizarCircuito, placasDelProyecto, firmaDiagramaElectrico, sonidosDelCircuito, conPlaca, gpioDe, estadoAlimentacion,
    diffDiagramVsCode, nivelesConPwm, finalizarObservacion, revisionElectrica,
  };
  return runInNewContext(ts.transpileModule(`${observacionOriginal}\navisosDelProyecto`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, entorno);
}
const proyecto = () => ProjectSchema.parse({ name: 'prueba', board: 'esp32-s3-devkitc-1', language: 'micropython', sim: { wifiSsid: 'x', wifiPassword: '' }, modules: [
  { id: 'board', type: 'esp32-s3-devkitc-1', x: 0, y: 0, props: { usb: true } },
  { id: 'led', type: 'led', x: 100, y: 0, props: {} }, { id: 'r', type: 'resistor', x: 200, y: 0, props: { ohms: 220 } },
], wires: [{ from: 'board.GPIO7', to: 'r.1' }, { from: 'r.2', to: 'led.IN' }, { from: 'led.GND', to: 'board.GND' }] });

async function arnes(p: Project) {
  const catalogo = await loadCatalog(), vigencia = new VigenciaElectrica();
  const contexto = { generacion: 1, corriendo: p.name as string | null, energizado: null as string | null };
  const niveles = new Map([['board', new Map<number, 0 | 1>([[7, 1]])]]);
  const pwm = new Map<number, PwmPin>();
  const estados = new Map<string, Map<string, Record<string, unknown>>>();
  const d: DependenciasObservacion = { contexto: () => contexto, capturar: sigue => vigencia.capturar(sigue), niveles: () => niveles,
    pwm: () => pwm, cerrados: () => new Set(), pins: async () => [7], catalogo: async () => catalogo,
    direcciones: async () => new Map([['board', new Map([[7, { salida: true }]])]]), leerProyecto: async () => p, estados };
  return { d, contexto, niveles, pwm, vigencia, estados };
}
function requerido<T>(valor: T | undefined): T {
  if (valor === undefined) throw new Error('Fixture incompleta');
  return valor;
}
const plano = (x: unknown) => JSON.parse(JSON.stringify(x));

it('la observación extraída coincide con main para niveles, alimentación y resistencias variadas', async () => {
  let semilla = 42;
  for (let i = 0; i < 12; i++) {
    semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0;
    const p = proyecto(); requerido(p.modules[0]).props.usb = i % 3 !== 0; requerido(p.modules[2]).props.ohms = 100 + semilla % 2000;
    const a = await arnes(p), b = await arnes(structuredClone(p));
    requerido(a.niveles.get('board')).set(7, i % 2 as 0 | 1); requerido(b.niveles.get('board')).set(7, i % 2 as 0 | 1);
    const antes = await vieja(a.d)(p), despues = await crearServicioObservacion(b.d)(p);
    expect(plano(despues)).toEqual(plano(antes)); expect(despues.electrico.estado).toBe('valida');
  }
});

it.each(['original', 'extraída'] as const)('%s captura GPIO/PWM antes de esperar y no usa mutaciones posteriores', async version => {
  const p = proyecto(), a = await arnes(p);
  a.pwm.set(7, { hz: 440, duty: .5 });
  let liberar: () => void = () => { throw new Error('Promesa no inicializada'); }; const pausa = new Promise<void>(r => { liberar = r; });
  a.d.pins = async () => { await pausa; return [7]; };
  const resolver = vi.fn(analizarCircuito); a.d.resolver = resolver;
  const consulta = (version === 'original' ? vieja(a.d) : crearServicioObservacion(a.d))(p);
  requerido(a.niveles.get('board')).set(7, 0); a.pwm.clear(); liberar();
  const resultado = await consulta;
  expect(resultado.electrico.nivelesPorPlaca).toEqual({ board: { 7: 1 } });
  expect(resolver.mock.calls[0]?.[2]?.nivelesPorPlaca?.get('board')?.get(7)).toBe(1);
});

it.each(['original', 'extraída'] as const)('%s retira una respuesta vieja y no publica estado interno del modelo', async version => {
  const p = proyecto(), a = await arnes(p);
  // La solución real se obtiene con el mismo adaptador que el servicio, sin códigos de transporte.
  const catalogo = await a.d.catalogo();
  const solucion = await analizarCircuito(conPlaca(p), type => catalogo.find(m => m.type === type), { nivelesReales: true, niveles: new Map([[7, 1]]) });
  a.d.resolver = async () => { a.contexto.generacion++; return { ...solucion, modulos: { led: { ui: { on: true }, estado: { memoria: 7 } } } }; };
  const r = await (version === 'original' ? vieja(a.d) : crearServicioObservacion(a.d))(p);
  expect(r.electrico).toMatchObject({ estado: 'obsoleta', resuelto: false, leds: [], tensiones: {} });
  expect(a.estados.size).toBe(0); expect(r.warnings.some(w => w.message.includes('obsoleta'))).toBe(true);
});
