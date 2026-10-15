/**
 * Changelog con **un archivo por cambio** en `changelog.d/`, en vez de un `CHANGELOG.md` único.
 *
 * El motivo es práctico: con varias ramas abiertas en paralelo, un archivo único da conflicto en
 * cada merge, porque todas agregan su línea arriba. Un archivo por cambio no choca con nada, y al
 * cerrar una versión se juntan todos (ver `changelog.d/README.md`).
 *
 * El nombre del archivo lleva el tipo: `<tipo>-<descripcion-corta>.md`, con los mismos tipos que
 * los prefijos de rama.
 */

export const TIPOS_CAMBIO = ['feat', 'fix', 'docs', 'refactor', 'chore'] as const;
export type TipoCambio = (typeof TIPOS_CAMBIO)[number];

/** Título de cada sección, en el orden en que se muestran. */
const TITULOS: Record<TipoCambio, string> = {
  feat: 'Nuevo',
  fix: 'Arreglado',
  docs: 'Documentación',
  refactor: 'Refactor',
  chore: 'Mantenimiento',
};

const NOMBRE_RE = /^([a-z]+)-([a-z0-9][a-z0-9-]{2,59})\.md$/;
const RESUMEN_MAX = 160;
/** Un resumen que no le dice nada a nadie: mejor que falle ahora que llegar al changelog. */
const RELLENO_RE = /^(todo|tbd|wip|pendiente|por completar|describir( el cambio)?|cambios varios|varios|fix|arreglo)\.?$/i;

export interface Fragmento {
  tipo: TipoCambio;
  /** La parte descriptiva del nombre del archivo. */
  slug: string;
  /** Primera línea: qué cambia, para quien usa la app. */
  resumen: string;
  /** El resto, si lo hay: el por qué, o el límite que conviene saber. */
  detalle: string;
}

const esTipo = (x: string): x is TipoCambio => (TIPOS_CAMBIO as readonly string[]).includes(x);

/**
 * Valida y parsea un fragmento. Devuelve los errores en castellano, pensados para que quien los
 * lea sepa qué corregir sin abrir este archivo.
 */
export function leerFragmento(archivo: string, contenido: string): { fragmento?: Fragmento; errores: string[] } {
  const errores: string[] = [];
  const m = NOMBRE_RE.exec(archivo);
  if (!m) {
    errores.push(`"${archivo}": el nombre tiene que ser <tipo>-<descripcion-corta>.md, en minúsculas y con guiones (por ejemplo fix-el-adc-no-refrescaba.md).`);
  } else if (!esTipo(m[1] ?? '')) {
    errores.push(`"${archivo}": el tipo "${m[1]}" no existe. Los que valen son: ${TIPOS_CAMBIO.join(', ')}.`);
  }

  const lineas = contenido.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
  const resumen = (lineas.find((l) => l.trim() !== '') ?? '').trim();
  if (resumen === '') {
    errores.push(`"${archivo}": está vacío. La primera línea tiene que decir qué cambia para quien usa la app.`);
  } else if (resumen.length > RESUMEN_MAX) {
    errores.push(`"${archivo}": el resumen tiene ${resumen.length} caracteres y el máximo es ${RESUMEN_MAX}. Lo largo va en el párrafo de abajo.`);
  } else if (RELLENO_RE.test(resumen)) {
    errores.push(`"${archivo}": "${resumen}" es relleno. Decí qué problema resuelve, como en el mensaje del commit.`);
  }

  if (errores.length > 0 || !m) return { errores };
  const desde = lineas.indexOf(resumen) + 1;
  const detalle = lineas.slice(desde).join('\n').trim();
  return { fragmento: { tipo: m[1] as TipoCambio, slug: m[2] ?? '', resumen, detalle }, errores: [] };
}

/** El markdown de una versión, agrupando los fragmentos por tipo. */
export function armarChangelog(
  fragmentos: readonly Fragmento[],
  opciones: { version: string; fecha: string },
): string {
  const partes: string[] = [`## ${opciones.version} — ${opciones.fecha}`, ''];
  if (fragmentos.length === 0) {
    partes.push('Sin cambios registrados.', '');
    return partes.join('\n');
  }
  for (const tipo of TIPOS_CAMBIO) {
    const del = fragmentos.filter((f) => f.tipo === tipo);
    if (del.length === 0) continue; // sin fragmentos de ese tipo no se inventa la sección
    partes.push(`### ${TITULOS[tipo]}`, '');
    for (const f of del) {
      partes.push(`- ${f.resumen}`);
      // El detalle va indentado para que se lea como parte de su viñeta.
      if (f.detalle !== '') partes.push(...f.detalle.split('\n').map((l) => (l === '' ? '' : `  ${l}`)));
    }
    partes.push('');
  }
  return partes.join('\n');
}
