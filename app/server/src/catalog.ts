import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ModuleDefSchema, type ModuleDef } from '@emu/shared';
import { PATHS } from './paths.js';

/** Módulo del catálogo tal como lo recibe la UI: con su SVG adentro. */
export type ModuloCatalogo = ModuleDef & {
  /** Contenido de module.svg (si tiene). */
  svgMarkup?: string;
  /** De fábrica (sin `origin`): no se puede quitar ni reemplazar. */
  builtin: boolean;
};

let cache: ModuloCatalogo[] | null = null;

/** El importador llama a esto después de instalar o quitar un módulo. */
export function invalidarCatalogo(): void {
  cache = null;
}

/** Catálogo de módulos: <emulador>/modules/<tipo>/module.json + module.svg (sección 12). */
export async function loadCatalog(): Promise<ModuloCatalogo[]> {
  if (cache) return cache;
  const dir = PATHS.modules;
  const mods: ModuloCatalogo[] = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.includes('.tmp-')) continue;
      const file = path.join(dir, entry.name, 'module.json');
      if (!existsSync(file)) continue;
      try {
        const def = ModuleDefSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        const svgPath = path.join(dir, entry.name, path.basename(def.svg));
        mods.push({
          ...def,
          svgMarkup: existsSync(svgPath) ? readFileSync(svgPath, 'utf8') : undefined,
          builtin: !def.origin,
        });
      } catch (err) {
        // Un módulo roto no debe tumbar la app.
        console.error(`módulo ${entry.name} ignorado: ${(err as Error).message}`);
      }
    }
  }
  cache = mods.sort((a, b) => a.type.localeCompare(b.type));
  return cache;
}

export async function moduloDelCatalogo(type: string): Promise<ModuloCatalogo | undefined> {
  return (await loadCatalog()).find((m) => m.type === type);
}
