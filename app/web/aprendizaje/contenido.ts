/** Bloques de contenido seguros: las lecciones no admiten HTML arbitrario. */
export type BloqueAprendizaje =
  | { tipo: 'parrafo'; texto: string }
  | { tipo: 'lista'; elementos: string[] }
  | { tipo: 'aviso'; titulo: string; texto: string }
  | { tipo: 'codigo'; lenguaje: string; texto: string }
  | { tipo: 'figura'; origen: string; alt: string; descripcion?: string };

export interface PasoAprendizaje {
  id: string;
  titulo: string;
  bloques: BloqueAprendizaje[];
  resultadoEsperado?: string;
}

export interface LeccionAprendizaje {
  id: string;
  revision: number;
  titulo: string;
  resumen: string;
  nivel: 'inicial' | 'intermedio' | 'avanzado';
  duracionMinutos: number;
  orden: number;
  objetivos: string[];
  requisitos: string[];
  materiales: { id: string; nombre: string; detalle?: string }[];
  pasos: PasoAprendizaje[];
  erroresFrecuentes: { problema: string; explicacion: string }[];
  practica?: { templateId: string; instrucciones: string[] };
}

/** Catálogo editorial. Una lección figura acá cuando su contenido ya está listo para leer. */
export const contenidoAprendizaje: readonly LeccionAprendizaje[] = [
  {
    id: 'encender-un-led',
    revision: 1,
    titulo: 'Encender un LED',
    resumen: 'Armá un circuito simple, respetá la polaridad y estimá la corriente con una resistencia en serie.',
    nivel: 'inicial',
    duracionMinutos: 10,
    orden: 10,
    objetivos: [
      'Identificar ánodo y cátodo en el LED.',
      'Seguir el camino de ida y vuelta de la corriente.',
      'Entender por qué se conecta una resistencia en serie.',
    ],
    requisitos: [],
    materiales: [
      { id: 'fuente-regulable', nombre: 'Fuente regulable', detalle: 'Ajustada a 5 V y apagada al empezar.' },
      { id: 'led', nombre: 'LED rojo', detalle: 'Revisá qué terminal corresponde al ánodo y al cátodo.' },
      { id: 'resistor', nombre: 'Resistencia de 330 Ω', detalle: 'Limita la corriente que atraviesa el LED.' },
    ],
    pasos: [
      {
        id: 'identificar', titulo: 'Identificá cada componente',
        bloques: [
          { tipo: 'parrafo', texto: 'El LED deja pasar corriente principalmente en un sentido. Su ánodo es el lado positivo y su cátodo es el lado negativo.' },
          { tipo: 'lista', elementos: ['La fuente aporta la diferencia de tensión.', 'La resistencia limita la corriente.', 'El LED convierte parte de la energía eléctrica en luz.'] },
        ],
        resultadoEsperado: 'La fuente empieza apagada y el LED todavía no emite luz.',
      },
      {
        id: 'seguir-circuito', titulo: 'Seguí el circuito',
        bloques: [
          { tipo: 'parrafo', texto: 'Conectá el positivo de la fuente a un extremo de la resistencia; el otro extremo va al ánodo del LED. El cátodo vuelve al negativo de la fuente.' },
          { tipo: 'aviso', titulo: 'Un circuito cerrado', texto: 'La corriente necesita un camino completo desde la fuente y de regreso a ella.' },
        ],
        resultadoEsperado: 'Se ve un único camino: positivo → resistencia → ánodo → cátodo → negativo.',
      },
      {
        id: 'estimar-corriente', titulo: 'Estimá la corriente',
        bloques: [
          { tipo: 'parrafo', texto: 'La resistencia recibe el voltaje que sobra después de la caída del LED. Usá la ley de Ohm para estimar la corriente antes de encender el circuito.' },
          { tipo: 'codigo', lenguaje: 'texto', texto: 'I ≈ (5 V − Vf) / 330 Ω' },
          { tipo: 'parrafo', texto: 'Vf es la caída de tensión directa del LED. El valor real depende del modelo del LED y de la simulación.' },
        ],
        resultadoEsperado: 'La corriente se expresa en amperios; al multiplicar por 1000 se obtiene miliamperios.',
      },
      {
        id: 'probar', titulo: 'Encendé y observá',
        bloques: [{ tipo: 'parrafo', texto: 'Encendé la fuente en la práctica. Observá el brillo del LED y la corriente calculada por el motor eléctrico.' }],
        resultadoEsperado: 'El LED conduce y la corriente queda limitada por la resistencia.',
      },
      {
        id: 'invertir-led', titulo: 'Invertí el LED y compará',
        bloques: [
          { tipo: 'parrafo', texto: 'Apagá la fuente antes de cambiar el circuito. Invertí el LED, encendé la fuente y compará el resultado. Después apagá y restaurá la orientación inicial.' },
          { tipo: 'aviso', titulo: 'No quites la resistencia', texto: 'No conectes el LED directamente a la fuente: la resistencia en serie evita que una corriente excesiva lo dañe.' },
        ],
        resultadoEsperado: 'Invertido, el LED no conduce significativamente; al restaurarlo vuelve a encender.',
      },
    ],
    erroresFrecuentes: [
      { problema: 'El LED queda apagado.', explicacion: 'Comprobá que la fuente esté encendida, que el circuito cierre y que el LED no esté invertido.' },
      { problema: 'La fuente está encendida pero no circula corriente.', explicacion: 'Buscá una conexión abierta entre el cátodo y el negativo de la fuente.' },
      { problema: 'La corriente es demasiado alta.', explicacion: 'Verificá que la resistencia esté en serie con el LED y que su valor sea 330 Ω.' },
    ],
    practica: {
      templateId: 'aprender-led',
      instrucciones: ['La práctica empieza con la fuente apagada.', 'Encendé la fuente y observá el LED y la corriente.', 'Apagá la fuente antes de invertir el LED.'],
    },
  },
];

