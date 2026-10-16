import { z } from 'zod';

/**
 * Lo que un módulo dice de sí mismo para fabricarlo, cuidarlo y probarlo (SDD-MODULOS.md,
 * secciones 1 a 4). Todo es opcional: un módulo inventado ayer funciona sin nada de esto, y la
 * app completa lo que falta con valores genéricos (una caja con sus pines, una tira de 2,54 mm).
 * Cuánto tiene cada módulo lo dice su nivel: dibujo → simula → probado → fabricable.
 */

/** Un texto que puede depender de una prop: `{{props.ohms|ohms}}`, o un mapa por valor de la prop. */
export const TextoPorPropSchema = z.union([
  z.string().min(1).max(200),
  z.object({ prop: z.string().min(1), map: z.record(z.string(), z.string().max(200)), default: z.string().max(200) }).strict(),
]);
export type TextoPorProp = z.infer<typeof TextoPorPropSchema>;

/** "Biblioteca:Nombre" de las librerías oficiales de KiCad (Device:R, Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical). */
export const REF_KICAD_RE = /^[A-Za-z0-9_.+-]{1,60}:[A-Za-z0-9_.,+-]{1,100}$/;
const RefKicad = z.string().regex(REF_KICAD_RE, 'Biblioteca:Nombre de KiCad');

