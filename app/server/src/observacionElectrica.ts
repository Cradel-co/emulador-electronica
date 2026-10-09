import { createHash } from 'node:crypto';
import { firmaDiagramaElectrico, invalidarLecturaElectrica, type ObservacionElectrica, type Project, placasDelProyecto, sonidosDelCircuito } from '@emu/shared';
import { conPlaca, gpioDe } from './diagramOps.js';
import { analizarCircuito, type DireccionPin } from './sim/analisis.js';
import { estadoAlimentacion } from './estadoAlimentacion.js';
import { diffDiagramVsCode, type DiagramWarning } from './pinScan.js';
import { nivelesConPwm, type PwmPin } from './pwmEsp.js';
import type { ModuloCatalogo } from './catalog.js';

/** Incluye topología, propiedades y placas del proyecto leído, sin reloj ni datos personales. */
export function revisionElectrica(project: Project): string {
  return createHash('sha256').update(JSON.stringify({ diagrama: firmaDiagramaElectrico(project),
    board: project.board, language: project.language, boards: project.boards,
    i2cFisico: project.sim.i2cFisico, analogicoAvr: project.sim.analogicoAvr, analogicoEsp: project.sim.analogicoEsp,
  })).digest('hex');
}

/** El fallo o un cambio de contexto retira las medidas; nunca fabrica una lectura de cero. */
export async function finalizarObservacion(
  lectura: ObservacionElectrica, vigente: () => Promise<boolean>,
): Promise<ObservacionElectrica> {
  if (!await vigente()) return invalidarLecturaElectrica({ ...lectura, estado: 'obsoleta' });
  return lectura.resuelto ? lectura : invalidarLecturaElectrica({ ...lectura, estado: 'no-resuelta' });
}

export interface ResultadoObservacion {
  pins: number[];
  warnings: DiagramWarning[];
  electrico: ObservacionElectrica;
}

/** El servidor suministra estado y efectos; este servicio no depende de HTTP, MCP ni WebSocket. */
export interface DependenciasObservacion {
  contexto(): { generacion: number; corriendo: string | null; energizado: string | null };
  capturar(sigue: () => boolean): () => boolean;
  niveles(): ReadonlyMap<string, ReadonlyMap<number, 0 | 1>>;
  pwm(placa: string): ReadonlyMap<number, PwmPin>;
  cerrados(proyecto: string): ReadonlySet<string>;
  pins(proyecto: Project): Promise<number[]>;
  catalogo(): Promise<ModuloCatalogo[]>;
  direcciones(proyecto: Project): Promise<Map<string, Map<number, DireccionPin>>>;
  leerProyecto(nombre: string): Promise<Project>;
  estados: Map<string, Map<string, Record<string, unknown>>>;
  resolver?: typeof analizarCircuito;
}

