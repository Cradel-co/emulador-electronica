import { createHash } from 'node:crypto';
import { firmaDiagramaElectrico, invalidarLecturaElectrica, type ObservacionElectrica, type Project } from '@emu/shared';

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