/** Solo enlaces https: un módulo importado no puede meter `javascript:` en la UI. */
const UrlHttps = z.string().url().max(500).regex(/^https:\/\//, 'tiene que empezar con https://');

/** Identidad real de lo que se compra: para la lista de materiales (BOM) y para buscarlo. */
export const ParteSchema = z
  .object({
    fabricante: z.string().min(1).max(80),
    /** Número de parte del fabricante. Con props que cambian la pieza (el color de un LED), un mapa o `{{props.x}}`. */
    mpn: TextoPorPropSchema,
    descripcion: z.string().max(200).optional(),
    datasheet: UrlHttps.optional(),
    /**
     * Placa genérica sin un número de parte único (ZS-042, GY-521, el relé de un canal): lo
     * que se compra se busca por nombre. El exportador lo marca en la BOM.
     */
    generico: z.boolean().default(false),
    proveedores: z
      .array(z.object({ nombre: z.string().min(1).max(40), sku: z.string().max(60).optional(), url: UrlHttps.optional() }).strict())
      .max(8)
      .default([]),
  })
  .strict();
export type Parte = z.infer<typeof ParteSchema>;

/** Una pieza del despiece (nivel componentes): con qué está hecho el módulo por dentro. */
export const PiezaDiscretaSchema = z
  .object({
    /** Prefijo de la referencia: R, C, D, Q, K, U... (R1, R2 al exportar). */
    ref: z.string().regex(/^[A-Z]{1,3}$/),
    valor: z.string().min(1).max(60),
    simbolo: RefKicad,
    huella: RefKicad,
    fabricante: z.string().max(80).optional(),
    mpn: z.string().max(80).optional(),
    /** Elemento del model.js que representa esta pieza (se verifica que exista). */
    elemento: z.string().max(40).optional(),
    /** Número de pin del símbolo → pin del módulo o nodo interno del model.js (`ctx.nodo('base')` → "base"). */
    nodos: z.record(z.string().max(10), z.string().min(1).max(40)),
  })
  .strict();
export type PiezaDiscreta = z.infer<typeof PiezaDiscretaSchema>;

/** Cómo se fabrica: se enchufa el módulo comprado, se sueldan sus piezas, o no va en la placa. */
export const FABRICACION = ['modulo', 'discreto', 'externo'] as const;

export const EsquematicoSchema = z
  .object({
    /** Prefijo de la referencia en el esquemático: R, D, K, U, J, SW, A (módulo)... */
    referencia: z.string().regex(/^[A-Z]{1,3}$/).optional(),
    /** Lo que se escribe al lado del símbolo: "220 Ω", "BME280". */
    valor: TextoPorPropSchema.optional(),
    /** Símbolo de KiCad. Sin esto: una caja con los pines del módulo. */
    simbolo: RefKicad.optional(),
    /** Huella de KiCad. Sin esto (y sin `conectores`): una tira de pines de 2,54 mm en el orden del module.json. */
    huella: RefKicad.optional(),
    /** Pin del módulo → número de pin del símbolo y de la huella. Obligatorio si hay `simbolo`. */
    pines: z.record(z.string(), z.string().max(10)).optional(),
    /** En vez de una huella: varios conectores (un DevKit con dos tiras), cada uno con sus pines en orden. */
    conectores: z.array(z.object({ huella: RefKicad, pines: z.array(z.string().min(1)).min(1).max(60) }).strict()).max(6).optional(),
    /**
     * `modulo`: se compra la placa y se enchufa en su conector (lo normal para un breakout).
     * `discreto`: sus piezas van soldadas en la placa (una resistencia, un LED; o el `discreto` de abajo).
     * `externo`: no va en la placa (una fuente de laboratorio, un control remoto): solo en la BOM,
     * y un conector si tiene cables.
     */
    fabricacion: z.enum(FABRICACION).default('modulo'),
    /** Despiece real, para fabricar el módulo en vez de comprarlo (nivel componentes). */
    discreto: z.array(PiezaDiscretaSchema).max(40).optional(),
    /** Notas que van en el dibujo ("CS a GND = SPI", "la pila es CR2032"). */
    notas: z.array(z.string().min(1).max(300)).max(10).default([]),
  })
  .strict();
export type Esquematico = z.infer<typeof EsquematicoSchema>;

const Severidad = z.enum(['advertencia', 'peligro']);
const Entre = z.tuple([z.string().min(1), z.string().min(1)]);
/**
 * El texto del aviso. Puede llevar el valor medido: `{v}` (V, 1 decimal), `{ma}` (mA), `{mw}` (mW),
 * `{w}` (W, 2 decimales). Sin `mensaje`, la app arma uno con el límite.
 */
const Mensaje = z.string().min(1).max(300).optional();

/**
 * Límites de la hoja de datos, declarativos. Los dinámicos se evalúan con los valores del motor
 * eléctrico después de `observar()` (los mismos nombres: pines y elementos del model.js); los
 * estáticos (`conectado`) miran solo el cableado. De dos reglas sobre lo mismo, sale la más grave.
 */
export const ReglaSchema = z.discriminatedUnion('tipo', [
  /** V(entre[0]) − V(entre[1]) por encima de `max`. */
  z.object({ tipo: z.literal('tensionMax'), entre: Entre, max: z.number(), severidad: Severidad.default('peligro'), mensaje: Mensaje }).strict(),
  /** Por debajo de `min`, pero solo si hay algo aplicado (más de `desde` V): sin alimentar no avisa. */
  z.object({ tipo: z.literal('tensionMin'), entre: Entre, min: z.number(), desde: z.number().default(0.5), severidad: Severidad.default('advertencia'), mensaje: Mensaje }).strict(),
  /** |I| de un elemento del model.js por encima de `maxMa`. */
  z.object({ tipo: z.literal('corrienteMax'), elemento: z.string().min(1), maxMa: z.number().positive(), severidad: Severidad.default('peligro'), mensaje: Mensaje }).strict(),
  /** |P| de un elemento del model.js por encima de `maxMw`. */
  z.object({ tipo: z.literal('potenciaMax'), elemento: z.string().min(1), maxMw: z.number().positive(), severidad: Severidad.default('peligro'), mensaje: Mensaje }).strict(),
  /** Pines que tienen que estar cableados (ERC). */
  z.object({ tipo: z.literal('conectado'), pines: z.array(z.string().min(1)).min(1), severidad: Severidad.default('advertencia'), mensaje: Mensaje }).strict(),
]);
export type Regla = z.infer<typeof ReglaSchema>;

// --- tests.json --------------------------------------------------------------------------------

/** Qué se le conecta a un pin en el banco de pruebas. */
export const ConexionBancoSchema = z.union([
  z.literal('tierra'),
  z.literal('abierto'),
  /** Un multímetro: 10 MΩ a tierra (para medir un pin que el módulo maneja, como 3VO). */
  z.literal('sonda'),
  z.object({ fuente: z.number().min(-24).max(24), limiteMa: z.number().positive().max(10000).optional() }).strict(),
  /** Una resistencia desde el pin a tierra o a otro pin del módulo (`a`: "tierra" o el nombre del pin). */
  z.object({ resistencia: z.number().positive(), a: z.string().min(1).default('tierra') }).strict(),
]);
export type ConexionBanco = z.infer<typeof ConexionBancoSchema>;

const Rango = z.tuple([z.number(), z.number()]);

export const PruebaModuloSchema = z
  .object({
    nombre: z.string().min(1).max(200),
    props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    /** El control del módulo activo (pulsador apretado, llave encendida). */
    control: z.boolean().default(false),
    banco: z.record(z.string(), ConexionBancoSchema),
    espera: z
      .object({
        /** Tensión de un pin respecto de tierra ("3VO"), o entre dos ("VCC:GND"), en V. */
        tension: z.record(z.string(), Rango).optional(),
        /** |I| de un elemento del model.js, en mA. */
        corrienteMa: z.record(z.string(), Rango).optional(),
        /** |P| de un elemento del model.js, en mW. */
        potenciaMw: z.record(z.string(), Rango).optional(),
        /** Lo que muestra el módulo (`ui` de observar): un valor exacto o un rango. */
        ui: z.record(z.string(), z.union([z.boolean(), z.number(), z.string(), Rango])).optional(),
        /** Ningún aviso de este módulo. */
        sinAvisos: z.boolean().optional(),
        /** Avisos que tienen que aparecer (todos). */
        avisos: z.array(z.object({ severidad: Severidad.optional(), contiene: z.string().min(1) }).strict()).optional(),
      })
      .strict(),
  })
  .strict();
export type PruebaModulo = z.infer<typeof PruebaModuloSchema>;
export const PruebasModuloSchema = z.array(PruebaModuloSchema).max(60);

// --- Plantillas y nivel ---------------------------------------------------------------------------

/** "220" → "220", 1000 → "1k", 4700 → "4k7", 1e6 → "1M": como se rotula una resistencia. */
export function rotuloOhms(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const [div, suf] = x >= 1e6 ? [1e6, 'M'] : x >= 1e3 ? [1e3, 'k'] : [1, ''];
  const v = x / div;
  if (Number.isInteger(v)) return `${v}${suf}`;
  const [e, d] = String(+v.toFixed(2)).split('.');
  return suf ? `${e}${suf}${d}` : `${e}R${d}`;
}

/** El código de valor de los números de parte de resistencias (Yageo, Vishay): 220R, 1K, 4K7, 1M. */
export function codigoR(x: number): string {
  const r = rotuloOhms(x).toUpperCase();
  return /^\d+$/.test(r) ? `${r}R` : r;
}

/** Resuelve un texto con `{{props.x}}`, `{{props.x|ohms}}` (4k7), `{{props.x|codigoR}}` (4K7, 220R) o un mapa por prop. */
export function resolverTexto(t: TextoPorProp, props: Record<string, unknown>): string {
  if (typeof t !== 'string') return t.map[String(props[t.prop])] ?? t.default;
  return t.replace(/\{\{\s*props\.([\w]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (_, k: string, f?: string) => {
    const v = props[k];
    if (f === 'ohms' && typeof v === 'number') return rotuloOhms(v);
    if (f === 'codigoR' && typeof v === 'number') return codigoR(v);
    return v === undefined ? '' : String(v);
  });
}

export const NIVELES_MODULO = ['dibujo', 'simula', 'probado', 'fabricable'] as const;
export type NivelModulo = (typeof NIVELES_MODULO)[number];
