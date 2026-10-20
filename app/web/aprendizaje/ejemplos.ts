/** Circuitos ideales de las lecciones: describen la predicción, antes de simular. */
type DatosCircuito =
  | { topologia: 'simple'; r1: number }
  | { topologia: 'serie'; r1: number; r2: number }
  | { topologia: 'paralelo'; r1: number; r2: number; ramaAbierta?: boolean }
  | { topologia: 'divisor'; r1: number; r2: number; r3?: number };
export type EjemploCircuito = DatosCircuito & { id: string; titulo: string; tension: number };

export const ejemplosCircuito = [
  { id: 'ohm', titulo: 'Una resistencia de 1 kΩ', tension: 5, topologia: 'simple', r1: 1000 },
  { id: 'ohm-2k', titulo: 'Duplicar la resistencia', tension: 5, topologia: 'simple', r1: 2000 },
  { id: 'serie', titulo: 'Dos resistencias iguales en serie', tension: 5, topologia: 'serie', r1: 1000, r2: 1000 },
  { id: 'serie-desigual', titulo: 'Resistencias de 1 kΩ y 2 kΩ en serie', tension: 5, topologia: 'serie', r1: 1000, r2: 2000 },
  { id: 'paralelo', titulo: 'Dos ramas en paralelo', tension: 5, topologia: 'paralelo', r1: 1000, r2: 2000 },
  { id: 'paralelo-rama-abierta', titulo: 'Una rama abierta', tension: 5, topologia: 'paralelo', r1: 1000, r2: 2000, ramaAbierta: true },
  { id: 'divisor-cargado', titulo: 'Divisor con una carga de 1 kΩ', tension: 5, topologia: 'divisor', r1: 1000, r2: 1000, r3: 1000 },
  { id: 'divisor-sin-carga', titulo: 'Divisor sin carga', tension: 5, topologia: 'divisor', r1: 1000, r2: 1000 },
] as const satisfies readonly EjemploCircuito[];
export type EjemploId = typeof ejemplosCircuito[number]['id'];

export function ejemploPorId(id: string): EjemploCircuito | undefined {
  return ejemplosCircuito.find(ejemplo => ejemplo.id === id);
}
export function formatoMagnitud(valor: number, unidad: string): string {
  return `${new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 }).format(valor)} ${unidad}`;
}
export function prediccionCircuito(ejemplo: EjemploCircuito) {
  const v = ejemplo.tension;
  let corrientes: number[];
  let caidas: number[];
  let iFuente: number;
  if (ejemplo.topologia === 'simple') {
    iFuente = v / ejemplo.r1;
    corrientes = [iFuente]; caidas = [v];
  } else if (ejemplo.topologia === 'serie') {
    iFuente = v / (ejemplo.r1 + ejemplo.r2);
    corrientes = [iFuente, iFuente]; caidas = [iFuente * ejemplo.r1, iFuente * ejemplo.r2];
  } else if (ejemplo.topologia === 'paralelo') {
    corrientes = [v / ejemplo.r1, ejemplo.ramaAbierta ? 0 : v / ejemplo.r2];
    iFuente = corrientes.reduce((suma, corriente) => suma + corriente, 0);
    caidas = [v, ejemplo.ramaAbierta ? 0 : v];
  } else {
    const inferior = ejemplo.r3 ? 1 / (1 / ejemplo.r2 + 1 / ejemplo.r3) : ejemplo.r2;
    iFuente = v / (ejemplo.r1 + inferior);
    const salida = iFuente * inferior;
    corrientes = [iFuente, salida / ejemplo.r2, ...(ejemplo.r3 ? [salida / ejemplo.r3] : [])];
    caidas = [iFuente * ejemplo.r1, salida, ...(ejemplo.r3 ? [salida] : [])];
  }
  const potencias = corrientes.map((corriente, indice) => corriente * (caidas[indice] ?? 0));
  return { iFuente, corrientes, caidas, potencias, potenciaFuente: -v * iFuente };
}
export function observacionesEjemplo(ejemplo: EjemploCircuito): { magnitud: string; valor: string }[] {
  const prediccion = prediccionCircuito(ejemplo);
  return [
    { magnitud: 'Corriente entregada por la fuente', valor: formatoMagnitud(prediccion.iFuente * 1000, 'mA') },
    ...prediccion.corrientes.flatMap((corriente, indice) => [
      { magnitud: `R${indice + 1}: corriente`, valor: formatoMagnitud(corriente * 1000, 'mA') },
      { magnitud: `R${indice + 1}: caída de tensión`, valor: formatoMagnitud(prediccion.caidas[indice] ?? 0, 'V') },
      { magnitud: `R${indice + 1}: potencia absorbida`, valor: formatoMagnitud((prediccion.potencias[indice] ?? 0) * 1000, 'mW') },
    ]),
    { magnitud: 'Fuente: potencia con convención pasiva', valor: formatoMagnitud(prediccion.potenciaFuente * 1000, 'mW') },
  ];
}