export function leccionPorId(id: string): LeccionAprendizaje | undefined {
  return contenidoAprendizaje.find(leccion => leccion.id === id);
}

/** Errores legibles para detectar contenido incompleto antes de publicarlo. */
export function validarCatalogoAprendizaje(lecciones: readonly LeccionAprendizaje[]): string[] {
  const errores: string[] = [];
  const idsLeccion = new Set<string>();
  for (const leccion of lecciones) {
    const id = leccion.id || '(sin ID)';
    if (idsLeccion.has(leccion.id)) errores.push(`${id}: el ID de la lección está repetido.`);
    idsLeccion.add(leccion.id);
    if (!leccion.titulo.trim()) errores.push(`${id}: falta el título.`);
    if (!Number.isInteger(leccion.duracionMinutos) || leccion.duracionMinutos <= 0) errores.push(`${id}: la duración debe ser positiva.`);
    if (leccion.objetivos.length === 0) errores.push(`${id}: debe tener al menos un objetivo.`);
    if (leccion.pasos.length === 0) errores.push(`${id}: debe tener al menos un paso.`);
    const idsPaso = new Set<string>();
    for (const paso of leccion.pasos) {
      if (!paso.id.trim() || !paso.titulo.trim() || idsPaso.has(paso.id)) errores.push(`${id}: los pasos deben tener IDs y títulos únicos.`);
      idsPaso.add(paso.id);
      if (paso.bloques.length === 0 || paso.bloques.some(bloque => 'texto' in bloque && !bloque.texto.trim())) {
        errores.push(`${id}/${paso.id}: el paso debe tener contenido.`);
      }
      for (const bloque of paso.bloques) {
        if (bloque.tipo === 'figura' && !bloque.alt.trim()) errores.push(`${id}/${paso.id}: cada figura necesita texto alternativo.`);
      }
    }
  }
  return errores;
}
