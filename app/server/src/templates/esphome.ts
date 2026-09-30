// Plantilla de ESPHome: arranca y ya tiene el circuito de la Fase 0
// (botón GPIO6 -> LED GPIO7) para que se pueda probar sin cablear nada.
// La placa (`esp32.board`) y los pines salen del descriptor de la placa (module.json).
export function esphomeMainYamlPara(esphomeBoard: string, boton = 6, led = 7): string {
  return `esphome:
  name: \${name}
  friendly_name: \${name}

esp32:
  board: ${esphomeBoard}
  framework:
    type: esp-idf

logger:

# --- salida: LED en GPIO${led} (E3) --------------------------------------------
output:
  - platform: gpio
    id: led
    pin: GPIO${led}

# --- entrada: botón en GPIO${boton} (E2), con pull-up ----------------------------
binary_sensor:
  - platform: gpio
    id: boton
    name: Boton
    pin:
      number: GPIO${boton}
      mode:
        input: true
        pullup: true
    filters:
      - delayed_on: 0s
      - delayed_off: 0s
    on_press:
      - logger.log: "Boton presionado"
      - output.turn_on: led
    on_release:
      - logger.log: "Boton suelto"
      - output.turn_off: led
`;
}

/** La de siempre (ESP32-S3). */
export const esphomeMainYaml = esphomeMainYamlPara('esp32-s3-devkitc-1');
