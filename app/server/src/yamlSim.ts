import { parseDocument, isMap, isSeq, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml';
import type { Project } from '@emu/shared';

/** Tags propios de ESPHome (!secret, !lambda, !include, !extend, !remove, …):
 * el parser no los conoce, así que solo avisa por consola; se conservan tal
 * cual al serializar y main.sim.yaml sigue siendo válido para ESPHome (8.1).
 * logLevel 'error' silencia esos avisos sin tapar los errores de sintaxis. */
const PARSE_OPTIONS = { keepSourceTokens: true, logLevel: 'error' } as const;

/**
 * Pines del puente: UART1 (sección 8.2). Los de cada placa salen de su descriptor
 * (`board.io.tx/rx` del module.json); estos son los del ESP32-S3, la placa por defecto.
 */
export const BRIDGE_UART_ID = 'sim_bridge_uart';
export const BRIDGE_UART_TX = 17;
export const BRIDGE_UART_RX = 18;
/** Pines que la propia simulación usa en el S3: no se pueden ofrecer como entradas. */
export const PINES_BLOQUEADOS = new Set([0, 3, 17, 18, 19, 20, 43, 44, 45, 46, 47, 48]);

/**
 * Lo que la simulación de ESPHome necesita saber de la placa. Lo arma el toolchain
 * `esphome` (toolchains/esphome.ts) desde el descriptor: `board.io`, `board.reservedPins`,
 * `board.features` y `board.languages.esphome.options`.
 */
export interface PlacaEsphome {
  nombre: string;
  chip: string;
  /** `esp32.board` / `esp32.variant` de ESPHome. */
  board: string;
  variant: string;
  uartTx: number;
  uartRx: number;
  /** Pines que no se pueden simular como entrada (reservados + los que esp-emu no acepta). */
  sinEntrada: Set<number>;
  /** ¿Se simula RF 433 (RMT + --rmt-loopback)? */
  rf: boolean;
}

export const PLACA_ESPHOME_S3: PlacaEsphome = {
  nombre: 'ESP32-S3 DevKitC-1',
  chip: 'ESP32-S3',
  board: 'esp32-s3-devkitc-1',
  variant: 'esp32s3',
  uartTx: BRIDGE_UART_TX,
  uartRx: BRIDGE_UART_RX,
  sinEntrada: PINES_BLOQUEADOS,
  rf: true,
};
// El id no puede llamarse igual a la plataforma (`sim_bridge`), o ESPHome
// lo rechaza por conflicto de nombres.
export const BRIDGE_ID = 'puente_sim';

/**
 * Canales RMT absolutos (sección 7.3). En el ESP32-S3 los canales RX arrancan
 * en el índice 4, y `remote_transmitter` toma el TX 0 por defecto: por eso el
 * puente usa 1 para inyectar y 5 para capturar, y la app pasa los pares
 * `1:<rx del usuario>` y `<tx del usuario>:5` a `--rmt-loopback`.
 */
export const BRIDGE_RMT_TX_CHANNEL = 1;
export const BRIDGE_RMT_RX_CHANNEL = 5;

/** Canales RMT que usa el código del usuario (los de ESPHome por defecto). */
export const USER_RF_TX_CHANNEL = 0;
export const USER_RF_RX_CHANNEL = 4;

export interface SimOptions {
  /** Placa del proyecto. Por defecto, ESP32-S3. */
  placa?: PlacaEsphome;
  wifiSsid: string;
  wifiPassword: string;
  /** Canal RMT del `remote_transmitter` del usuario (de ahí lee el puente). */
  rfTxChannel?: number;
  /** Canal RMT del `remote_receiver` del usuario (ahí inyecta el puente). */
  rfRxChannel?: number;
  rfRxPin?: number;
  rfTxPin?: number;
}

/** Pares TX:RX que hay que pasarle a `esp-emu --rmt-loopback`. */
export function rmtLoopbackPairs(userTx = USER_RF_TX_CHANNEL, userRx = USER_RF_RX_CHANNEL): string[] {
  return [`${BRIDGE_RMT_TX_CHANNEL}:${userRx}`, `${userTx}:${BRIDGE_RMT_RX_CHANNEL}`];
}

export interface ApplyResult {
  text: string;
  /** Línea de main.sim.yaml -> línea de main.yaml (o null si es generada). */
  lineMap: LineMap;
  warnings: string[];
}

/**
 * Mapa de líneas de main.sim.yaml a main.yaml (8.5). Los nodos que vienen del
 * YAML del usuario conservan su offset, así que la correspondencia es directa;
 * las líneas que agrega la app no tienen origen y quedan como "generadas".
 */
export class LineMap {
  private readonly map = new Map<number, number | null>();

  add(simLine: number, srcLine: number | null): void {
    this.map.set(simLine, srcLine);
  }

  /** Línea en main.yaml para una línea de main.sim.yaml, o null si es generada. */
  toSource(simLine: number): number | null {
    return this.map.has(simLine) ? this.map.get(simLine)! : null;
  }

  isGenerated(simLine: number): boolean {
    return !this.map.has(simLine);
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Alinea las líneas del YAML original con las de main.sim.yaml.
 *
 * El documento de `yaml` conserva los offsets del origen, pero comparar texto
 * generado contra esos offsets mezcla dos sistemas de coordenadas. En vez de eso
 * se hace un alineamiento línea a línea con una ventana de búsqueda: las
 * líneas idénticas se emparejan (y knows de qué línea del archivo del usuario
 * vienen) y las que solo existen en main.sim.yaml son "generadas" (las agregó la
 * app), que es justo lo que el editor necesita para ubicar un error.
 */
export function buildLineMap(sourceText: string, simText: string): LineMap {
  const src = sourceText.split('\n');
  const sim = simText.split('\n');
  const lineMap = new LineMap();
  const WINDOW = 400;
  let i = 0;
  let j = 0;
  while (j < sim.length) {
    if (i < src.length && src[i] === sim[j]) {
      lineMap.add(j + 1, i + 1);
      i++;
      j++;
      continue;
    }
    // ¿La línea de simulación aparece pronto en el original?
    let found = -1;
    for (let k = i; k < Math.min(i + WINDOW, src.length); k++) {
      if (src[k] === sim[j]) {
        found = k;
        break;
      }
    }
    if (found >= 0) {
      i = found; // se saltan las líneas que la app quitó
      continue;
    }
    j++; // línea generada: no se registra
  }
  return lineMap;
}

function ensureMap(doc: Document, key: string): YAMLMap {
  if (!doc.contents) throw new Error('El YAML está vacío');
  const current = doc.get(key, true);
  if (current && isMap(current)) return current as YAMLMap;
  const created = doc.createNode({}) as YAMLMap;
  doc.set(key, created);
  return created;
}

/** Claves de un binary_sensor que la app necesita conservar al reescribirlo. */
const BS_MANTENER = [
  'id',
  'name',
  'icon',
  'device_class',
  'state_class',
  'unit_of_measurement',
  'internal',
  'filters',
  'on_press',
  'on_release',
  'on_click',
  'on_value',
  'on_value_range',
  'on_state',
  'on_boot',
  'on_loop',
  'disabled_by_default',
];

/**
 * `GPIO6`, `6` o `D2` -> 6 (o null si no es un pin numérico).
 * Acepta escalares de la librería yaml (objetos con `value`).
 */
function pinNumerico(value: unknown): number | null {
  let texto: string | null = null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') texto = value;
  else if (value && typeof value === 'object' && 'value' in value) {
    const crudo = (value as { value: unknown }).value;
    if (typeof crudo === 'number') return crudo;
    if (typeof crudo === 'string') texto = crudo;
  }
  if (texto === null) return null;
  const m = texto.trim().match(/^(?:GPIO[_-]?)?(\d+)$/i);
  if (m) return Number(m[1]);
  const d = texto.trim().match(/^[Dd](\d+)$/);
  return d ? Number(d[1]) : null;
}

/** Saca el número de pin de un bloque `pin:` de un binary_sensor gpio. */
function pinDeBinarySensor(item: YAMLMap): { pin: number; pullup: boolean } | null {
  const pin = item.get('pin', true);
  if (pin === undefined || pin === null) return null;
  if (!isMap(pin)) {
    // `pin: GPIO6` (escalar) o `pin: 6`.
    const n = pinNumerico(pin);
    return n === null ? null : { pin: n, pullup: false };
  }
  const map = pin as YAMLMap;
  const n = pinNumerico(map.get('number', true));
  if (n === null) return null;
  const mode: unknown = map.get('mode', true);
  let pullup = false;
  if (isMap(mode)) pullup = Boolean((mode as YAMLMap).get('pullup', true));
  else if (typeof mode === 'string') pullup = mode.toLowerCase().includes('pullup');
  else if (isSeq(mode)) {
    // mode: [input, pullup]
    pullup = mode.items.some((it) => String(it).toLowerCase().includes('pullup'));
  }
  return { pin: n, pullup };
}

export interface EntradaSimulada {
  pin: number;
  /** Nivel del pin sin que nadie lo toque: 1 si tiene pull-up. */
  idle: 0 | 1;
}

/**
 * Reescribe los `binary_sensor` de plataforma gpio como `platform: template`
 * cuya lambda consulta el estado publicado por `sim_bridge` (7.2).
 *
 * Devuelve las entradas que quedaron simuladas.
 */
function transformarEntradas(doc: Document, warnings: string[], bloqueados: Set<number>): EntradaSimulada[] {
  const bs = doc.get('binary_sensor', true);
  if (!bs || !isSeq(bs)) return [];
  const pines: EntradaSimulada[] = [];

  for (const node of bs.items) {
    if (!isMap(node)) continue;
    const item = node as YAMLMap;
    const platform = item.get('platform', true);
    if (platform !== undefined && String(platform) !== 'gpio') continue;
    const info = pinDeBinarySensor(item);
    if (info === null) {
      if (platform === undefined) {
        warnings.push(
          'Hay un binary_sensor sin `pin` numérico: se deja como estaba (no se puede simular).',
        );
      }
      continue;
    }
    if (bloqueados.has(info.pin)) {
      warnings.push(
        `GPIO${info.pin} lo usa el puente o el arranque en simulación: el binary_sensor quedó sin transformar.`,
      );
      continue;
    }

    // Estado lógico: con pull-up, "presionado" es nivel 0.
    const nivel = info.pullup ? '0' : '1';
    const lambda = `// Estado publicado por sim_bridge (inyección de la app).\nreturn id(${BRIDGE_ID})->input_state(${info.pin}) == ${nivel};`;

    const nuevo: Record<string, unknown> = { platform: 'template' };
    for (const key of BS_MANTENER) {
      const v = item.get(key, true);
      if (v !== undefined) nuevo[key] = v;
    }
    // Sin `update_interval`: la plataforma template sondea la lambda en cada
    // vuelta del loop principal de ESPHome (~16 ms), que es lo bastante
    // rápido para que la app se sienta inmediata.
    nuevo['lambda'] = lambda;

    for (const key of [...item.items.map((p) => p.key)]) item.delete(String(key));
    for (const [key, value] of Object.entries(nuevo)) item.set(key, doc.createNode(value));

    pines.push({ pin: info.pin, idle: info.pullup ? 1 : 0 });
  }

  // Si el mismo pin aparece en dos sensores, se simula una sola vez.
  const porPin = new Map<number, EntradaSimulada>();
  for (const e of pines) porPin.set(e.pin, e);
  return [...porPin.values()].sort((a, b) => a.pin - b.pin);
}

/** Agrega un elemento a una clave que puede ser lista o escalar único. */
function appendToList(doc: Document, key: string, item: unknown): void {
  const current = doc.get(key, true);
  if (current === undefined || current === null) {
    doc.set(key, doc.createNode([item]));
    return;
  }
  if (isSeq(current)) {
    (current as YAMLSeq).add(doc.createNode(item));
    return;
  }
  // Escalar único: pasa a lista conservando el valor del usuario (8.2).
  const asList = doc.createNode([(current as { toJSON?: () => unknown }).toJSON?.() ?? current]) as YAMLSeq;
  doc.set(key, asList);
  asList.add(doc.createNode(item));
}

/**
 * Aplica los ajustes obligatorios de simulación (8.2) sobre el YAML del
 * usuario y devuelve el texto resultante con el mapa de líneas.
 */
export function applySimulationSettings(userYaml: string, opts: SimOptions): ApplyResult {
  const warnings: string[] = [];
  const doc = parseDocument(userYaml, PARSE_OPTIONS);

  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new Error(`YAML inválido: ${first.message} (línea ${first.linePos?.[0]?.line ?? '?'})`);
  }
  if (!doc.contents || !isMap(doc.contents)) throw new Error('El YAML no tiene un mapa raíz');

  // 1) esphome: y esp32: con la placa del proyecto (8.1)
  const placa = opts.placa ?? PLACA_ESPHOME_S3;
  const esphomePlaca = placa;
  if (!doc.has('esphome')) throw new Error('Falta la clave "esphome:" en el YAML');
  if (!doc.has('esp32')) throw new Error(`Falta la clave "esp32:" en el YAML (se espera ${placa.chip})`);
  // El firmware tiene que ser del mismo chip que emula esp-emu: si el YAML dice otra
  // placa (p. ej. un YAML de S3 en un proyecto de C3), se corrige y se avisa.
  const esp32 = doc.get('esp32', true);
  if (isMap(esp32)) {
    const m = esp32 as YAMLMap;
    const boardYaml = m.get('board');
    const variantYaml = m.get('variant');
    if (boardYaml !== undefined && String(boardYaml) !== esphomePlaca.board) {
      warnings.push(`esp32.board era "${String(boardYaml)}"; el proyecto es para ${placa.nombre}: se compila con board: ${esphomePlaca.board}.`);
    }
    if (variantYaml !== undefined && String(variantYaml).toLowerCase() !== esphomePlaca.variant) {
      warnings.push(`esp32.variant era "${String(variantYaml)}"; se usa ${esphomePlaca.variant} (${placa.chip}).`);
      m.set('variant', esphomePlaca.variant);
    }
    if (boardYaml !== undefined || variantYaml === undefined) m.set('board', esphomePlaca.board);
  }

  // 2) logger.hardware_uart: UART0
  const logger = ensureMap(doc, 'logger');
  const hardwareUart = logger.get('hardware_uart', true);
  if (hardwareUart !== undefined && String(hardwareUart) !== 'UART0') {
    warnings.push(
      `logger.hardware_uart era "${String(hardwareUart)}"; la simulación lo fuerza a UART0 (si no, el emulador se cuelga).`,
    );
  }
  logger.set('hardware_uart', 'UART0');

  // 3) wifi: ssid/password de la simulación, sin networks
  const wifi = ensureMap(doc, 'wifi');
  if (wifi.has('networks')) {
    wifi.delete('networks');
    warnings.push('Se eliminó wifi.networks: en simulación solo existe la red del emulador.');
  }
  wifi.set('ssid', opts.wifiSsid);
  wifi.set('password', opts.wifiPassword);

  // 4) external_components: agregar la fuente local del puente, sin pisar la del usuario
  appendToList(doc, 'external_components', {
    source: { type: 'local', path: '/components' },
  });

  // 5) uart: bus del puente en UART1
  appendToList(doc, 'uart', {
    id: BRIDGE_UART_ID,
    tx_pin: `GPIO${placa.uartTx}`,
    rx_pin: `GPIO${placa.uartRx}`,
    baud_rate: 115200,
  });

  // 6) web_server.local si el usuario lo usa
  if (doc.has('web_server')) {
    const web = doc.get('web_server', true);
    if (isMap(web)) (web as YAMLMap).set('local', true);
    else warnings.push('web_server no es un mapa: se deja como está.');
  }

  // 7) entradas: `binary_sensor: platform: gpio` -> `platform: template`
  //    que consulta el estado publicado por el puente (7.2). Es la única vía
  //    que esp-emu respeta: inyectar en el pad no despierta la entrada interna
  //    del GPIO (medido en el laboratorio de Fase 0).
  const entradaPines = transformarEntradas(doc, warnings, placa.sinEntrada);

  // 8) sim_bridge: canales RMT del usuario y del puente
  const userTx = opts.rfTxChannel ?? USER_RF_TX_CHANNEL;
  const userRx = opts.rfRxChannel ?? USER_RF_RX_CHANNEL;
  const simBridge: Record<string, unknown> = {
    id: BRIDGE_ID,
    uart_id: BRIDGE_UART_ID,
    poll_interval: '10ms',
    // RF (RMT + --rmt-loopback) solo en las placas donde está medido (hoy, el S3).
    ...(placa.rf
      ? {
          rf_tx_channel: userTx,
          rf_rx_channel: userRx,
          bridge_rf_tx_channel: BRIDGE_RMT_TX_CHANNEL,
          bridge_rf_rx_channel: BRIDGE_RMT_RX_CHANNEL,
        }
      : {}),
    rf_protocol: 1,
    rf_repeat: 5,
  };
  if (opts.rfRxPin !== undefined) simBridge['rf_rx_pin'] = opts.rfRxPin;
  if (opts.rfTxPin !== undefined) simBridge['rf_tx_pin'] = opts.rfTxPin;
  if (entradaPines.length > 0) {
    simBridge['inputs'] = entradaPines.map((e) => ({ pin: e.pin, idle: e.idle }));
  }
  doc.set('sim_bridge', doc.createNode(simBridge));

  if (entradaPines.length > 0) {
    warnings.push(
      `Entradas simuladas: ${entradaPines.map((e) => `GPIO${e.pin}`).join(', ')} se leen por estado del puente ` +
        '(platform: template), no por el pad del GPIO.',
    );
  }

  const text = doc.toString({ lineWidth: 0 });
  return { text, lineMap: buildLineMap(userYaml, text), warnings };
}

/** Extrae errores de ESPHome del log de compilación (8.5). */
export interface BuildError {
  line: number | null;
  message: string;
  file: string | null;
}

const SOURCE_RE = /\[source ([^\]]+?):(\d+)\]/;

export function extractBuildErrors(lines: string[]): BuildError[] {
  const errors: BuildError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = stripAnsi(lines[i]!);
    const m = line.match(SOURCE_RE);
    if (m) {
      const file = m[1]!;
      const lineNo = Number(m[2]);
      // El mensaje suele estar en las 2-4 líneas siguientes.
      let message = '';
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const next = stripAnsi(lines[j]!);
        if (SOURCE_RE.test(next) || next.trim() === '') break;
        message += (message ? ' ' : '') + next.trim();
      }
      errors.push({ line: lineNo, message: message || line, file });
      continue;
    }
    // Errores de C++ dentro de lambdas: archivo:línea:col: error: mensaje
    const cpp = line.match(/^(.*?):(\d+):(\d+):\s*(?:fatal\s+)?error:\s*(.*)$/);
    if (cpp) {
      errors.push({
        file: cpp[1] ?? null,
        line: Number(cpp[2]),
        message: cpp[4] ?? 'error',
      });
    }
  }
  return errors;
}

function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
}

/** Aplica los ajustes a un proyecto y devuelve el YAML de simulación. */
export function buildSimYaml(project: Project, userYaml: string, opts: Partial<SimOptions> = {}): ApplyResult {
  return applySimulationSettings(userYaml, {
    wifiSsid: project.sim.wifiSsid,
    wifiPassword: project.sim.wifiPassword,
    ...opts,
  });
}
