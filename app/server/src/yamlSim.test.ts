import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  applySimulationSettings,
  BRIDGE_ID,
  BRIDGE_UART_ID,
  buildSimYaml,
  extractBuildErrors,
  LineMap,
  rmtLoopbackPairs,
} from './yamlSim.js';

const USER_YAML = `# Mi alarma
esphome:
  name: alarma
  friendly_name: "Alarma casa"

esp32:
  board: esp32-s3-devkitc-1
  framework:
    type: esp-idf

logger:
  level: DEBUG

wifi:
  ssid: mi_wifi
  password: clave_real
  networks:
    - networks:
        - ssid: otra

api:
  encryption:
    key: !secret api_key

script:
  - id: probar
    then:
      - lambda: |-
          ESP_LOGD("x", "hola %d", 42);

web_server:
  port: 80
`;

function apply(userYaml = USER_YAML, opts = {}) {
  return applySimulationSettings(userYaml, {
    wifiSsid: 'sim-wifi',
    wifiPassword: 'sim-password',
    ...opts,
  });
}

describe('applySimulationSettings', () => {
  it('fuerza logger.hardware_uart a UART0', () => {
    const { text } = apply();
    const doc = parse(text);
    expect((doc as Record<string, any>).logger.hardware_uart).toBe('UART0');
  });

  it('avisa si el usuario había puesto otro hardware_uart', () => {
    const { warnings } = apply('esphome:\n  name: x\nesp32:\n  board: esp32-s3-devkitc-1\nlogger:\n  hardware_uart: USB_CDC\n');
    expect(warnings.join(' ')).toContain('hardware_uart');
  });

  it('reemplaza ssid y password por los de la simulación y borra networks', () => {
    const wifi = (parse(apply().text) as Record<string, any>).wifi;
    expect(wifi.ssid).toBe('sim-wifi');
    expect(wifi.password).toBe('sim-password');
    expect('networks' in wifi).toBe(false);
  });

  it('agrega el puente: external_components local, uart UART1 y sim_bridge', () => {
    const doc = parse(apply().text) as Record<string, any>;
    const ext = doc.external_components;
    expect(Array.isArray(ext)).toBe(true);
    expect(ext.some((c: any) => c.source?.path === '/components')).toBe(true);
    const uart = doc.uart.find((u: any) => u.id === BRIDGE_UART_ID);
    expect(uart).toMatchObject({ tx_pin: 'GPIO17', rx_pin: 'GPIO18', baud_rate: 115200 });
    expect(doc.sim_bridge.id).toBe(BRIDGE_ID);
    expect(doc.sim_bridge.uart_id).toBe(BRIDGE_UART_ID);
  });

  it('respeta las listas que ya existían', () => {
    const userYaml = `${USER_YAML}\nextra_components: [a]\n`;
    const text = apply(userYaml).text;
    expect(parse(text)).toHaveProperty('extra_components');
  });

  it('conserva tags propios de ESPHome y lambdas sin interpretarlos', () => {
    const text = apply().text;
    expect(text).toContain('!secret api_key');
    expect(text).toContain('lambda: |-');
    expect(text).toContain('ESP_LOGD("x", "hola %d", 42);');
    // Y sigue siendo un YAML válido.
    expect(() => parse(text)).not.toThrow();
  });

  it('conserva comentarios', () => {
    expect(apply().text).toContain('# Mi alarma');
  });

  it('deja web_server.local en true', () => {
    expect((parse(apply().text) as Record<string, any>).web_server.local).toBe(true);
  });

  it('rechaza un YAML sin esphome o sin esp32 antes de llamar a Docker', () => {
    expect(() => apply('esp32:\n  board: esp32-s3-devkitc-1\n')).toThrow(/esphome/);
    expect(() => apply('esphome:\n  name: x\n')).toThrow(/esp32/);
  });

  it('avisa de un YAML sintácticamente roto', () => {
    expect(() => apply('esphome:\n  name: [sin cerrar\n')).toThrow(/YAML inválido/);
  });

  it('el mapa de líneas ubica el código del usuario y marca lo generado', () => {
    const { text, lineMap } = apply();
    const simLines = text.split('\n');
    const srcLines = USER_YAML.split('\n');

    // La línea de "api:" del usuario sigue apuntando a la suya.
    const simApiIdx = simLines.findIndex((l) => l.startsWith('api:'));
    const srcApiIdx = srcLines.findIndex((l) => l.startsWith('api:'));
    expect(simApiIdx).toBeGreaterThan(-1);
    expect(lineMap.toSource(simApiIdx + 1)).toBe(srcApiIdx + 1);

    // La línea de sim_bridge es generada (la agrega la app).
    const simSbIdx = simLines.findIndex((l) => l.startsWith('sim_bridge:'));
    expect(lineMap.isGenerated(simSbIdx + 1)).toBe(true);
    expect(lineMap.toSource(simSbIdx + 1)).toBeNull();
  });

  it('el mapa de líneas sigue el contenido de un bloque del usuario', () => {
    const { text, lineMap } = apply();
    const simLines = text.split('\n');
    const srcLines = USER_YAML.split('\n');
    const lambdaLine = simLines.findIndex((l) => l.includes('ESP_LOGD("x"'));
    const srcLambda = srcLines.findIndex((l) => l.includes('ESP_LOGD("x"'));
    expect(lineMap.toSource(lambdaLine + 1)).toBe(srcLambda + 1);
  });

  it('emite los canales RMT del usuario y los del puente', () => {
    const doc = parse(apply(USER_YAML).text) as Record<string, any>;
    expect(doc.sim_bridge.rf_tx_channel).toBe(0); // remote_transmitter del usuario
    expect(doc.sim_bridge.rf_rx_channel).toBe(4); // remote_receiver del usuario
    expect(doc.sim_bridge.bridge_rf_tx_channel).toBe(1);
    expect(doc.sim_bridge.bridge_rf_rx_channel).toBe(5);
  });

  it('respeta los pines de RF declarados por el usuario', () => {
    const doc = parse(apply(USER_YAML, { rfRxPin: 4, rfTxPin: 5 }).text) as Record<string, any>;
    expect(doc.sim_bridge.rf_rx_pin).toBe(4);
    expect(doc.sim_bridge.rf_tx_pin).toBe(5);
  });

  it('convierte binary_sensor gpio en template con lambda al puente', () => {
    const yaml = `esphome:
  name: p
esp32:
  board: esp32-s3-devkitc-1
binary_sensor:
  - platform: gpio
    id: boton
    name: Boton
    pin:
      number: GPIO6
      mode:
        input: true
        pullup: true
    filters:
      - delayed_on: 10ms
    on_press:
      - logger.log: "presionado"
`;
    const { text, warnings } = apply(yaml);
    const doc = parse(text) as Record<string, any>;
    const bs = doc.binary_sensor[0];
    expect(bs.platform).toBe('template');
    expect(bs.id).toBe('boton');
    expect(bs.name).toBe('Boton');
    expect(bs.pin).toBeUndefined();
    expect(bs.lambda).toContain(`id(${BRIDGE_ID})->input_state(6)`);
    // Con pull-up, "presionado" es nivel 0.
    expect(bs.lambda).toContain('== 0');
    expect(bs.update_interval).toBeUndefined();
    expect(bs.filters).toEqual([{ delayed_on: '10ms' }]);
    // La acción del usuario se conserva tal cual la escribió.
    expect(JSON.stringify(bs.on_press)).toContain('presionado');
    // El puente recibe el nivel de reposo: con pull-up, 1 (suelto).
    expect(doc.sim_bridge.inputs).toEqual([{ pin: 6, idle: 1 }]);
    expect(warnings.join(' ')).toContain('GPIO6');
  });

  it('sin pull-up, "presionado" es nivel 1', () => {
    const yaml = `esphome:
  name: p
esp32:
  board: esp32-s3-devkitc-1
binary_sensor:
  - platform: gpio
    id: b
    pin: GPIO9
`;
    const doc = parse(apply(yaml).text) as Record<string, any>;
    expect(doc.binary_sensor[0].lambda).toContain('== 1');
    expect(doc.sim_bridge.inputs).toEqual([{ pin: 9, idle: 0 }]);
  });

  it('no toca los binary_sensor de otras plataformas', () => {
    const yaml = `esphome:
  name: p
esp32:
  board: esp32-s3-devkitc-1
binary_sensor:
  - platform: dallas
    address: 0x1234567890abcdef
`;
    const doc = parse(apply(yaml).text) as Record<string, any>;
    expect(doc.binary_sensor[0].platform).toBe('dallas');
  });

  it('avisa y no transforma un pin que usa el puente', () => {
    const yaml = `esphome:
  name: p
esp32:
  board: esp32-s3-devkitc-1
binary_sensor:
  - platform: gpio
    id: b
    pin: GPIO18
`;
    const { text, warnings } = apply(yaml);
    const doc = parse(text) as Record<string, any>;
    expect(doc.binary_sensor[0].platform).toBe('gpio');
    expect(warnings.join(' ')).toContain('GPIO18');
  });
});

