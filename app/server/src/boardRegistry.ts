import {
  BoardDescriptorSchema,
  ModuleDefSchema,
  chequearDescriptor,
  lenguajesDe,
  type BoardDescriptor,
  type Language,
} from '@emu/shared';
import { loadCatalog, type ModuloCatalogo } from './catalog.js';
import { ENGINES } from './engines/index.js';
import { TOOLCHAINS } from './toolchains/index.js';
import type { PlacaBuild } from './toolchains/tipos.js';

/**
 * Registro de placas: se arma leyendo el catálogo de módulos. Toda placa es un módulo
 * programable con su bloque `board` en el module.json (board.ts en shared/), sea de
 * fábrica o importado (carpeta, zip, URL, GitHub). No hay placas en el código: acá solo
 * se juntan y se validan contra los motores (engines/) y toolchains (toolchains/).
 */

export interface Placa extends PlacaBuild {
  modulo: ModuloCatalogo;
}

export async function listarPlacas(): Promise<Placa[]> {
  return (await loadCatalog())
    .filter((m): m is ModuloCatalogo & { board: BoardDescriptor } => m.programmable && m.board !== undefined)
    .map((m) => ({ id: m.type, nombre: m.name, desc: m.board, modulo: m }));
}

export async function buscarPlaca(id: string): Promise<Placa | undefined> {
  return (await listarPlacas()).find((p) => p.id === id);
}

/** Motores y toolchains registrados (para chequear un descriptor). */
export function pluginsConocidos(): { engines: string[]; toolchains: string[] } {
  return { engines: Object.keys(ENGINES), toolchains: Object.keys(TOOLCHAINS) };
}

export type NivelSoporte = 'emula' | 'compila' | 'solo-dibujo';

/**
 * Nivel de soporte que la placa PUEDE tener según sus datos: 'emula' si el motor y
 * algún toolchain existen y están implementados; 'compila' si solo el toolchain;
 * 'solo-dibujo' si ninguno. El nivel comprobado sale de la certificación (certificacion.ts).
 */
export function nivelDeclarado(desc: BoardDescriptor): NivelSoporte {
  const motor = ENGINES[desc.backend.engine];
  const compila = lenguajesDe(desc).some((l) => TOOLCHAINS[desc.languages[l]!.toolchain]?.disponible);
  if (!compila) return 'solo-dibujo';
  return motor?.disponible ? 'emula' : 'compila';
}

export interface ResultadoValidacion {
  ok: boolean;
  errores: string[];
  avisos: string[];
  /** Nivel de soporte que tendría con estos datos (si es válida). */
  nivel: NivelSoporte | null;
}

/**
 * Valida un module.json de placa (o solo su bloque `board` + los pines del módulo):
 * esquema, pines del descriptor contra `pins[]` del módulo, reservados, motor y
 * toolchains registrados, y las opciones que cada plugin sabe chequear.
 */
export function validarPlaca(entrada: unknown): ResultadoValidacion {
  const errores: string[] = [];
  const avisos: string[] = [];
  const mod = ModuleDefSchema.safeParse(entrada);
  if (!mod.success) {
    for (const i of mod.error.issues) errores.push(`${i.path.join('.') || '(raíz)'}: ${i.message}`);
    return { ok: false, errores, avisos, nivel: null };
  }
  const def = mod.data;
  if (!def.programmable) errores.push('programmable: una placa tiene que ser programable (true)');
  if (!def.board) {
    errores.push('board: falta el descriptor de placa');
    return { ok: false, errores, avisos, nivel: null };
  }
  const desc = def.board;
  const conocidos = pluginsConocidos();
  errores.push(...chequearDescriptor(desc, def.pins.map((p) => p.name), conocidos));

  const placa: PlacaBuild = { id: def.type, nombre: def.name, desc };
  const motor = ENGINES[desc.backend.engine];
  if (motor) {
    errores.push(...(motor.validarOpciones?.(desc.backend.options, desc) ?? []).map((e) => `board.backend.${e}`));
    if (!motor.disponible) avisos.push(`el motor "${motor.nombre}" todavía no está implementado: la placa queda en "solo dibujo"/"compila"`);
  }
  for (const l of lenguajesDe(desc)) {
    const t = TOOLCHAINS[desc.languages[l]!.toolchain];
    if (!t) continue;
    if (!t.lenguajes.includes(l as Language)) errores.push(`board.languages.${l}: el toolchain "${t.nombre}" no compila ${l}`);
    errores.push(...(t.validarOpciones?.(l, desc.languages[l]!.options, placa) ?? []).map((e) => `board.languages.${l}.${e}`));
    if (!t.disponible) avisos.push(`el toolchain "${t.nombre}" (${l}) todavía no está implementado`);
  }
  // Pines de E/S del módulo que el descriptor no mapea: se pueden dibujar pero no simular.
  const mapeados = new Set(Object.keys(desc.pins));
  const sinMapear = def.pins.filter((p) => /digital|analog/.test(p.kind) && !mapeados.has(p.name)).map((p) => p.name);
  if (sinMapear.length) avisos.push(`pines de E/S sin entrada en board.pins (no se simulan): ${sinMapear.join(', ')}`);
  if (!desc.demo) avisos.push('sin board.demo no hay circuito de prueba: la certificación no puede verificar LED/botón');

  const ok = errores.length === 0;
  return { ok, errores, avisos, nivel: ok ? nivelDeclarado(desc) : null };
}

/** El esquema del bloque `board` (para GET /api/boards/schema). */
export { BoardDescriptorSchema };