export function crearServicioObservacion(deps: DependenciasObservacion): (project: Project) => Promise<ResultadoObservacion> {
  const resolver = deps.resolver ?? analizarCircuito;
  async function consultar(
    project: Project,
  ): Promise<ResultadoObservacion> {
    const generacion = deps.contexto().generacion;
    const corriendo = deps.contexto().corriendo;
    const energizado = deps.contexto().energizado;
    const revision = revisionElectrica(project);
    const vigente = deps.capturar(() => generacion === deps.contexto().generacion
      && corriendo === deps.contexto().corriendo && energizado === deps.contexto().energizado);
    const placas = placasDelProyecto(project).map(b => b.id);
    const reportados = project.name === corriendo
      ? new Map([...deps.niveles()].filter(([id]) => placas.includes(id)).map(([id, niveles]) => [id, new Map(niveles)])) : new Map<string, Map<number, 0 | 1>>();
    const pwm = new Map(placas.map(id => [id, project.name === corriendo ? new Map(deps.pwm(id)) : new Map<number, PwmPin>()]));
    const pwmSnapshot = (id: string): ReadonlyMap<number, PwmPin> => pwm.get(id) ?? new Map();
    const cerrados = new Set(deps.cerrados(project.name));
    const fuentesApagadas = !project.board && energizado !== project.name;
    const pins = await deps.pins(project);
    const catalogo = await deps.catalogo();
    const buscar = (t: string): ModuloCatalogo | undefined => catalogo.find((m) => m.type === t);
    const conLaPlaca = conPlaca(project);
    // Con los niveles reales de la simulación: avisos, lo que entrega cada fuente, si la placa tiene energía.
    const estados = deps.estados.get(project.name) ?? new Map<string, Record<string, unknown>>();
    const direccionesPorPlaca = await deps.direcciones(project);
    // Un pin con PWM activo se resuelve en alto: el registro GPIO_OUT que muestrea el puente no
    // refleja lo que maneja el LEDC. Ver nivelesConPwm en pwmEsp.ts.
    const niveles = nivelesConPwm(reportados, pwmSnapshot, placas);
    const vivo = await resolver(conLaPlaca, buscar, { nivelesReales: true, nivelesPorPlaca: niveles, cerrados, fuentesApagadas, estados, direccionesPorPlaca });
    // Lo que cada modelo quiere recordar vuelve en el próximo cálculo (solo del vivo: los otros son hipotéticos).

    const placa = project.board ? estadoAlimentacion(vivo.alimentacion, vivo.resuelto) : null;
    // Misma instantánea para UI, medidas y diagnóstico: LED activo bajo o entre dos
    // GPIO depende de niveles reales. Todos-altos/todos-bajos no son un peor caso general.
    const leds = vivo.leds;
    const { avisos: electricos, fuentes } = vivo;
    const electrico = await finalizarObservacion({
        contexto: { proyecto: project.name, placas, corrida: generacion, revision, topologia: firmaDiagramaElectrico(conLaPlaca) },
        estado: vivo.resuelto ? 'valida' : 'no-resuelta',
        nivelesPorPlaca: Object.fromEntries([...reportados].map(([id, valores]) => [id, Object.fromEntries(valores)])),
        resuelto: vivo.resuelto,
        leds, fuentes, placa, energizado: energizado === project.name, tensiones: vivo.tensiones,
        placas: Object.fromEntries(Object.entries(vivo.alimentacionesPorPlaca ?? {}).map(([id, a]) => [id, estadoAlimentacion(a, vivo.resuelto)])),
        mediciones: vivo.elementos.map((e) => {
          const inst = project.modules.find((m) => m.id === e.dueno);
          const def = inst ? buscar(inst.type) : undefined;
          return {
            modulo: e.dueno,
            moduloNombre: e.dueno === 'board' ? 'Placa' : def?.name ?? e.dueno,
            elemento: e.local,
            tipo: e.tipo,
            tensionV: e.va - e.vb,
            corrienteMa: e.i * 1000,
            potenciaMw: e.p * 1000,
            resistenciaOhm: e.ohms ?? null,
          };
        }),
        modulos: Object.fromEntries(Object.entries(vivo.modulos).map(([id, m]) => [id, m.ui ?? {}])),
        sonidos: sonidosDelCircuito(
          project.modules, (t) => buscar(t)?.salidas, vivo.tensiones,
          (id) => vivo.modulos[id]?.ui,
          // El PWM está indexado por GPIO de la placa; gpioDe sigue el cableado (y los passthrough).
          (id, pin) => {
            if (project.name !== corriendo) return undefined;
            for (const placa of placasDelProyecto(project)) {
              const gpio = gpioDe(project, id, pin, buscar, placa.id);
              if (gpio === null) continue;
              const pwm = pwmSnapshot(placa.id).get(gpio);
              if (pwm) return pwm;
            }
            return undefined;
          },
        ),
      }, async () => {
        if (!vigente()) return false;
        const actual = await deps.leerProyecto(project.name).catch(() => null);
        return vigente() && actual !== null && revisionElectrica(actual) === revision;
      });
    if (electrico.estado === 'valida') {
      for (const [id, m] of Object.entries(vivo.modulos)) if (m.estado) estados.set(id, m.estado);
      deps.estados.set(project.name, estados);
    }
    return {
      pins, electrico,
      warnings: [
        ...(electrico.estado === 'obsoleta' ? [{ kind: 'advertencia-electrica' as const, pin: -1,
          message: 'La observación eléctrica quedó obsoleta durante el cálculo; solicitá una lectura nueva.' }] : []),
        ...diffDiagramVsCode(project, pins, project.board ? buscar(project.board)?.board : undefined),
        ...(electrico.estado !== 'obsoleta' ? electricos : []).map((a) => ({
          kind: a.severidad === 'peligro' ? ('peligro-electrico' as const) : ('advertencia-electrica' as const),
          pin: a.pin,
          message: a.mensaje,
          refs: a.refs,
        })),
      ],
    };
  }

  return consultar;
}
