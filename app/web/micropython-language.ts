import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { pythonLanguage } from '@codemirror/lang-python';
import type { Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';

// API de ESP32 seleccionada: https://docs.micropython.org/en/latest/esp32/quickref.html
// El catálogo ayuda a completar; la disponibilidad depende de la placa y el firmware.
const catalog: Record<string, string[]> = {
  machine: ['Pin', 'ADC', 'PWM', 'I2C', 'SoftI2C', 'SPI', 'SoftSPI', 'UART', 'Timer', 'RTC', 'WDT', 'TouchPad', 'freq', 'reset', 'soft_reset', 'unique_id', 'idle', 'sleep', 'lightsleep', 'deepsleep', 'reset_cause', 'wake_reason', 'disable_irq', 'enable_irq', 'time_pulse_us', 'bitstream', 'mem8', 'mem16', 'mem32'],
  'machine.Pin': ['IN', 'OUT', 'OPEN_DRAIN', 'PULL_UP', 'PULL_DOWN', 'IRQ_RISING', 'IRQ_FALLING', 'value', 'on', 'off', 'init', 'irq'],
  'machine.ADC': ['ATTN_0DB', 'ATTN_2_5DB', 'ATTN_6DB', 'ATTN_11DB', 'read', 'read_u16', 'read_uv', 'atten', 'width'],
  'machine.PWM': ['init', 'deinit', 'freq', 'duty', 'duty_u16', 'duty_ns'],
  'machine.I2C': ['init', 'deinit', 'scan', 'readfrom', 'readfrom_into', 'writeto', 'readfrom_mem', 'readfrom_mem_into', 'writeto_mem'],
  'machine.SPI': ['MSB', 'LSB', 'init', 'deinit', 'read', 'readinto', 'write', 'write_readinto'],
  'machine.UART': ['init', 'deinit', 'read', 'readline', 'readinto', 'write', 'any', 'flush', 'txdone', 'irq'],
  'machine.Timer': ['ONE_SHOT', 'PERIODIC', 'init', 'deinit'],
  'machine.RTC': ['datetime', 'init', 'deinit', 'alarm', 'alarm_left', 'cancel', 'irq'],
  'machine.WDT': ['feed'],
  'machine.TouchPad': ['read', 'config'],
  network: ['WLAN', 'LAN', 'STA_IF', 'AP_IF', 'STAT_IDLE', 'STAT_CONNECTING', 'STAT_WRONG_PASSWORD', 'STAT_NO_AP_FOUND', 'STAT_CONNECT_FAIL', 'STAT_GOT_IP'],
  'network.WLAN': ['IF_STA', 'IF_AP', 'active', 'connect', 'disconnect', 'scan', 'status', 'isconnected', 'ifconfig', 'ipconfig', 'config'],
  time: ['sleep', 'sleep_ms', 'sleep_us', 'ticks_ms', 'ticks_us', 'ticks_cpu', 'ticks_add', 'ticks_diff', 'time', 'time_ns', 'localtime', 'gmtime', 'mktime'],
  esp32: ['RMT', 'ULP', 'Partition', 'wake_on_ext0', 'wake_on_ext1', 'wake_on_touch', 'raw_temperature', 'idf_heap_info', 'HEAP_DATA', 'HEAP_EXEC', 'WAKEUP_ALL_LOW', 'WAKEUP_ANY_HIGH'],
  'esp32.RMT': ['write_pulses', 'wait_done', 'loop', 'deinit', 'source_freq'],
  'esp32.Partition': ['BOOT', 'RUNNING', 'TYPE_APP', 'TYPE_DATA', 'find', 'info', 'readblocks', 'writeblocks', 'ioctl', 'set_boot', 'get_next_update', 'mark_app_valid_cancel_rollback'],
  neopixel: ['NeoPixel'],
  'neopixel.NeoPixel': ['write', 'fill'],
  dht: ['DHT11', 'DHT22'],
  'dht.DHT11': ['measure', 'temperature', 'humidity'],
  'dht.DHT22': ['measure', 'temperature', 'humidity'],
  onewire: ['OneWire'],
  'onewire.OneWire': ['scan', 'reset', 'select_rom', 'readbit', 'writebit', 'readbyte', 'writebyte', 'readinto', 'write', 'crc8'],
  umqtt: ['simple', 'robust'],
  'umqtt.simple': ['MQTTClient'],
  'umqtt.robust': ['MQTTClient'],
  'umqtt.simple.MQTTClient': ['connect', 'disconnect', 'ping', 'publish', 'subscribe', 'set_callback', 'set_last_will', 'wait_msg', 'check_msg'],
};
catalog['machine.SoftI2C'] = catalog['machine.I2C'] ?? [];
catalog['machine.SoftSPI'] = catalog['machine.SPI'] ?? [];
catalog['umqtt.robust.MQTTClient'] = [...(catalog['umqtt.simple.MQTTClient'] ?? []), 'reconnect'];
const modules = Object.keys(catalog).filter((name) => !name.includes('.'));
const keywords = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(' ');
const builtins = 'abs all any bool bytes bytearray chr dict enumerate float int len list max min ord print range repr round set str sum tuple type zip'.split(' ');

/** Oculta comentarios y cadenas conservando posiciones para interpretar imports reales. */
function codeOnly(source: string): { code: string; ignored: Array<[number, number]> } {
  const ignored: Array<[number, number]> = [];
  pythonLanguage.parser.parse(source).iterate({ enter(node) {
    if (['String', 'FormatString', 'Comment'].includes(node.name)) {
      ignored.push([node.from, node.to]);
      return false;
    }
  } });
  const pieces: string[] = [];
  let previous = 0;
  for (const [from, to] of ignored) {
    pieces.push(source.slice(previous, from), source.slice(from, to).replace(/[^\n]/g, ' '));
    previous = to;
  }
  pieces.push(source.slice(previous));
  return { code: pieces.join(''), ignored };
}

function importedNames(code: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of code.matchAll(/(?:^|\n)\s*import\s+([^\n;]+)/g)) {
    for (const item of (match[1] ?? '').split(',')) {
      const part = item.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/);
      if (!part?.[1]) continue;
      const moduleName = part[1];
      const rootName = moduleName.split('.')[0] ?? moduleName;
      names.set(part[2] ?? rootName, part[2] ? moduleName : rootName);
    }
  }
  for (const match of code.matchAll(/(?:^|\n)\s*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n;]+)/g)) {
    for (const item of (match[2] ?? '').replace(/[()]/g, '').split(',')) {
      const part = item.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (part?.[1]) names.set(part[2] ?? part[1], `${match[1]}.${part[1]}`);
    }
  }
  // Reconoce asignaciones directas de constructores; no hace análisis de tipos.
  for (const match of code.matchAll(/(?:^|\n)\s*(\w+)\s*=\s*([\w.]+)\s*\(/g)) {
    const resolved = resolveName(match[2] ?? '', names);
    if (catalog[resolved]) names.set(match[1] ?? '', resolved);
  }
  return names;
}

