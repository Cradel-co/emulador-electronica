/** Metadatos propios: MDX representa el contenido, sin gobernar navegación ni progreso. */
export interface LeccionMdx {
  id: string;
  rutaId: string;
  titulo: string;
  descripcion: string;
  revision: number;
  minutos: number;
  requisitos: readonly string[];
  ejemploId: 'ohm' | 'serie' | 'paralelo' | 'divisor-cargado';
  observaciones: readonly { magnitud: string; valor: string }[];
}

export const RUTA_PILOTO = 'ohm-kirchhoff-tellegen';
export const leccionesMdx: readonly LeccionMdx[] = ([
  { id: 'magnitudes-dc', titulo: 'Tensión, corriente y resistencia', descripcion: 'Identificá qué se mide entre dos puntos y qué circula por una rama.', minutos: 8, requisitos: [], ejemploId: 'ohm', observaciones: [{ magnitud: 'Tensión en R1', valor: '5 V' }, { magnitud: 'Corriente por R1', valor: '5 mA' }] },
  { id: 'ley-ohm', titulo: 'La ley de Ohm en acción', descripcion: 'Predecí la corriente y comprobá qué cambia al variar la resistencia.', minutos: 10, requisitos: ['magnitudes-dc'], ejemploId: 'ohm', observaciones: [{ magnitud: 'R1', valor: '1 kΩ' }, { magnitud: 'Corriente', valor: '5 mA' }, { magnitud: 'Potencia absorbida', valor: '25 mW' }] },
  { id: 'redes-resistivas', titulo: 'Serie, paralelo y divisor con carga', descripcion: 'Reducí una red resistiva y descubrí por qué una carga cambia la salida del divisor.', minutos: 15, requisitos: ['ley-ohm'], ejemploId: 'divisor-cargado', observaciones: [{ magnitud: 'Salida (R1.2 respecto de GND)', valor: '1,667 V' }, { magnitud: 'Corriente de la fuente', valor: '3,333 mA' }, { magnitud: 'Corriente en R2 y R3', valor: '1,667 mA por rama' }] },
  { id: 'kirchhoff-corrientes', titulo: 'Kirchhoff: conservación de corriente', descripcion: 'Elegí un nodo y verificá que las corrientes que entran y salen se equilibran.', minutos: 10, requisitos: ['redes-resistivas'], ejemploId: 'paralelo', observaciones: [{ magnitud: 'Rama R1', valor: '5 mA' }, { magnitud: 'Rama R2', valor: '2,5 mA' }, { magnitud: 'Corriente de la fuente', valor: '7,5 mA' }] },
  { id: 'kirchhoff-tensiones', titulo: 'Kirchhoff: suma de tensiones', descripcion: 'Recorré un lazo cerrado y sumá las subidas y caídas con signos consistentes.', minutos: 10, requisitos: ['kirchhoff-corrientes'], ejemploId: 'serie', observaciones: [{ magnitud: 'Tensión de fuente', valor: '5 V' }, { magnitud: 'Caída en R1 y R2', valor: '2,5 V cada una' }, { magnitud: 'Corriente del lazo', valor: '2,5 mA' }] },
  { id: 'tellegen-potencia', titulo: 'Tellegen: balance de potencia', descripcion: 'Usá la convención pasiva para comparar la potencia entregada con la absorbida.', minutos: 12, requisitos: ['kirchhoff-tensiones'], ejemploId: 'serie', observaciones: [{ magnitud: 'Potencia absorbida por R1 y R2', valor: '+6,25 mW cada una' }, { magnitud: 'Potencia de la fuente (convención pasiva)', valor: '−12,5 mW' }, { magnitud: 'Suma algebraica', valor: '0 mW' }] },
] satisfies readonly Omit<LeccionMdx, 'revision' | 'rutaId'>[]).map(leccion => ({ ...leccion, rutaId: RUTA_PILOTO, revision: 1 }));

export function leccionMdxPorId(id: string): LeccionMdx | undefined {
  return leccionesMdx.find(leccion => leccion.id === id);
}
