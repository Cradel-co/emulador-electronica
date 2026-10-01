import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Project, SalidaChip, ServerEvent } from '@emu/shared';
import type { ModuloCatalogo } from '../catalog.js';
import { cargarChips, type ChipCatalogo } from './catalogoChips.js';
import { entornoDe } from './proyectoChips.js';

/**
 * API de los chips: el catálogo (sin el código), los chips de un proyecto con su entorno y lo
 * último que publicaron, y mover el entorno (se guarda en el proyecto y, si está corriendo, se
 * aplica en vivo sin reiniciar). La usan la UI y el MCP.
 */

/** Lo que el server en marcha sabe de la corrida actual (el motor AVR la implementa). */
export interface CorridaChips {
  chipsEnCorrida(): { id: string; entorno: Record<string, number>; salida?: SalidaChip; alimentado: boolean }[];
  ponerEntorno(id: string, valores: Record<string, number>): boolean;
}

export interface DepsChips {
  leer(nombre: string): Promise<Project>;
  guardar(p: Project): Promise<Project>;
  catalogo(): Promise<ModuloCatalogo[]>;
  /** La corrida en curso de ese proyecto, si hay (y si el motor sabe de chips). */
  corrida(nombre: string): CorridaChips | null;
  emitir(e: ServerEvent): void;
}

export const chipPublico = (c: ChipCatalogo) => ({
  id: c.id, nombre: c.nombre, fabricante: c.fabricante, descripcion: c.descripcion, hojaDeDatos: c.hojaDeDatos,
  pines: c.pines, i2c: c.i2c, entorno: c.entorno, limitaciones: c.limitaciones,
});

/** Los módulos con chip de un proyecto: entorno (definición y valor), si está en el bus y lo último publicado. */
export async function chipsDe(nombre: string, d: DepsChips) {
  const p = await d.leer(nombre);
  const cat = await d.catalogo();
  const chips = cargarChips();
  const enCorrida = new Map((d.corrida(nombre)?.chipsEnCorrida() ?? []).map((c) => [c.id, c]));
  return p.modules.flatMap((inst) => {
    const def = cat.find((m) => m.type === inst.type);
    const chip = def?.chip && chips.find((c) => c.id === def.chip!.id);
    if (!def?.chip || !chip) return [];
    const vivo = enCorrida.get(inst.id);
    return [{
      id: inst.id, modulo: def.name, chip: chipPublico(chip),
      entorno: vivo?.entorno ?? entornoDe(chip, inst.entorno),
      enBus: vivo !== undefined, alimentado: vivo?.alimentado ?? null, salida: vivo?.salida ?? null,
    }];
  });
}

/** Mueve el entorno de un módulo con chip: valida contra el rango del chip, guarda y aplica en vivo. */
export async function moverEntorno(nombre: string, id: string, valores: Record<string, unknown>, d: DepsChips) {
  const p = await d.leer(nombre);
  const inst = p.modules.find((m) => m.id === id);
  if (!inst) throw Object.assign(new Error(`no hay un módulo "${id}" en el proyecto`), { statusCode: 404 });
  const def = (await d.catalogo()).find((m) => m.type === inst.type);
  const chip = def?.chip && cargarChips().find((c) => c.id === def.chip!.id);
  if (!chip) throw Object.assign(new Error(`"${id}" no tiene un chip con entorno`), { statusCode: 400 });
  const limpios: Record<string, number> = {};
  for (const [k, v] of Object.entries(valores)) {
    const m = chip.entorno[k];
    if (!m) throw Object.assign(new Error(`el chip ${chip.nombre} no mide "${k}" (mide: ${Object.keys(chip.entorno).join(', ') || 'nada'})`), { statusCode: 400 });
    if (typeof v !== 'number' || !Number.isFinite(v)) throw Object.assign(new Error(`${k} tiene que ser un número`), { statusCode: 400 });
    if (v < m.min || v > m.max) throw Object.assign(new Error(`${k} = ${v} fuera del rango del chip (${m.min} a ${m.max} ${m.unidad})`), { statusCode: 400 });
    limpios[k] = v;
  }
  inst.entorno = { ...inst.entorno, ...limpios };
  await d.guardar(p);
  const enVivo = d.corrida(nombre)?.ponerEntorno(id, limpios) ?? false;
  const entorno = entornoDe(chip, inst.entorno);
  d.emitir({ type: 'chip.entorno', project: nombre, id, entorno });
  return { entorno, enVivo };
}

export function registrarRutasChips(app: FastifyInstance, d: DepsChips, fallar: (reply: FastifyReply, err: unknown) => void): void {
  app.get('/api/chips', async () => ({ chips: cargarChips().map(chipPublico) }));

  app.get('/api/projects/:name/chips', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      reply.send({ chips: await chipsDe(name, d) });
    } catch (err) {
      fallar(reply, err);
    }
  });

  app.put('/api/projects/:name/modules/:id/entorno', async (req, reply) => {
    const { name, id } = req.params as { name: string; id: string };
    try {
      const body = (req.body ?? {}) as { valores?: unknown };
      if (!body.valores || typeof body.valores !== 'object') throw Object.assign(new Error('hace falta { valores: { temperatura: 22, ... } }'), { statusCode: 400 });
      reply.send(await moverEntorno(name, id, body.valores as Record<string, unknown>, d));
    } catch (err) {
      fallar(reply, err);
    }
  });
}
