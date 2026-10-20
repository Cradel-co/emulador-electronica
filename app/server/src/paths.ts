import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Raíz del workspace emulador-electronica/ (subiendo desde server/src). */
export const ROOT = path.resolve(here, '../../..');

export const PATHS = {
  root: ROOT,
  app: path.join(ROOT, 'app'),
  /** Se puede apuntar a otra carpeta (tests e2e) para no tocar los proyectos reales. */
  projects: process.env.EMU_PROJECTS_DIR ?? path.join(ROOT, 'projects'),
  /** Ejemplos educativos distribuidos con la app, independientes de proyectos personales. */
  learning: path.join(ROOT, 'projects', '_learning'),
  builds: path.join(ROOT, '.build'),
  cache: path.join(ROOT, '.cache'),
  firmware: path.join(ROOT, 'firmware'),
  firmwareComponents: path.join(ROOT, 'firmware', 'components'),
  /** Catálogo de módulos. Los tests e2e usan una copia para que importar no toque el real. */
  modules: process.env.EMU_MODULES_DIR ?? path.join(ROOT, 'modules'),
  boards: path.join(ROOT, 'boards'),
  /** Chips con lógica digital (sensores, relojes, pantallas): chips/<id>/chip.json. */
  chips: process.env.EMU_CHIPS_DIR ?? path.join(ROOT, 'chips'),
  templates: path.join(ROOT, 'templates'),
  web: path.join(here, '..', '..', 'web'),
  /** Ruta de los components tal como se ve dentro del contenedor. */
  containerComponents: '/components',
};

/** Alias en minúsculas, por compatibilidad. */
export const paths = PATHS;
