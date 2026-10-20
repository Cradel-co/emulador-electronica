import { z } from 'zod';

/** Contrato inicial de composición. No carga modelos, ejecuta código ni altera ProjectSchema. */
export const LIMITES_COMPONENTES = {
  puertos: 64,
  instanciasPorDefinicion: 200,
  conexionesPorDefinicion: 1000,
  terminalesPorConexion: 64,
} as const;

const Identificador = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'identificador local inválido');
// Los pines legados admiten nombres como "1", "3V3" e "INT/SQW".
const PuertoId = z.string().min(1).max(40).regex(/^[A-Za-z0-9_+\/-]+$/, 'identificador de puerto inválido');
const ValorParametro = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

/** La versión identifica una revisión humana; el digest fija el contenido resuelto por el catálogo. */
export const ReferenciaComponenteSchema = z.object({
  id: Identificador,
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'versión exacta requerida'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'digest SHA-256 requerido'),
}).strict();

export const PuertoComponenteSchema = z.object({
  id: PuertoId,
  dominio: z.enum(['electrico', 'logico', 'interrupcion', 'reloj', 'transaccion', 'radio']),
  direccion: z.enum(['entrada', 'salida', 'bidireccional']),
  ancho: z.number().int().min(1).max(64),
}).strict().superRefine((puerto, ctx) => {
  if (puerto.dominio === 'electrico' && (puerto.ancho !== 1 || puerto.direccion !== 'bidireccional')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Un terminal eléctrico es escalar y bidireccional; el drive pertenece al modelo.' });
  }
});

/** Las rutas son arrays de IDs, nunca referencias concatenadas que puedan colisionar. */
export const TerminalComponenteSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('externo'), puerto: PuertoId }).strict(),
  z.object({ tipo: z.literal('hijo'), instancia: Identificador, puerto: PuertoId }).strict(),
]);

export const InstanciaComponenteSchema = z.object({
  id: Identificador,
  definicion: ReferenciaComponenteSchema,
  parametros: z.record(z.string().min(1).max(40), ValorParametro),
}).strict();

export const ConexionComponenteSchema = z.object({
  id: Identificador,
  terminales: z.array(TerminalComponenteSchema).min(2).max(LIMITES_COMPONENTES.terminalesPorConexion),
}).strict();

const Cabecera = z.object({
  schemaVersion: z.literal(1),
  id: Identificador,
  version: ReferenciaComponenteSchema.shape.version,
  nombre: z.string().min(1).max(100),
  puertos: z.array(PuertoComponenteSchema).max(LIMITES_COMPONENTES.puertos),
});

/** Hoja legada: fija el paquete completo, no solo el nombre mutable de su module.json. */
const Hoja = Cabecera.extend({
  tipo: z.literal('hoja-legada'),
  modulo: z.object({ id: Identificador, sha256: ReferenciaComponenteSchema.shape.sha256 }).strict(),
}).strict();

/** Una red es explícita; no hay etiquetas globales ni GND compartido por nombre. */
const Compuesto = Cabecera.extend({
  tipo: z.literal('compuesto'),
  instancias: z.array(InstanciaComponenteSchema).max(LIMITES_COMPONENTES.instanciasPorDefinicion),
  conexiones: z.array(ConexionComponenteSchema).max(LIMITES_COMPONENTES.conexionesPorDefinicion),
}).strict();

/**
 * Valida estructura y referencias locales. La resolución de definiciones/versiones, ciclos,
 * compatibilidad de puertos hijos y presupuestos globales corresponde al elaborador de P1.
 */
export const DefinicionComponenteSchema = z.discriminatedUnion('tipo', [Hoja, Compuesto]).superRefine((def, ctx) => {
  const unicos = (ids: string[], campo: string): void => {
    const vistos = new Set<string>();
    ids.forEach((id, indice) => {
      if (vistos.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [campo, indice, 'id'], message: `Identificador duplicado: ${id}` });
      vistos.add(id);
    });
  };
  unicos(def.puertos.map(p => p.id), 'puertos');
  if (def.tipo !== 'compuesto') return;
  unicos(def.instancias.map(i => i.id), 'instancias');
  unicos(def.conexiones.map(c => c.id), 'conexiones');
  const puertos = new Set(def.puertos.map(p => p.id));
  const instancias = new Set(def.instancias.map(i => i.id));
  // Un terminal pertenece a una sola red: unir redes requiere una operación explícita de edición.
  const conectados = new Set<string>();
  def.conexiones.forEach((conexion, indice) => conexion.terminales.forEach((terminal, posicion) => {
    const path = ['conexiones', indice, 'terminales', posicion];
    if (terminal.tipo === 'externo' && !puertos.has(terminal.puerto)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Puerto externo inexistente: ${terminal.puerto}` });
    }
    if (terminal.tipo === 'hijo' && !instancias.has(terminal.instancia)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Instancia inexistente: ${terminal.instancia}` });
    }
    const clave = terminal.tipo === 'externo'
      ? JSON.stringify(['externo', terminal.puerto])
      : JSON.stringify(['hijo', terminal.instancia, terminal.puerto]);
    if (conectados.has(clave)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Terminal repetido: debe pertenecer a una única red.' });
    conectados.add(clave);
  }));
});

export type ReferenciaComponente = z.infer<typeof ReferenciaComponenteSchema>;
export type PuertoComponente = z.infer<typeof PuertoComponenteSchema>;
export type TerminalComponente = z.infer<typeof TerminalComponenteSchema>;
export type InstanciaComponente = z.infer<typeof InstanciaComponenteSchema>;
export type ConexionComponente = z.infer<typeof ConexionComponenteSchema>;
export type DefinicionComponente = z.infer<typeof DefinicionComponenteSchema>;