describe('rmtLoopbackPairs', () => {
  it('inyecta del puente al receptor del usuario y lee del transmisor', () => {
    expect(rmtLoopbackPairs()).toEqual(['1:4', '0:5']);
    expect(rmtLoopbackPairs(2, 6)).toEqual(['1:6', '2:5']);
  });
});

describe('buildSimYaml', () => {
  it('toma el wifi de project.json', () => {
    const project = {
      schemaVersion: 1 as const,
      name: 'p',
      board: 'esp32-s3-devkitc-1' as const,
      language: 'esphome' as const,
      modules: [],
      wires: [],
      sim: { wifiSsid: 'desde-proyecto', wifiPassword: 'clave' },
    };
    const doc = parse(buildSimYaml(project, USER_YAML).text) as Record<string, any>;
    expect(doc.wifi.ssid).toBe('desde-proyecto');
  });
});

describe('extractBuildErrors', () => {
  it('lee el formato [source archivo:línea] de ESPHome', () => {
    const lines = [
      'Failed config',
      '',
      'remote_transmitter: [source panel-alarma.yaml:86]',
      "  Invalid RCSwitch raw code character '4'.Only '0', '1' and 'x' are allowed.",
    ];
    const errs = extractBuildErrors(lines);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ file: 'panel-alarma.yaml', line: 86 });
    expect(errs[0]!.message).toContain("Invalid RCSwitch raw code character '4'");
  });

  it('lee errores de C++ dentro de lambdas', () => {
    const lines = ['/config/main.sim.yaml:41:22: error: expected \';\' before \'}\' token'];
    expect(extractBuildErrors(lines)[0]).toMatchObject({ line: 41 });
    expect(extractBuildErrors(lines)[0]!.message).toContain("expected ';'");
  });

  it('ignora las líneas de advertencia que no son error', () => {
    expect(extractBuildErrors(['[W][sim_bridge:12]: algo', 'INFO Compiling'])).toHaveLength(0);
  });
});

describe('LineMap', () => {
  it('devuelve null en líneas no registradas', () => {
    const m = new LineMap();
    m.add(3, 3);
    expect(m.toSource(3)).toBe(3);
    expect(m.toSource(4)).toBeNull();
    expect(m.isGenerated(4)).toBe(true);
  });
});
