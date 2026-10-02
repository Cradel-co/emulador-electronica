/**
 * La búsqueda de la paleta de comandos: cómo se puntúa un candidato, cómo se ordenan y qué parte
 * del título se resalta. Puro, sin DOM, para poder probarlo sin navegador (tests/unit/paleta.test.ts).
 *
 * Qué se busca (acciones, proyectos, archivos, módulos) lo decide `app.ts`, que es el que sabe;
 * acá solo se filtra.
 */

export interface Candidato {
  tipo: string;
  titulo: string;
  atajo?: string;
  hacer: () => void;
}

/** Cuántos resultados se muestran como mucho. */
export const TOPE = 80;

/** Las palabras de la consulta, en minúscula. */
export function palabrasDe(consulta: string): string[] {
  return consulta.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Puntaje simple, menor es mejor: todas las palabras tienen que aparecer (si falta una, -1). Cada
 * palabra suma 0 si el título empieza con ella, 1 si empieza una palabra del título y 3 si está a
 * mitad de una. Así "led" encuentra primero "LED" que "Modelo".
 */
export function puntaje(titulo: string, palabras: readonly string[]): number {
  const t = titulo.toLowerCase();
  let total = 0;
  for (const w of palabras) {
    const i = t.indexOf(w);
    if (i < 0) return -1;
    total += i === 0 ? 0 : /[\s·\-_./]/.test(t[i - 1]!) ? 1 : 3;
  }
  return total;
}

/**
 * Los candidatos que coinciden, mejor puntaje primero; a igual puntaje, en el orden en que
 * llegaron. Sin consulta, los primeros tal cual.
 */
export function filtrar(candidatos: readonly Candidato[], consulta: string): Candidato[] {
  const palabras = palabrasDe(consulta);
  if (!palabras.length) return candidatos.slice(0, TOPE);
  return candidatos
    .map((c, i) => ({ c, p: puntaje(c.titulo, palabras), i }))
    .filter((x) => x.p >= 0)
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.c)
    .slice(0, TOPE);
}

/**
 * El título partido en tramos, marcando la primera aparición de cada palabra buscada (sin
 * distinguir mayúsculas). Si dos palabras se pisan, gana la que aparece primero en el título.
 *
 * Reemplaza al resaltado con `innerHTML` que había antes, que aplicaba un reemplazo por palabra
 * sobre el HTML ya marcado: buscar "mar" podía caer adentro de un `<mark>` puesto por otra palabra
 * y romper el marcado.
 */
export function tramos(titulo: string, palabras: readonly string[]): { texto: string; marcado: boolean }[] {
  const t = titulo.toLowerCase();
  const rangos: [number, number][] = [];
  for (const w of palabras) {
    const i = t.indexOf(w);
    if (i >= 0) rangos.push([i, i + w.length]);
  }
  rangos.sort((a, b) => a[0] - b[0]);
  const out: { texto: string; marcado: boolean }[] = [];
  let pos = 0;
  for (const [ini, fin] of rangos) {
    if (ini < pos) continue; // se pisa con uno anterior
    if (ini > pos) out.push({ texto: titulo.slice(pos, ini), marcado: false });
    out.push({ texto: titulo.slice(ini, fin), marcado: true });
    pos = fin;
  }
  if (pos < titulo.length) out.push({ texto: titulo.slice(pos), marcado: false });
  return out;
}
