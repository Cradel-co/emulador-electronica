import { placaDelProyecto, type ModuleDef, type Project } from '@emu/shared';
import type { AnalisisCircuito } from '../sim/analisis.js';
import { gpioDe, pinesSinAlimentar } from '../diagramOps.js';
import { CanalRfSchema } from './canalRf.js';

export interface ValidacionDestinoRf {
  permitirRecepcion: boolean;
  modo: 'funcional' | 'canal-declarado';
  problemas: string[];
  receptorId?: string;
  gpio?: number;
}

/**
 * El presupuesto RF y la disponibilidad eléctrica del destino son condiciones distintas.
 * El llamador debe suministrar una instantánea eléctrica vigente del mismo proyecto.
 * Sin canal conserva la inyección funcional; con canal no deduce alimentación de los cables.
 * No exige un transmisor local: enviar_rf permite una fuente RF externa al dibujo.
 */
export function validarDestinoRf(
  proyecto: Project, buscar: (tipo: string) => ModuleDef | undefined, boardId: string,
  analisis: Pick<AnalisisCircuito, 'resuelto' | 'modulos'> | null | undefined, canalRf?: unknown,
): ValidacionDestinoRf {
  if (canalRf === undefined) return { permitirRecepcion: true, modo: 'funcional', problemas: [] };
  const rechazar = (...problemas: string[]): ValidacionDestinoRf => ({ permitirRecepcion: false, modo: 'canal-declarado', problemas });
  const canal = CanalRfSchema.safeParse(canalRf);
  if (!canal.success) return rechazar('Canal RF inválido; no se autoriza una recepción física.');
  const placa = placaDelProyecto(proyecto, boardId);
  if (!placa || !buscar(placa.board)?.board || !proyecto.modules.some(m => m.id === boardId && m.type === placa.board)) {
    return rechazar(`Placa ${boardId} ausente o sin descriptor; destino RF no resuelto.`);
  }
  const receptor = proyecto.modules.find(r => r.id === canal.data.receptor.id);
  const def = receptor && buscar(receptor.type);
  if (!receptor || def?.bridge?.role !== 'rf-rx') return rechazar('El receptor declarado no existe o no tiene el rol rf-rx.');
  const gpio = gpioDe(proyecto, receptor.id, def.bridge.pin, buscar, boardId);
  if (gpio === null) return rechazar(`El receptor ${receptor.id} no está cableado a un GPIO de ${boardId}.`);
  // Cuenta también receptores apagados/desconocidos: el transporte no elige entre destinos.
  const cableados = proyecto.modules.filter(m => {
    const d = buscar(m.type);
    return d?.bridge?.role === 'rf-rx' && gpioDe(proyecto, m.id, d.bridge.pin, buscar, boardId) !== null;
  });
  if (cableados.length !== 1) return rechazar(`El canal RF requiere un único receptor cableado en ${boardId}; hay ${cableados.length}.`);
  const faltan = pinesSinAlimentar(proyecto, receptor.id, def);
  if (faltan.length) return rechazar(`Alimentación de ${receptor.id} desconectada: ${faltan.join(', ')}.`);
  if (analisis?.resuelto !== true) return rechazar('El circuito no tiene un análisis eléctrico resuelto; alimentación RF desconocida.');
  if (analisis.modulos?.[receptor.id]?.ui?.on !== true) return rechazar(`La alimentación eléctrica de ${receptor.id} no está confirmada por el modelo.`);
  return { permitirRecepcion: true, modo: 'canal-declarado', problemas: [], receptorId: receptor.id, gpio };
}
