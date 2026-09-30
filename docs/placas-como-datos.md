# Placas nuevas sin tocar el sistema

> Objetivo: si mañana sale una placa nueva, un dev (o un agente de IA a partir del
> esquemático y el datasheet) la describe en un archivo, la importa, y el sistema la
> acepta: la dibuja, la cablea, compila para ella y — si su chip se puede emular — la
> ejecuta. Sin editar código del servidor ni de la interfaz.

## La idea central: una placa es *datos*; un chip es *motor*

Una placa nueva casi nunca trae un chip nuevo. Trae un chip conocido (ESP32-S3,
RP2040, ATmega328P, STM32…) con otro cableado, otros pines expuestos, otro regulador.
Por eso el sistema separa tres capas:

| Capa | Qué es | Quién la agrega | ¿Código? |
|---|---|---|---|
| **Placa** | Dibujo, pines físicos → señales del MCU, voltaje lógico, pines reservados, qué lenguajes y con qué opciones, plantilla de ejemplo | Cualquiera, o un agente de IA | **No**: `module.json` + `module.svg` |
| **Toolchain** | Cómo se compila un lenguaje (ESPHome, ESP-IDF, arduino-cli, MicroPython, PlatformIO…) | El proyecto | Sí, un plugin, una vez por toolchain |
| **Motor de emulación** | Cómo se ejecuta una familia de CPU (esp-emu, avr8js, Renode…) | El proyecto | Sí, un plugin, una vez por familia |

Una placa con un chip que ya tiene motor y toolchain **funciona completa sin código**.
Un chip de una familia nueva necesita un plugin de motor; eso es inevitable (hay que
simular esa CPU), pero es trabajo por *familia*, no por placa.

## El descriptor de placa

La placa ya es un módulo programable del catálogo (tiene dibujo y pines), así que se
importa con el mismo importador de módulos (carpeta, zip, URL, GitHub, MCP). Solo
suma un bloque `board` en su `module.json`:

```jsonc
{
  "type": "mi-placa-s3",
  "name": "Mi placa S3",
  "programmable": true,
  "pins": [ { "name": "GPIO6", "x": 0, "y": 40, "kind": "digital-io" } /* … lo que se dibuja */ ],
  "board": {
    "chip": "esp32s3",
    "backend": { "engine": "esp-emu", "options": { "chip": "esp32s3" } },
    "logicVoltage": 3.3,          // la Ley de Ohm usa esto: un GPIO en alto = 3,3 V (5 V en un Uno)
    "maxPinCurrentMa": 40,
    "pins": {                     // nombre en el dibujo → señal del MCU y qué puede hacer
      "GPIO6": { "gpio": 6, "caps": ["digital-in", "digital-out", "adc", "pwm"] }
    },
    "reservedPins": { "17": "UART1 TX del puente de simulación" },
    "warningPins": { "0": "pin de arranque (strapping)" },
    "io": { "mode": "bridge-uart", "uart": 1, "tx": 17, "rx": 18 },
    "console": { "uart": 0 },
    "languages": {
      "esphome": { "toolchain": "esphome", "options": { "platform": "esp32", "board": "esp32-s3-devkitc-1" } },
      "arduino": { "toolchain": "arduino-cli", "options": { "fqbn": "esp32:esp32:esp32s3" } }
    },
    "templates": { "arduino": { "files": { "sketch.ino": "…" }, "diagram": { } } }
  }
}
```

Lo que el descriptor resuelve de lo que preguntabas:

- **Pines:** `board.pins` mapea cada pin del dibujo a su GPIO/puerto y a sus capacidades.
  El canvas bloquea `reservedPins` y avisa en `warningPins`, igual que hoy con el S3.
- **Programación:** `languages` dice qué lenguajes acepta y con qué opciones de toolchain
  (el FQBN de Arduino, el `board` de ESPHome, el target de ESP-IDF).
- **Entradas y salidas:** `io.mode` dice cómo la app lee y escribe pines durante la
  simulación: `native` si el motor deja tocar los pines directo (avr8js: inyección real),
  `bridge-uart` si hace falta el puente por UART (esp-emu no propaga entradas al pad).
- **Comportamiento eléctrico:** `logicVoltage` y `maxPinCurrentMa` alimentan el motor de
  Ley de Ohm (corriente por el LED, sobrecorriente por pin).

## Niveles de soporte (honestos, visibles en la UI)

Al importar una placa, el sistema la **certifica** automáticamente: compila su plantilla,
la ejecuta en el motor y verifica que el LED cambie cuando se aprieta el botón.

| Nivel | Qué significa | Cuándo pasa |
|---|---|---|
| **emula** | Se programa y se ejecuta de verdad | El chip tiene motor y la certificación pasó |
| **compila** | El firmware compila, pero no se puede ejecutar | Hay toolchain para el chip pero no motor |
| **solo dibujo** | Se cablea y entra en el esquemático final, sin firmware | No hay ni toolchain ni motor todavía |

Una placa "solo dibujo" sigue siendo útil: sirve para planificar el circuito y el
esquemático con todos los valores (ver `vision-y-alcance.md`).

## Motores genéricos: lo que abre "casi cualquier placa"

- **PlatformIO** como toolchain genérico: compila para ~1.500 placas de muchas familias
  con solo `board = <id>`. Con él, casi cualquier placa llega al nivel **compila** sin
  plugin propio.
- **Renode** (Antmicro, open source) como motor genérico: emula Cortex-M, RISC-V y otros
  a partir de archivos de descripción de plataforma (`.repl`), que son *datos*. Un chip
  nuevo de una familia que Renode ya soporta pasa a **emula** con un `.repl`, que un
  agente puede redactar a partir del archivo SVD del fabricante.
- Motores específicos cuando son mejores: **esp-emu** (Espressif: S3, C3, C5, C6, H2, P4),
  **avr8js** (AVR: Arduino Uno/Nano/Mega), y a futuro **rp2040js** (Raspberry Pi Pico).

## El agente de IA que crea placas

El servidor expone por MCP todo lo que un agente necesita para crear una placa solo:

1. `board_schema` — el JSON Schema del descriptor, con la documentación de cada campo.
2. El agente lee el esquemático (KiCad, PDF, imagen) y el datasheet, y escribe
   `module.json` + `module.svg`.
3. `validate_board` — chequea el descriptor: esquema, que cada pin de `board.pins` exista
   en el dibujo, que el motor y el toolchain existan, que los reservados sean válidos.
4. `import_module` — la importa al catálogo (mismo importador de módulos).
5. `certify_board` — compila y ejecuta la plantilla; devuelve el reporte y el nivel.
6. Si algo falla, el reporte dice qué y el agente corrige y repite desde el paso 3.

## Estado

- **Hecho:** motores esp-emu (S3, y C3/C6 en curso) y avr8js (Arduino Uno); plugins de
  toolchain para ESPHome, ESP-IDF, Arduino y MicroPython.
- **En curso:** pasar el registro de placas de código a datos (`board` en `module.json`),
  validación, certificación y herramientas MCP.
- **Siguiente:** toolchain PlatformIO y motor Renode; skill/agente "crear placa" que
  recorra los pasos de arriba; lectura directa de netlists de KiCad.
