import { parseDocument } from 'yaml';
import { gpioDePin, nombreDePin, type BoardDescriptor, type Language, type Project } from '@emu/shared';
import type { DireccionPin } from './sim/analisis.js';

/**
 * Detección aproximada de pines por lenguaje (11.6). Solo sirve para avisos:
 * el dibujo y el código se comparan antes de ejecutar.
 */

const RE_BY_LANGUAGE: Record<Language, RegExp[]> = {
  esphome: [
    // number: GPIO6  /  pin: 6
    /^\s*number:\s*(?:GPIO)?(\d{1,2})\s*$/gim,
    /^\s*pin:\s*(?:GPIO)?(\d{1,2})\s*$/gim,
  ],
  'idf-c': [
    /GPIO_NUM_(\d{1,2})\b/g,
    /gpio_set_level\s*\(\s*(\d{1,2})/g,
    /gpio_get_level\s*\(\s*(\d{1,2})/g,
    /PIN_[A-Z_]+\s+(?:GPIO_NUM_)?(\d{1,2})/g,
  ],
  'idf-cpp': [
    /GPIO_NUM_(\d{1,2})\b/g,
    /gpio_set_level\s*\(\s*[^,]*?(\d{1,2})/g,
    /gpio_get_level\s*\(\s*[^,]*?(\d{1,2})/g,
  ],
  arduino: [
    /\bpinMode\s*\(\s*(\d{1,2})/g,
    /\bdigitalWrite\s*\(\s*(\d{1,2})/g,
    /\bdigitalRead\s*\(\s*(\d{1,2})/g,
  ],
  // `simbridge.pin(6)` es como las plantillas leen las entradas del circuito: cuenta
  // igual que `Pin(6)` (direccionesDeCodigo ya lo tomaba, scanPins no: avisaba que el
  // pin del botón "no lo usa el código").
  micropython: [/Pin\s*\(\s*(\d{1,2})/g, /Pin\s*\(\s*"GPIO(\d{1,2})"/g, /\bsimbridge\.pin\s*\(\s*(\d{1,2})/g],
};

/** Comentarios por lenguaje: lo que está comentado no es código y no usa ningún pin. */
const COMENTARIOS: Record<Language, RegExp[]> = {
  esphome: [/#[^\n]*/g],
  micropython: [/#[^\n]*/g],
  // En C/C++ `#` abre directivas (`#define PIN_LED 7`), que sí cuentan: solo // y /* */.
  'idf-c': [/\/\/[^\n]*/g, /\/\*[\s\S]*?\*\//g],
  'idf-cpp': [/\/\/[^\n]*/g, /\/\*[\s\S]*?\*\//g],
  arduino: [/\/\/[^\n]*/g, /\/\*[\s\S]*?\*\//g],
};

/**
 * Saca los comentarios, dejando los saltos de línea en su lugar (los patrones de ESPHome
 * anclan por línea). Aproximado como el resto del escaneo: un `#` o `//` dentro de un
 * string se toma por comentario, lo que a lo sumo deja de ver un pin — nunca inventa uno.
 */
function sinComentarios(language: Language, content: string): string {
  let out = content;
  for (const re of COMENTARIOS[language] ?? []) {
    out = out.replace(new RegExp(re.source, re.flags), (m) => m.replace(/[^\n]/g, ' '));
  }
  return out;
}

/**
 * Arduino en placas AVR: además de los números, `A0`..`A5` (= 14..19) y `LED_BUILTIN` (= 13),
 * y constantes `const int PIN_X = 13;` / `#define PIN_X 13` usadas en pinMode/digitalWrite.
 */
const RE_ARDUINO_AVR: RegExp[] = [
  /\b(?:pinMode|digitalWrite|digitalRead|analogRead|analogWrite)\s*\(\s*(A\d|LED_BUILTIN|\d{1,2})\b/g,
];

function valorPinAvr(txt: string): number | null {
  if (txt === 'LED_BUILTIN') return 13;
  if (/^A\d$/.test(txt)) return 14 + Number(txt.slice(1));
  return Number(txt);
}

export function scanPins(language: Language, content: string, desc?: BoardDescriptor): number[] {
  const found = new Set<number>();
  // Un `Pin(7, Pin.OUT)` comentado no prende nada: contarlo avisaba de un pin que el código no usa.
  const texto = sinComentarios(language, content);
  // Con descriptor, solo los pines que la placa tiene; sin él, el rango del ESP32-S3.
  const validos = desc ? new Set(Object.values(desc.pins).map((p) => p.gpio)) : null;
  /** ¿La placa tiene ese pin? (sin descriptor, el rango del ESP32-S3, como siempre). */
  const esValido = (n: number): boolean => (validos ? validos.has(n) : n <= 48);
  const agregar = (n: number | null): void => {
    if (n === null || !Number.isInteger(n) || n < 0) return;
    if (esValido(n)) found.add(n);
  };
  // Números de pin estilo Arduino AVR (A0 = 14, LED_BUILTIN = 13): la placa usa arduino-cli.
  const avr = desc?.languages.arduino?.toolchain === 'arduino-cli';
  for (const re of avr && language === 'arduino' ? RE_ARDUINO_AVR : RE_BY_LANGUAGE[language]) {
    const rx = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(texto)) !== null) {
      agregar(avr ? valorPinAvr(m[1]!) : Number(m[1]));
      if (m.index === rx.lastIndex) rx.lastIndex++; // evita loops en regex globales
    }
  }
  if (avr && language === 'arduino') {
    // Constantes con nombre que después se usan en pinMode/digitalWrite/digitalRead.
    const usadas = new Set<string>();
    for (const m of texto.matchAll(/\b(?:pinMode|digitalWrite|digitalRead|analogRead|analogWrite)\s*\(\s*([A-Za-z_]\w*)/g)) usadas.add(m[1]!);
    for (const m of texto.matchAll(/(?:#define\s+([A-Za-z_]\w*)\s+|\b(?:const\s+)?(?:int|byte|uint8_t)\s+([A-Za-z_]\w*)\s*=\s*)(A\d|LED_BUILTIN|\d{1,2})\b/g)) {
      const nombre = m[1] ?? m[2]!;
      if (usadas.has(nombre)) agregar(valorPinAvr(m[3]!));
    }
    // Pines que se le pasan a una librería al crear el objeto: `Adafruit_ST7735 tft(10, 9, 8);`,
    // `LiquidCrystal lcd(12, 11, 5, 4, 3, 2);`.
    //
    // Solo si **todos** los argumentos son pines que la placa tiene de verdad. Alcanzaba con pedir
    // que tuvieran forma de número corto, pero eso inventa pines: en `LiquidCrystal_I2C lcd(39,
    // 16, 2);` los tres la tienen, y en realidad son una dirección I2C, columnas y filas. Pedir
    // que sean pines válidos descarta la declaración entera por el 39, que en el Uno no existe.
    //
    // Queda un caso que no se cubre: un dispositivo I2C cuya dirección caiga en el rango de los
    // pines (`lcd(8, 16, 2)`). Para eso haría falta saber qué recibe cada clase, que es justo lo
    // que esta heurística evita.
    for (const m of texto.matchAll(/^\s*[A-Z]\w*\s+[A-Za-z_]\w*\s*\(([^()]*)\)\s*;/gm)) {
      const args = m[1]!.split(',').map((a) => a.trim());
      const pines = args.map((a) => (/^(?:A\d|\d{1,2})$/.test(a) ? valorPinAvr(a) : null));
      if (args.length > 0 && pines.every((g) => g !== null && esValido(g))) pines.forEach(agregar);
    }
  }
  // El I2C usa sus pines sin que el código los nombre: Wire (y las librerías de sensores, que
  // incluyen Wire.h) toma SDA/SCL del bus de la placa. Sin esto, cablear un sensor I2C avisaba
  // "un módulo cableado a A5 que el código no usa".
  if (language === 'arduino' && /#\s*include\s*<Wire\.h>|\bWire\s*\.|\bTwoWire\b/.test(texto)) {
    for (const bus of desc?.buses?.i2c ?? []) {
      agregar(bus.sda);
      agregar(bus.scl);
    }
  }
  // Lo mismo con el SPI: SCK, MOSI y MISO son los del bus (D13, D11 y D12 en el Uno).
  if (language === 'arduino' && /#\s*include\s*<SPI\.h>|\bSPI\s*\./.test(texto)) {
    for (const bus of desc?.buses?.spi ?? []) {
      agregar(bus.sck);
      agregar(bus.mosi);
      agregar(bus.miso);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Cómo configura el programa cada pin: salida, o entrada con o sin resistencia interna (pull).
 * Es lo que decide, en la placa real, si un pin entrega corriente o solo escucha — no lo que
 * tenga enchufado. Lee las formas habituales de cada lenguaje (las de las plantillas y las de
 * la documentación de cada plataforma); un pin que el código no configura no aparece.
 */
export function direccionesDeCodigo(language: Language, contenido: string): Map<number, DireccionPin> {
  // Mismo criterio que scanPins: un pin configurado en una línea comentada no se configura.
  const content = sinComentarios(language, contenido);
  const d = new Map<number, DireccionPin>();
  const salida = (g: number | null, openDrain = false, pull?: 'up' | 'down') => { if (g !== null) d.set(g, { salida: true, ...(openDrain ? { openDrain: true } : {}), ...(pull ? { pull } : {}) }); };
  const entrada = (g: number | null, pull?: 'up' | 'down') => { if (g !== null) d.set(g, pull ? { salida: false, pull } : { salida: false }); };
  const conPull = (g: number | null, pull: 'up' | 'down') => {
    if (g === null) return;
    const a = d.get(g);
    if (!a?.salida) d.set(g, { salida: false, pull });
  };
  const pullDe = (txt: string): 'up' | 'down' | undefined => (/PULL_?UP/i.test(txt) ? 'up' : /PULL_?DOWN/i.test(txt) ? 'down' : undefined);

  switch (language) {
    case 'esphome': {
      let raiz: unknown;
      try {
        raiz = parseDocument(content, { logLevel: 'silent' }).toJS({ maxAliasCount: 50 });
      } catch {
        return d;
      }
      if (!raiz || typeof raiz !== 'object') return d;
      const numero = (pin: unknown): number | null => {
        const v = pin && typeof pin === 'object' ? (pin as Record<string, unknown>).number : pin;
        const m = /^(?:GPIO)?(\d{1,2})$/i.exec(String(v ?? '').trim());
        return m ? Number(m[1]) : null;
      };
      const modo = (pin: unknown): DireccionPin | null => {
        const m = pin && typeof pin === 'object' ? (pin as Record<string, unknown>).mode : undefined;
        if (typeof m === 'string') return { salida: /OUTPUT/i.test(m), openDrain: /OPEN_DRAIN/i.test(m), pull: pullDe(m) };
        if (m && typeof m === 'object') {
          const o = m as Record<string, unknown>;
          return { salida: o.output === true, openDrain: o.open_drain === true, pull: o.pullup === true ? 'up' : o.pulldown === true ? 'down' : undefined };
        }
        return null;
      };
      const items = (k: string): Record<string, unknown>[] => {
        const v = (raiz as Record<string, unknown>)[k];
        return (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object');
      };
      // Plataformas gpio que manejan el pin (salidas).
      for (const k of ['output', 'switch', 'light', 'fan']) {
        for (const it of items(k)) if (it.platform === 'gpio' && it.pin !== undefined) {
          const m = modo(it.pin);
          salida(numero(it.pin), m?.openDrain, m?.pull);
        }
      }
      for (const it of items('binary_sensor')) {
        if (it.platform !== 'gpio' || it.pin === undefined) continue;
        const m = modo(it.pin);
        entrada(numero(it.pin), m?.pull);
      }
      break;
    }
    case 'micropython': {
      for (const m of content.matchAll(/\bsimbridge\.pin\s*\(\s*(\d{1,2})\s*\)/g)) entrada(Number(m[1]), 'up'); // reposa en 1
      for (const m of content.matchAll(/\bPin\s*\(\s*(\d{1,2})\s*,([^)]*)\)/g)) {
        const args = m[2] ?? '';
        if (/\bOUT\b|OPEN_DRAIN/.test(args)) salida(Number(m[1]), /OPEN_DRAIN/.test(args), pullDe(args));
        else if (/\bIN\b/.test(args)) entrada(Number(m[1]), pullDe(args));
      }
      break;
    }
    case 'arduino': {
      const constantes = constantesDePin(content);
      const valor = (x: string): number | null => resolverPin(x.trim(), constantes);
      for (const m of content.matchAll(/\bpinMode\s*\(\s*([\w]+)\s*,\s*(\w+)\s*\)/g)) {
        const g = valor(m[1] ?? '');
        const modo = m[2] ?? '';
        if (modo === 'OUTPUT' || modo === 'OUTPUT_OPEN_DRAIN') salida(g, modo === 'OUTPUT_OPEN_DRAIN');
        else if (modo.startsWith('INPUT')) entrada(g, pullDe(modo));
      }
      break;
    }
    case 'idf-c':
    case 'idf-cpp': {
      const constantes = constantesDePin(content);
      const valor = (x: string): number | null => resolverPin(x.trim(), constantes);
      // gpio_config_t: con inicializador designado ({ .mode = ... }) o asignando campo por campo.
      const structs = new Map<string, string>();
      for (const m of content.matchAll(/gpio_config_t\s+(\w+)\s*=\s*\{([\s\S]*?)\};/g)) structs.set(m[1] ?? '', m[2] ?? '');
      for (const m of content.matchAll(/\b(\w+)\.(pin_bit_mask|mode|pull_up_en|pull_down_en)\s*=\s*([^;]+);/g)) {
        const k = m[1] ?? '';
        structs.set(k, `${structs.get(k) ?? ''}\n.${m[2]} = ${m[3]},`);
      }
      for (const cuerpo of structs.values()) {
        const pines = [...cuerpo.matchAll(/(?:1ULL|1ull|1UL|1)\s*<<\s*\(?\s*(\w+)\s*\)?|BIT(?:64)?\s*\(\s*(\w+)\s*\)/g)]
          .map((x) => valor(x[1] ?? x[2] ?? ''));
        const modo = /\.mode\s*=\s*(\w+)/.exec(cuerpo)?.[1] ?? '';
        const up = /\.pull_up_en\s*=\s*GPIO_PULLUP_ENABLE|\.pull_up_en\s*=\s*1/.test(cuerpo);
        const down = /\.pull_down_en\s*=\s*GPIO_PULLDOWN_ENABLE|\.pull_down_en\s*=\s*1/.test(cuerpo);
        for (const g of pines) {
          if (/OUTPUT/.test(modo)) salida(g, /_OD$/.test(modo), up ? 'up' : down ? 'down' : undefined);
          else if (/INPUT/.test(modo)) entrada(g, up ? 'up' : down ? 'down' : undefined);
        }
      }
      for (const m of content.matchAll(/gpio_set_direction\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g)) {
        if (/OUTPUT/.test(m[2] ?? '')) salida(valor(m[1] ?? ''), /_OD$/.test(m[2] ?? ''));
        else entrada(valor(m[1] ?? ''), d.get(valor(m[1] ?? '') ?? -1)?.pull);
      }
      for (const m of content.matchAll(/gpio_set_pull_mode\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g)) {
        const pull = /PULLUP/.test(m[2] ?? '') ? 'up' : /PULLDOWN/.test(m[2] ?? '') ? 'down' : undefined;
        if (pull) conPull(valor(m[1] ?? ''), pull);
      }
      for (const m of content.matchAll(/gpio_(pullup|pulldown)_en\s*\(\s*(\w+)\s*\)/g)) conPull(valor(m[2] ?? ''), m[1] === 'pullup' ? 'up' : 'down');
      break;
    }
  }
  return d;
}

/** `#define X 13`, `const int X = 13;`, `#define X GPIO_NUM_6`: nombre → texto del valor. */
function constantesDePin(content: string): Map<string, string> {
  const c = new Map<string, string>();
  for (const m of content.matchAll(/#define\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*|\d{1,2})\b/g)) c.set(m[1] ?? '', m[2] ?? '');
  for (const m of content.matchAll(/\b(?:const(?:expr)?\s+)?(?:int|byte|uint8_t|gpio_num_t)\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*|\d{1,2})\b/g)) c.set(m[1] ?? '', m[2] ?? '');
  return c;
}

/** Número de pin de un texto: 13, A0, LED_BUILTIN, GPIO_NUM_6 o una constante que lleva a eso. */
function resolverPin(x: string, constantes: Map<string, string>, prof = 0): number | null {
  if (/^\d{1,2}$/.test(x)) return Number(x);
  const num = /^GPIO_NUM_(\d{1,2})$/.exec(x);
  if (num) return Number(num[1]);
  if (/^A\d$|^LED_BUILTIN$/.test(x)) return valorPinAvr(x);
  const v = constantes.get(x);
  return v !== undefined && prof < 5 ? resolverPin(v, constantes, prof + 1) : null;
}

export interface DiagramWarning {
  kind: 'module-pin-unused' | 'code-pin-unwired' | 'blocked-pin-used' | 'peligro-electrico' | 'advertencia-electrica';
  pin: number;
  message: string;
  /** Refs "id.PIN" involucradas (solo en avisos eléctricos), para resaltar en el canvas. */
  refs?: string[];
}

/** Pin lógico de una punta de cable que va a la placa: "board.GPIO6" (6.1), "board.6", "board.D13". */
function boardGpio(ref: string, desc?: BoardDescriptor): number | null {
  const m = ref.match(/^board[.:](.+)$/i);
  if (!m) return null;
  if (/^\d{1,3}$/.test(m[1]!)) return Number(m[1]);
  return gpioDePin(desc, desc ? m[1]! : m[1]!.toUpperCase());
}

/** Compara el dibujo con los pines del código (11.6). Avisa, no bloquea. */
export function diffDiagramVsCode(project: Project, codePins: number[], desc?: BoardDescriptor): DiagramWarning[] {
  const warnings: DiagramWarning[] = [];
  const diagramPins = new Set<number>();
  for (const wire of project.wires) {
    for (const ref of [wire.from, wire.to]) {
      const pin = boardGpio(ref, desc);
      if (pin !== null) diagramPins.add(pin);
    }
  }
  // MISO del bus SPI: el programa lo usa si incluye SPI.h, pero una pantalla (solo escritura) no lo
  // cablea, así que no se avisa de él.
  //
  // La exención vale solo cuando los tres pines del bus están en el código, que es la firma de que
  // los puso `scanPins` al ver `SPI.h`. Si está el MISO solo, lo nombró el programa a mano y ahí el
  // aviso sí corresponde: antes se eximía siempre y un sketch que maneja D12 sin SPI de por medio
  // se quedaba sin él.
  const miso = new Set(
    (desc?.buses?.spi ?? [])
      .filter((b) => codePins.includes(b.sck) && codePins.includes(b.mosi) && codePins.includes(b.miso))
      .map((b) => b.miso),
  );
  for (const pin of codePins) {
    if (!diagramPins.has(pin) && !miso.has(pin)) {
      warnings.push({
        kind: 'code-pin-unwired',
        pin,
        message: `El código usa el pin ${nombreDePin(desc, pin)} pero ningún módulo del dibujo está cableado ahí.`,
      });
    }
  }
  for (const pin of diagramPins) {
    if (!codePins.includes(pin)) {
      warnings.push({
        kind: 'module-pin-unused',
        pin,
        message: `Hay un módulo cableado al pin ${nombreDePin(desc, pin)} que el código no usa.`,
      });
    }
  }
  return warnings;
}
