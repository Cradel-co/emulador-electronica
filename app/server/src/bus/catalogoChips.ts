import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ChipDefSchema, type ChipDef } from '@emu/shared';
import { PATHS } from '../paths.js';
import { compilarFuente } from '../fuenteSandbox.js';
import { SandboxChip } from './chipSandbox.js';

/** Un chip del catálogo con el código de su comportamiento. */
export type ChipCatalogo = ChipDef & { codigo: string };

let cache: ChipCatalogo[] | null = null;

export function invalidarChips(): void {
  cache = null;
}

/** Valida un chip (definición + que su código cargue en el sandbox). Devuelve los errores. */
export function validarChip(json: unknown, codigo: string | undefined): { def?: ChipCatalogo; errores: string[] } {
  const r = ChipDefSchema.safeParse(json);
  if (!r.success) return { errores: r.error.issues.map((i) => `${i.path.join('.') || 'chip.json'}: ${i.message}`) };
  if (codigo === undefined) return { errores: [`falta ${r.data.comportamiento}`] };
  try {
    codigo = compilarFuente(codigo, r.data.comportamiento);
    new SandboxChip(r.data.id, codigo);
  } catch (err) {
    return { errores: [(err as Error).message] };
  }
  return { def: { ...r.data, codigo }, errores: [] };
}

/** Catálogo de chips: <emulador>/chips/<id>/chip.json + su comportamiento. */
export function cargarChips(dir = PATHS.chips): ChipCatalogo[] {
  if (cache && dir === PATHS.chips) return cache;
  const chips: ChipCatalogo[] = [];
  if (existsSync(dir)) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const archivo = path.join(dir, e.name, 'chip.json');
      if (!e.isDirectory() || !existsSync(archivo)) continue;
      try {
        const json: unknown = JSON.parse(readFileSync(archivo, 'utf8'));
        const nombreJs = (json as { comportamiento?: unknown }).comportamiento;
        const js = typeof nombreJs === 'string' && /^[\w.-]+\.(?:js|ts)$/.test(nombreJs) ? path.join(dir, e.name, nombreJs) : null;
        const v = validarChip(json, js && existsSync(js) ? readFileSync(js, 'utf8') : undefined);
        if (v.def) chips.push(v.def);
        else console.error(`chip ${e.name} ignorado: ${v.errores.join('; ')}`);
      } catch (err) {
        console.error(`chip ${e.name} ignorado: ${(err as Error).message}`);
      }
    }
  }
  chips.sort((a, b) => a.id.localeCompare(b.id));
  if (dir === PATHS.chips) cache = chips;
  return chips;
}

export function chipDelCatalogo(id: string): ChipCatalogo | undefined {
  return cargarChips().find((c) => c.id === id);
}
