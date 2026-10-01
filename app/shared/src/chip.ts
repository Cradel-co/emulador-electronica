import { z } from 'zod';

/**
 * Chips con lógica digital (sensores, relojes, pantallas...): `chips/<id>/chip.json` +
 * su comportamiento en JS. Un chip es la pieza de silicio; un módulo del catálogo (la
 * placa que se compra) lo usa con `chip` en su module.json y mapea sus pines a los del chip.
 * Así varias placas comerciales con el mismo chip (el BME280 de Adafruit, el GY-BME280...)
 * comparten todo lo difícil. Ver SDD-MODULOS.md y chips/README.md.
 */

export const CHIP_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NOMBRE_PIN_RE = /^[A-Za-z0-9_+\/-]{1,20}$/; // INT/SQW, como en las hojas de datos
const NOMBRE_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,30}$/;

/** Una magnitud del mundo que el chip mide (temperatura, aceleración...): la mueve el usuario. */
export const MagnitudEntornoSchema = z
  .object({
    unidad: z.string().max(12),
    min: z.number(),
    max: z.number(),
    default: z.number(),
    /** Paso del control en la UI. */
    paso: z.number().positive().optional(),
    etiqueta: z.string().max(40).optional(),
  })
  .strict()
  .refine((m) => m.min < m.max && m.default >= m.min && m.default <= m.max, 'min < max y default entre los dos');

export const ChipDefSchema = z
  .object({
    id: z.string().regex(CHIP_ID_RE, 'solo [a-z0-9-], hasta 40 caracteres'),
    nombre: z.string().min(1).max(60),
    fabricante: z.string().max(60).optional(),
    descripcion: z.string().max(500).optional(),
    /** Hoja de datos en la que se basa el comportamiento (código y revisión), para poder verificarlo. */
    hojaDeDatos: z.string().max(200).optional(),
    /** Pines del chip (los nombres de su hoja de datos). */
    pines: z.array(z.string().regex(NOMBRE_PIN_RE)).min(1).max(64),
    /** Bus I2C: qué pines del chip son SDA y SCL. */
    i2c: z
      .object({
        sda: z.string().regex(NOMBRE_PIN_RE),
        scl: z.string().regex(NOMBRE_PIN_RE),
        /** Frecuencia máxima de SCL que soporta (Hz), para avisar si el firmware la pasa. */
        maxHz: z.number().positive().optional(),
        /**
         * El chip contesta siempre que está encendido y lo que se le escribe no cambia si contesta
         * (una pantalla: nunca hace NACK). El bus puede entregarle las escrituras en tanda (hasta 16
         * o 10 ms de emulación, y siempre antes de una lectura o un despertador): mucho menos
         * trabajo. Cada evento conserva su instante. NO usar en una EEPROM (después de grabar, NACK).
         */
        diferirEscrituras: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /**
     * Bus SPI: qué pines del chip son SCK, MOSI (entra al chip), MISO (sale), CS (selección, activo
     * en bajo) y, en las pantallas, DC (dato o comando). `modos`: los modos SPI que acepta (si el
     * firmware usa otro, el byte llega corrido, como en la placa real). `soloEscritura`: no maneja
     * MISO (una pantalla): el bus le entrega lo escrito en tanda.
     */
    spi: z
      .object({
        sck: z.string().regex(NOMBRE_PIN_RE),
        mosi: z.string().regex(NOMBRE_PIN_RE),
        miso: z.string().regex(NOMBRE_PIN_RE).optional(),
        cs: z.string().regex(NOMBRE_PIN_RE),
        dc: z.string().regex(NOMBRE_PIN_RE).optional(),
        modos: z.array(z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])).min(1).default([0]),
        lsbPrimero: z.boolean().default(false),
        maxHz: z.number().positive().optional(),
        soloEscritura: z.boolean().default(false),
      })
      .strict()
      .optional(),
    /** Pines del chip que LEE del micro (un RST, un ENABLE): le llegan como eventos `pin`. */
    entradas: z.array(z.string().regex(NOMBRE_PIN_RE)).default([]),
    entorno: z.record(z.string().regex(NOMBRE_RE), MagnitudEntornoSchema).default({}),
    /** Archivo JS con el comportamiento (corre en un sandbox). */
    comportamiento: z.string().regex(/^[\w.-]+\.js$/),
    /** Lo que NO se emula, dicho claro (se muestra en la UI y en el MCP). */
    limitaciones: z.array(z.string().max(300)).max(30).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const p of [c.i2c?.sda, c.i2c?.scl, c.spi?.sck, c.spi?.mosi, c.spi?.miso, c.spi?.cs, c.spi?.dc, ...c.entradas]) {
      if (p !== undefined && !c.pines.includes(p)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `el pin de bus "${p}" no está en pines` });
    }
  });

export type ChipDef = z.infer<typeof ChipDefSchema>;
export type MagnitudEntorno = z.infer<typeof MagnitudEntornoSchema>;

/** Uso de un chip desde un module.json: cuál, y qué pin del módulo es qué pin del chip. */
export const UsoChipSchema = z
  .object({
    id: z.string().regex(CHIP_ID_RE),
    /** Pin del módulo → pin del chip. Los del chip que no estén acá quedan sin conectar. */
    pines: z.record(z.string(), z.string()).default({}),
    /**
     * Props del chip que salen de cómo está cableado un pin del módulo, como en la placa real
     * (SDO a GND → dirección 0x76): prop → { pin del módulo, valor si va a tierra, valor si va
     * a alimentación }. Sin cablear queda el `default` de la prop del módulo (su pull-up/down).
     */
    porCableado: z
      .record(z.string(), z.object({ pin: z.string(), aTierra: z.string(), aAlimentacion: z.string() }).strict())
      .default({}),
    /**
     * Pines del CHIP que la placa tiene con pull-up (INT/SQW de la ZS-042, por ejemplo): cuando el
     * chip suelta la línea (colector abierto), el micro lee 1 aunque no active su pull-up interno.
     */
    pullUps: z.array(z.string()).default([]),
  })
  .strict();

export type UsoChip = z.infer<typeof UsoChipSchema>;

/** Lo que el chip publica para que se vea (pantalla, valores): datos chicos y planos. */
export type SalidaChip = Record<string, unknown>;
