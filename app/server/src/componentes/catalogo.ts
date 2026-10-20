import { createHash } from 'node:crypto';
import { DefinicionComponenteSchema, ReferenciaComponenteSchema, type DefinicionComponente, type ReferenciaComponente } from '@emu/shared';
import { ErrorComponente } from './errores.js';

/** Canonicalización del documento validado: claves ordenadas; arrays conservan su orden. */
function canonico(valor: unknown): string {
  if (valor === null || typeof valor !== 'object') {
    const serializado = JSON.stringify(valor);
    if (serializado === undefined) throw new ErrorComponente('FORMATO', 'Contenido no serializable');
    return serializado;
  }
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  const objeto = valor as Record<string, unknown>;
  return `{${Object.keys(objeto).filter(k => objeto[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonico(objeto[k])}`).join(',')}}`;
}

function validar(entrada: unknown): DefinicionComponente {
  const r = DefinicionComponenteSchema.safeParse(entrada);
  if (!r.success) throw new ErrorComponente('FORMATO', `Definición inválida: ${r.error.message}`);
  return r.data;
}

export function huellaDefinicion(entrada: unknown): string {
  return huellaContenido(validar(entrada));
}

/** Hash canónico común para manifiestos de datos ya validados. */
export function huellaContenido(contenido: unknown): string {
  return createHash('sha256').update(canonico(contenido)).digest('hex');
}

const identidad = (r: Pick<ReferenciaComponente, 'id' | 'version'>): string => JSON.stringify([r.id, r.version]);

const referencias = (def: DefinicionComponente): ReferenciaComponente[] => def.tipo === 'compuesto'
  ? [...def.instancias.map(i => i.definicion), ...(def.representaciones ? [def.representaciones.equivalente] : [])] : [];

/** Catálogo en memoria. Valida todo el cierre de dependencias; nunca consulta un catálogo mutable. */
export class CatalogoComponentes {
  private readonly definiciones = new Map<string, { def: DefinicionComponente; sha256: string }>();

  constructor(entradas: readonly unknown[]) {
    if (entradas.length > 2000) throw new ErrorComponente('LIMITE', 'Límite de 2000 definiciones excedido');
    let puertos = 0, conexiones = 0, dependencias = 0;
    for (const entrada of entradas) {
      const def = validar(entrada), sha256 = huellaDefinicion(def), clave = identidad(def);
      const anterior = this.definiciones.get(clave);
      if (anterior && anterior.sha256 !== sha256) throw new ErrorComponente('VERSION_CONFLICTIVA', `Contenido distinto para la misma versión: ${clave}`);
      if (anterior) continue;
      puertos += def.puertos.length;
      if (def.tipo === 'compuesto') { conexiones += def.conexiones.length; dependencias += referencias(def).length; }
      if (puertos > 20_000 || conexiones > 10_000 || dependencias > 10_000) {
        throw new ErrorComponente('LIMITE', 'Límite de tamaño del catálogo excedido');
      }
      this.definiciones.set(clave, { def, sha256 });
    }
    // Primero comprobar la topología por identidad. Un ciclo se rechaza aun si sus hashes
    // no pueden constituir un cierre consistente (el contenido incluye las referencias).
    const completos = new Set<string>();
    const visitar = (clave: string, pila: string[]): void => {
      if (pila.includes(clave)) throw new ErrorComponente('CICLO', `Ciclo entre definiciones: ${[...pila, clave].join(' → ')}`);
      if (completos.has(clave)) return;
      if (pila.length > 16) throw new ErrorComponente('LIMITE', 'Límite de profundidad de definiciones excedido');
      const actual = this.definiciones.get(clave);
      if (!actual) throw new ErrorComponente('DEFINICION_AUSENTE', `Definición ausente: ${clave}`);
      for (const ref of referencias(actual.def)) visitar(identidad(ref), [...pila, clave]);
      completos.add(clave);
    };
    for (const clave of [...this.definiciones.keys()].sort()) visitar(clave, []);
    for (const { def } of this.definiciones.values()) {
      for (const ref of referencias(def)) {
        const contenido = this.definiciones.get(identidad(ref));
        if (contenido?.sha256 !== ref.sha256) throw new ErrorComponente('HASH_DISTINTO', `Hash distinto para ${identidad(ref)}`);
      }
      if (def.tipo === 'compuesto' && def.representaciones) {
        const equivalente = this.resolver(def.representaciones.equivalente);
        const interfaz = (d: DefinicionComponente): string => huellaContenido({
          puertos: [...d.puertos].sort((a, b) => a.id.localeCompare(b.id)), parametros: d.parametros,
        });
        if (interfaz(def) !== interfaz(equivalente)) throw new ErrorComponente('PUERTO_INCOMPATIBLE', `Interfaz de representación incompatible: ${def.id}`);
        if (equivalente.tipo === 'compuesto' && equivalente.representaciones) throw new ErrorComponente('FORMATO', 'Un equivalente no puede volver a seleccionar una representación en la misma ruta');
      }
    }
  }

  resolver(entrada: ReferenciaComponente): DefinicionComponente {
    const r = ReferenciaComponenteSchema.safeParse(entrada);
    if (!r.success) throw new ErrorComponente('FORMATO', `Referencia inválida: ${r.error.message}`);
    const contenido = this.definiciones.get(identidad(r.data));
    if (!contenido) throw new ErrorComponente('DEFINICION_AUSENTE', `Definición ausente: ${identidad(r.data)}`);
    if (contenido.sha256 !== r.data.sha256) throw new ErrorComponente('HASH_DISTINTO', `Hash distinto para ${identidad(r.data)}`);
    // Ninguna referencia mutable del llamador puede cambiar el contenido ya verificado.
    return structuredClone(contenido.def);
  }
}
