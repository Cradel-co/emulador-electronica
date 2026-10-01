import { gpioDePin, nombreDePin, type BoardDescriptor, type Language, type Project } from '@emu/shared';

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
  micropython: [/Pin\s*\(\s*(\d{1,2})/g, /Pin\s*\(\s*"GPIO(\d{1,2})"/g],
};

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
  // Con descriptor, solo los pines que la placa tiene; sin él, el rango del ESP32-S3.
  const validos = desc ? new Set(Object.values(desc.pins).map((p) => p.gpio)) : null;
  const agregar = (n: number | null): void => {
    if (n === null || !Number.isInteger(n) || n < 0) return;
    if (validos ? validos.has(n) : n <= 48) found.add(n);
  };
  // Números de pin estilo Arduino AVR (A0 = 14, LED_BUILTIN = 13): la placa usa arduino-cli.
  const avr = desc?.languages.arduino?.toolchain === 'arduino-cli';
  for (const re of avr && language === 'arduino' ? RE_ARDUINO_AVR : RE_BY_LANGUAGE[language]) {
    const rx = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(content)) !== null) {
      agregar(avr ? valorPinAvr(m[1]!) : Number(m[1]));
      if (m.index === rx.lastIndex) rx.lastIndex++; // evita loops en regex globales
    }
  }
  if (avr && language === 'arduino') {
    // Constantes con nombre que después se usan en pinMode/digitalWrite/digitalRead.
    const usadas = new Set<string>();
    for (const m of content.matchAll(/\b(?:pinMode|digitalWrite|digitalRead|analogRead|analogWrite)\s*\(\s*([A-Za-z_]\w*)/g)) usadas.add(m[1]!);
    for (const m of content.matchAll(/(?:#define\s+([A-Za-z_]\w*)\s+|\b(?:const\s+)?(?:int|byte|uint8_t)\s+([A-Za-z_]\w*)\s*=\s*)(A\d|LED_BUILTIN|\d{1,2})\b/g)) {
      const nombre = m[1] ?? m[2]!;
      if (usadas.has(nombre)) agregar(valorPinAvr(m[3]!));
    }
  }
  return [...found].sort((a, b) => a - b);
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
  for (const pin of codePins) {
    if (!diagramPins.has(pin)) {
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