function resolveName(name: string, names: Map<string, string>): string {
  const [head, ...tail] = name.split('.');
  return [names.get(head ?? '') ?? head, ...tail].join('.');
}

function optionsFor(owner: string): Completion[] {
  return (catalog[owner] ?? []).map((label) => ({
    label,
    type: catalog[`${owner}.${label}`] ? (/^[A-Z_]+$/.test(label) ? 'constant' : 'class') : /^[A-Z_]+$/.test(label) ? 'constant' : 'function',
    detail: `${owner}.${label}`,
  }));
}

export function getMicroPythonCompletions(source: string, pos: number, explicit = false): CompletionResult | null {
  const { code, ignored } = codeOnly(source);
  if (ignored.some(([from, to]) => pos > from && pos <= to)) return null;
  const before = code.slice(0, pos);
  const names = importedNames(before);
  const member = before.match(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_]\w*)?$/);
  if (member) {
    const owner = resolveName(member[1] ?? '', names);
    const options = optionsFor(owner);
    return options.length ? { from: pos - (member[2]?.length ?? 0), options, validFor: /^\w*$/ } : null;
  }
  const fromImport = before.match(/(?:^|\n)\s*from\s+([\w.]+)\s+import\s+(?:\(?[\w\s,]*,\s*)?(\w*)$/);
  if (fromImport) return { from: pos - (fromImport[2] ?? '').length, options: optionsFor(fromImport[1] ?? ''), validFor: /^\w*$/ };
  const word = before.match(/[A-Za-z_]\w*$/)?.[0] ?? '';
  if (!word && !explicit) return null;
  const options: Completion[] = [
    ...modules.map((label) => ({ label, type: 'namespace', detail: 'MicroPython' })),
    ...keywords.map((label) => ({ label, type: 'keyword' })),
    ...builtins.map((label) => ({ label, type: 'function', detail: 'Python' })),
    ...Array.from(names, ([label, detail]) => ({ label, type: 'variable', detail })),
  ];
  return { from: pos - word.length, options: options.filter((item, index) => options.findIndex((other) => other.label === item.label) === index), validFor: /^\w*$/ };
}

export function micropythonCompletionSource(context: CompletionContext): CompletionResult | null {
  return getMicroPythonCompletions(context.state.doc.toString(), context.pos, context.explicit);
}

/** Los nodos de recuperación de Lezer detectan errores gramaticales, no de ejecución. */
export function checkMicroPythonSyntax(source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  pythonLanguage.parser.parse(source).iterate({ enter(node) {
    if (node.type.isError) {
      const from = Math.min(node.from, source.length);
      const to = Math.min(source.length, Math.max(from, node.to));
      if (!diagnostics.some((entry) => entry.from === from && entry.to === to)) diagnostics.push({
        from, to, severity: 'error', source: 'Sintaxis Python',
        message: 'Sintaxis Python incompleta o inválida. Revisá la indentación, los delimitadores y los dos puntos.',
      });
    }
  } });
  return diagnostics;
}

export function micropythonSyntaxDiagnostics(view: EditorView): Diagnostic[] {
  return checkMicroPythonSyntax(view.state.doc.toString());
}
