// Plantillas de ESP-IDF (C y C++), Arduino y MicroPython (sección 8.6-8.8).
// Cada una trae el circuito mínimo de la Fase 0: botón -> LED. Las funciones `...Para`
// reciben los pines del circuito de prueba de la placa (`board.demo`); las constantes
// son las de siempre (GPIO6 -> GPIO7).

export function idfCMainCPara(b: number, l: number): string {
  return `// Plantilla ESP-IDF (C) para el emulador.
// GPIO${b} (botón, pull-up) -> GPIO${l} (LED).
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#if __has_include("sim_config.h")
#include "sim_config.h"
#endif

#define PIN_BOTON GPIO_NUM_${b}
#define PIN_LED GPIO_NUM_${l}

void app_main(void) {
  gpio_config_t in = {
      .pin_bit_mask = 1ULL << PIN_BOTON,
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
  };
  gpio_config_t out = {
      .pin_bit_mask = 1ULL << PIN_LED,
      .mode = GPIO_MODE_OUTPUT,
  };
  gpio_config(&in);
  gpio_config(&out);

  printf("Hola desde ESP-IDF (C). SSID simulado: %s\\n",
#if __has_include("sim_config.h")
         SIM_WIFI_SSID
#else
         "(sin sim_config.h)"
#endif
  );

  int ultimo = -1;
  while (1) {
    // Boton con pull-up: 0 = presionado.
    const int nivel = gpio_get_level(PIN_BOTON) == 0 ? 1 : 0;
    if (nivel != ultimo) {
      gpio_set_level(PIN_LED, nivel);
      printf("Boton %s -> LED %d\\n", nivel ? "PRESIONADO" : "suelto", nivel);
      fflush(stdout);
      ultimo = nivel;
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}
`;
}

export const idfCMainC = idfCMainCPara(6, 7);

export function idfCMainCppPara(b: number, l: number): string {
  return `// Plantilla ESP-IDF (C++) para el emulador.
// GPIO${b} (botón, pull-up) -> GPIO${l} (LED).
#include <cstdio>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#if __has_include("sim_config.h")
#include "sim_config.h"
#endif

static constexpr gpio_num_t PIN_BOTON = GPIO_NUM_${b};
static constexpr gpio_num_t PIN_LED = GPIO_NUM_${l};

extern "C" void app_main() {
  gpio_config_t in = {};
  in.pin_bit_mask = 1ULL << PIN_BOTON;
  in.mode = GPIO_MODE_INPUT;
  in.pull_up_en = GPIO_PULLUP_ENABLE;
  gpio_config_t out = {};
  out.pin_bit_mask = 1ULL << PIN_LED;
  out.mode = GPIO_MODE_OUTPUT;
  gpio_config(&in);
  gpio_config(&out);

  std::printf("Hola desde ESP-IDF (C++). SSID simulado: %s\\n",
#if __has_include("sim_config.h")
              SIM_WIFI_SSID
#else
              "(sin sim_config.h)"
#endif
  );

  int ultimo = -1;
  while (true) {
    // Boton con pull-up: 0 = presionado.
    const int nivel = gpio_get_level(PIN_BOTON) == 0 ? 1 : 0;
    if (nivel != ultimo) {
      gpio_set_level(PIN_LED, nivel);
      std::printf("Boton %s -> LED %d\\n", nivel ? "PRESIONADO" : "suelto", nivel);
      fflush(stdout);
      ultimo = nivel;
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}
`;
}

export const idfCMainCpp = idfCMainCppPara(6, 7);

export const idfCMakeLists = `idf_component_register(SRCS "main.c"
                                   INCLUDE_DIRS ".")
target_compile_options(\${COMPONENT_LIB} PRIVATE -Wall)
`;

export const idfCppCMakeLists = `idf_component_register(SRCS "main.cpp"
                                   INCLUDE_DIRS ".")
target_compile_options(\${COMPONENT_LIB} PRIVATE -Wall)
`;

export function arduinoSketchPara(b: number, l: number): string {
  return `// Plantilla Arduino (como componente de ESP-IDF) para el emulador.
// GPIO${b} (botón, pull-up) -> GPIO${l} (LED).
#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  pinMode(${b}, INPUT_PULLUP);
  pinMode(${l}, OUTPUT);
  digitalWrite(${l}, LOW);
  Serial.println("Hola desde Arduino");
}

void loop() {
  const int presionado = digitalRead(${b}) == LOW;
  digitalWrite(${l}, presionado);
  static int ultimo = -1;
  if (presionado != ultimo) {
    Serial.print("Boton ");
    Serial.print(presionado ? "PRESIONADO" : "suelto");
    Serial.print(" -> LED ");
    Serial.println(presionado);
    ultimo = presionado;
  }
  delay(50);
}
`;
}

export const arduinoSketch = arduinoSketchPara(6, 7);

export function micropythonMainPara(b: number, l: number): string {
  return `# Plantilla MicroPython para el emulador.
# GPIO${b} (botón) -> GPIO${l} (LED).
# El botón se lee con simbridge (lo sube la app solo, junto con boot.py) en vez de
# machine.Pin directo: así refleja lo que apretás en el circuito de la app. Un
# módulo de SALIDA (el LED) sí se puede manejar con machine.Pin normal.
import time
from machine import Pin
import simbridge

boton = simbridge.pin(${b})
led = Pin(${l}, Pin.OUT)

print("Hola desde MicroPython")

ultimo = None
while True:
    presionado = boton.value() == 0
    led.value(1 if presionado else 0)
    if presionado != ultimo:
        print("Boton", "PRESIONADO" if presionado else "suelto", "-> LED", 1 if presionado else 0)
        ultimo = presionado
    time.sleep_ms(50)
`;
}

export const micropythonMain = micropythonMainPara(6, 7);

/** sdkconfig.defaults del usuario de la plantilla IDF (se suma al .sim). */
export function idfSdkconfigDefaultsPara(target: string): string {
  return `CONFIG_IDF_TARGET="${target}"
CONFIG_ESP_CONSOLE_UART_DEFAULT=y
CONFIG_ESP_CONSOLE_UART_NUM=0
CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y
`;
}

/** Ajustes obligatorios de simulación para ESP-IDF/Arduino (8.6). */
export function idfSdkconfigDefaultsSimPara(target: string): string {
  return `CONFIG_IDF_TARGET="${target}"
CONFIG_ESP_CONSOLE_UART_DEFAULT=y
CONFIG_ESP_CONSOLE_UART_NUM=0
CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y
CONFIG_AUTOSTART_ARDUINO=y
CONFIG_ARDUINO_USB_CDC_ON_BOOT=0
CONFIG_ESP_TASK_WDT_EN=n
`;
}

export const idfSdkconfigDefaults = idfSdkconfigDefaultsPara('esp32s3');
export const idfSdkconfigDefaultsSim = idfSdkconfigDefaultsSimPara('esp32s3');

/**
 * Plantilla Arduino para placas AVR (Arduino Uno), compilada con arduino-cli.
 * Es un .cpp (no .ino): por eso lleva `#include <Arduino.h>` y las funciones se
 * declaran antes de usarse, igual que la plantilla de Arduino para ESP32.
 */
export function arduinoSketchAvr(placa: string, boton: { n: number; nombre: string }, led: { n: number; nombre: string }): string {
  return `// Plantilla Arduino para el ${placa}.
// ${boton.nombre} (botón a GND, con INPUT_PULLUP) -> ${led.nombre} (LED, con su resistencia).
#include <Arduino.h>

const int PIN_BOTON = ${boton.n};
const int PIN_LED = ${led.n};

void setup() {
  Serial.begin(9600);
  pinMode(PIN_BOTON, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
  Serial.println("Hola desde el ${placa}");
}

void loop() {
  const int presionado = digitalRead(PIN_BOTON) == LOW;
  digitalWrite(PIN_LED, presionado ? HIGH : LOW);
  static int ultimo = -1;
  if (presionado != ultimo) {
    Serial.print("Boton ");
    Serial.print(presionado ? "PRESIONADO" : "suelto");
    Serial.print(" -> LED ");
    Serial.println(presionado);
    ultimo = presionado;
  }
  delay(20);
}
`;
}

export const arduinoIdfComponentYml = `dependencies:
  idf: ">=5.5"
  espressif/arduino-esp32: "^3.3.0"
`;
