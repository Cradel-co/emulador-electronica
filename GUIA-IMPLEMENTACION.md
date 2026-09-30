# Guía de implementación — Emulador gráfico de electrónica (sobre esp-emu)

> Versión 1.1 — 2026-09-28. Guía para construir, de punta a punta, una app web **100% local** para dibujar una placa ESP32, conectarle módulos virtuales, escribir y ejecutar el código (ESPHome YAML, C/C++ o Python) e interactuar con los módulos mientras el firmware corre en el emulador `esp-emu`.
>
> Los datos marcados **[verificado]** se probaron en esta PC el 2026-09-28. Los marcados **[a validar]** son hipótesis que se confirman en la Fase 0, antes de escribir la app.

---

## Índice

1. [Objetivo y alcance de la v1](#1-objetivo-y-alcance-de-la-v1)
2. [Restricciones del emulador (leer antes de diseñar)](#2-restricciones-del-emulador-leer-antes-de-diseñar)
3. [Arquitectura](#3-arquitectura)
4. [Stack y dependencias](#4-stack-y-dependencias)
5. [Estructura de carpetas](#5-estructura-de-carpetas)
6. [Modelo de datos](#6-modelo-de-datos)
7. [El puente de simulación (firmware ⇄ app)](#7-el-puente-de-simulación-firmware--app)
8. [Pipeline de compilación y ejecución por lenguaje](#8-pipeline-de-compilación-y-ejecución-por-lenguaje)
9. [Gestor del emulador](#9-gestor-del-emulador)
10. [API del backend](#10-api-del-backend)
11. [Frontend](#11-frontend)
12. [Catálogo de módulos v1](#12-catálogo-de-módulos-v1)
13. [Seguridad](#13-seguridad)
14. [Pruebas y criterios de aceptación](#14-pruebas-y-criterios-de-aceptación)
15. [Fases de implementación](#15-fases-de-implementación)
16. [Riesgos y mitigaciones](#16-riesgos-y-mitigaciones)
17. [Comandos de referencia](#17-comandos-de-referencia)
18. [Checklist final](#18-checklist-final)

---

## 1. Objetivo y alcance de la v1

Una app que se abre en el navegador (`http://localhost:<puerto>`) y corre entera en la PC, sin servicios en la nube.

La v1 incluye cuatro partes:

| Parte | Qué hace el usuario |
|---|---|
| **Placa y módulos visuales** | Ve un ESP32-S3-DevKitC-1 dibujado, arrastra módulos desde una paleta y los cablea a pines. |
| **Editor de código** | Escribe el código en una sección de la interfaz y lo ejecuta con un botón "▶ Ejecutar". Tres lenguajes, elegidos al crear el proyecto (sección 8): **ESPHome YAML**, **C/C++** (ESP-IDF o Arduino) y **Python** (MicroPython). |
| **Panel de control** | Compila, arranca, detiene y resetea el emulador; ve el progreso y los logs en vivo. |
| **Módulos interactivos** | Mientras corre el firmware: aprieta botones virtuales, ve LEDs prenderse, abre/cierra un sensor de puerta, aprieta un control remoto RF, ve una sirena activarse. |

Todo el código corre **dentro del ESP32 emulado**, igual que en la placa real. (Correr Python o C en la PC para darle lógica propia a un módulo virtual es otra cosa; queda como extensión en 12.1.)

El dibujo y el código son independientes: **el código lo escribe el usuario** en el editor; el dibujo define qué módulo está en qué pin y la app los hace interactuar con el firmware. La app avisa si el código usa un pin que no coincide con el dibujo (sección 11.6).

Fuera de alcance de la v1 (anotado para después): módulos con lógica propia corriendo en la PC (12.1), generar código desde el dibujo, varios ESP32 en simultáneo conectados entre sí, chips distintos del S3, módulos I2C/SPI, grabar y reproducir sesiones.

---

## 2. Restricciones del emulador (leer antes de diseñar)

Todo el diseño sale de lo que `esp-emu` permite y lo que no.

### 2.1 Datos del emulador

| Tema | Dato |
|---|---|
| Versión | v0.44.0 instalada en `~/.local/bin/esp-emu` [verificado] |
| Licencia | Gratis, **no open source**: solo se publican binarios ([issue #10](https://github.com/espressif/esp-emulator/issues/10)). Si falla, no se puede parchear. |
| Chips | C3, C5, C6, H2, P4, S3. **No** el ESP32 clásico. La v1 solo soporta **S3**. |
| Consola | En S3 hay que usar `logger: hardware_uart: UART0`. Con USB-Serial-JTAG (el default de ESPHome en S3) se cuelga en el bootloader [verificado]. |
| Arranque | Del reset a `setup() finished successfully!` en segundos [verificado]. |
| CPU | Cerca de 0,7 núcleos por instancia en ejecución [verificado]. |
| Firmware | Recibe un binario de flash mergeado: `firmware.factory.bin`, que ESPHome genera solo [verificado]. |

### 2.2 Canales para hablar con el firmware en ejecución

| Canal | Flag | Uso en la app |
|---|---|---|
| UART0 (consola) | salida por stdout; stdin se reenvía a UART0 RX | Logs en vivo |
| UART1 por TCP | `--uart1-tcp 127.0.0.1:PUERTO` | **Puente de simulación** (sección 7). Un solo cliente a la vez. Sin cliente, lo que el firmware manda se descarta. |
| Canal de control | `--control-tcp 127.0.0.1:PUERTO` | `reset`, `reset --soft`, `erase-flash`, `erase-region`, `write-region`, `ping` |
| Red | `--net "user,hostfwd=tcp::HOST-:GUEST,…"` | Exponer la API de ESPHome (6053) y el `web_server` (80) en puertos de la PC [verificado] |
| WiFi | `--wifi-ssid` / `--wifi-password` | Deben coincidir con los del firmware [verificado] |
| Loopback RMT | `--rmt-loopback TX_CH:RX_CH` | Conectar un canal transmisor RMT con uno receptor dentro del chip [a validar con ESPHome] |
| GDB | `--gdb PUERTO` | Depuración (fuera de alcance v1) |

### 2.3 Lo que NO se puede

- **No se pueden manejar pines GPIO desde afuera.** No existe un flag para que un programa externo ponga un pin en alto o lea su estado ([issue #5](https://github.com/espressif/esp-emulator/issues/5), abierto). Por eso los módulos de pines necesitan el **puente de simulación** de la sección 7: un componente que va dentro del firmware simulado y reporta/inyecta los estados por UART1.
- **No hay interfaz gráfica**: la app la aporta toda.
- **Modo TAP** (IP real en la LAN) requiere root: la v1 usa solo `--net user`.
- **UART1 queda ocupado por el puente**, así que los módulos serie (GPS, módem) no se pueden conectar de forma nativa en la v1.

### 2.4 Datos del entorno de esta PC

- Linux, Node 22.22.1, npm 9.2, Docker 29.1.3, Python 3.14 sin `pip` [verificado].
- **El puerto 8080 está ocupado** por otra app ("Vault") [verificado]. La app nunca usa puertos fijos: los asigna comprobando que estén libres (9.3).
- ESPHome corre en Docker (`ghcr.io/esphome/esphome`, 2026.9.0) [verificado]. Sin `-u`, los archivos generados quedan de root (8.4).

---

## 3. Arquitectura

```
┌────────────────────────── Navegador ──────────────────────────┐
│  Placa SVG + módulos │ Editor YAML │ Consola │ Controles      │
└──────────────┬───────────────────────────────┬────────────────┘
               │ HTTP (REST)                   │ WebSocket (eventos)
┌──────────────┴───────────────────────────────┴────────────────┐
│                 Backend Node (127.0.0.1 solamente)             │
│  ProjectStore │ BuildService │ EmulatorManager │ BridgeClient │
└──────┬──────────────┬───────────────┬───────────────┬─────────┘
       │ archivos     │ docker run    │ spawn         │ TCP
       ▼              ▼               ▼               ▼
  projects/*/    ESPHome (Docker)   esp-emu ──── UART1 TCP ── puente
                  → firmware.       stdout = UART0 (logs)
                    factory.bin     control TCP (reset)
                                    hostfwd: 6053 (API), 80 (web)
```

Flujo de "▶ Ejecutar":

1. El frontend guarda el YAML y el dibujo (`PUT`).
2. `BuildService` genera el YAML de simulación (código del usuario + puente + ajustes obligatorios) y compila con Docker. El progreso sale por WebSocket.
3. `EmulatorManager` detiene la instancia anterior si hay una, reserva puertos y lanza `esp-emu`.
4. `BridgeClient` se conecta a UART1 por TCP, hace el saludo del puente y envía el mapa de pines del dibujo.
5. El frontend anima los módulos con los eventos que llegan y manda las acciones del usuario (apretar un botón) por el mismo WebSocket.

---

## 4. Stack y dependencias

Todo se instala con npm y se sirve desde la PC; **nada se carga por CDN**.

| Capa | Elección | Motivo |
|---|---|---|
| Lenguaje | TypeScript en backend y frontend | Tipos compartidos para el protocolo |
| Backend | Node 22 + [Fastify](https://fastify.dev) + `@fastify/websocket` + `@fastify/static` | Liviano, WebSocket integrado |
| YAML | [`yaml`](https://eemeli.org/yaml/) (paquete npm) | Conserva tags propios de ESPHome (`!secret`, `!lambda`, `!include`) y comentarios |
| Validación | [`zod`](https://zod.dev) | Esquemas de `project.json`, módulos y mensajes |
| Frontend | [Vite](https://vite.dev) + TypeScript, sin framework (o [Svelte](https://svelte.dev) si se prefiere) | La placa es SVG a mano; un framework pesado no aporta |
| Editor de código | [CodeMirror 6](https://codemirror.net) + `@codemirror/lang-yaml`, `@codemirror/lang-cpp`, `@codemirror/lang-python` | Liviano, un modo por lenguaje, marcas de error por línea |
| Consola | [xterm.js](https://xtermjs.org) | Interpreta los colores ANSI que manda ESPHome |
| Pruebas | [Vitest](https://vitest.dev) (unitarias) + [Playwright](https://playwright.dev) (de punta a punta) | |

Requisitos externos, ya instalados: Docker, `esp-emu`.

Imágenes Docker y firmwares por lenguaje (se bajan la primera vez que se usa cada lenguaje):

| Lenguaje | Toolchain | Tamaño aproximado |
|---|---|---|
| ESPHome YAML | `ghcr.io/esphome/esphome:2026.9.0` [ya descargada] | ~1 GB + ESP-IDF en caché |
| C/C++ ESP-IDF | `espressif/idf:v5.5.5` [tag verificado en Docker Hub] | ~3 GB |
| C++ Arduino | `espressif/idf:v5.5.5` + componente `arduino-esp32` (8.7) | lo mismo + ~200 MB |
| MicroPython | Firmware oficial `ESP32_GENERIC_S3-20260824-v1.29.0.bin` de [micropython.org](https://micropython.org/download/ESP32_GENERIC_S3/) [verificado] | 1,7 MB |

---

## 5. Estructura de carpetas

```
emulador-electronica/
├── GUIA-IMPLEMENTACION.md          ← este documento
├── app/
│   ├── package.json                ← workspaces: server, web, shared
│   ├── shared/src/
│   │   ├── protocol.ts             ← mensajes del puente y del WebSocket (zod)
│   │   ├── project.ts              ← esquema de project.json
│   │   └── module.ts               ← esquema de definición de módulo
│   ├── server/src/
│   │   ├── index.ts                ← arranque de Fastify, rutas, WebSocket
│   │   ├── projectStore.ts
│   │   ├── buildService.ts         ← YAML de simulación + docker
│   │   ├── emulatorManager.ts      ← spawn/stop/reset de esp-emu, puertos
│   │   ├── bridgeClient.ts         ← TCP a UART1, parser del protocolo
│   │   ├── logParser.ts            ← líneas de UART0 → eventos
│   │   └── ports.ts                ← reserva de puertos libres
│   ├── web/src/
│   │   ├── main.ts
│   │   ├── board/                  ← SVG de la placa, pines, cables
│   │   ├── modules/                ← render + interacción de cada módulo
│   │   ├── editor.ts               ← CodeMirror
│   │   ├── console.ts              ← xterm.js
│   │   └── api.ts                  ← REST + WebSocket
│   └── tests/
├── boards/
│   └── esp32-s3-devkitc-1.json     ← pines, coordenadas, restricciones
├── modules/                        ← una definición JSON + SVG por módulo
│   ├── button/  led/  rxb6/  stx882/  remote-433/  siren-433/  door-sensor-433/
├── firmware/
│   ├── bridge-core/                ← núcleo del puente en C, compartido (7.4)
│   │   ├── sim_bridge_core.h
│   │   └── sim_bridge_core.c
│   ├── components/sim_bridge/      ← envoltorio ESPHome (external component)
│   │   ├── __init__.py
│   │   ├── sim_bridge.h
│   │   └── sim_bridge.cpp
│   ├── idf-components/sim_bridge/  ← envoltorio ESP-IDF (C/C++ y Arduino)
│   │   ├── CMakeLists.txt
│   │   ├── idf_component.yml
│   │   └── include/sim_bridge.h
│   └── micropython/
│       ├── simbridge.py            ← puente en Python
│       └── ESP32_GENERIC_S3-…bin   ← firmware oficial (descargado, gitignored)
├── templates/                      ← proyecto inicial de cada lenguaje (ya bootea)
│   ├── esphome/  idf-c/  idf-cpp/  arduino/  micropython/
├── projects/                       ← un proyecto por carpeta (ya existe)
│   └── <nombre>/
│       ├── project.json            ← dibujo, lenguaje, ajustes
│       ├── main.yaml               ← ESPHome
│       ├── main/main.c | main.cpp  ← ESP-IDF (+ CMakeLists.txt, sdkconfig.defaults)
│       ├── src/sketch.cpp          ← Arduino
│       ├── main.py                 ← MicroPython (+ otros .py del usuario)
│       └── secrets.yaml            ← opcional (ESPHome)
├── .cache/esphome/                 ← caché compartida de ESPHome/ESP-IDF (gitignored)
└── .build/<nombre>/                ← YAML de simulación y binarios (gitignored)
```

La carpeta actual `projects/_template/` y los archivos de Wokwi (`diagram.json`, `wokwi.toml`) quedan como están; la app usa `project.json` y `main.yaml`.

---

## 6. Modelo de datos

### 6.1 `project.json`

```json
{
  "schemaVersion": 1,
  "name": "alarma-demo",
  "board": "esp32-s3-devkitc-1",
  "language": "esphome",
  "modules": [
    { "id": "btn1",  "type": "button",   "x": 420, "y": 120, "props": { "label": "Armar" } },
    { "id": "led1",  "type": "led",      "x": 420, "y": 220, "props": { "color": "red" } },
    { "id": "rx1",   "type": "rxb6",     "x": 60,  "y": 300 },
    { "id": "door1", "type": "door-sensor-433", "x": 60, "y": 420,
      "props": { "code": "101100111000101001011010", "protocol": 1 } }
  ],
  "wires": [
    { "from": "btn1.OUT", "to": "board.GPIO6" },
    { "from": "led1.IN",  "to": "board.GPIO7" },
    { "from": "rx1.DATA", "to": "board.GPIO4" },
    { "from": "rx1.VCC",  "to": "board.5V" },
    { "from": "rx1.GND",  "to": "board.GND" }
  ],
  "sim": { "wifiSsid": "sim-wifi", "wifiPassword": "sim-password" }
}
```

- Los módulos "de aire" (control remoto, sensor de puerta, sirena) no se cablean: se comunican por radio con el receptor/transmisor del proyecto.
- `sim.wifiSsid`/`wifiPassword` se inyectan en la simulación; el código del usuario no necesita saberlos (8.2). En C/C++ y MicroPython se exponen como constantes/variables (8.6–8.8).
- `language`: `esphome` | `idf-c` | `idf-cpp` | `arduino` | `micropython`. Se elige al crear el proyecto y no cambia (cambiar de lenguaje = proyecto nuevo, se puede copiar el dibujo).

### 6.2 Definición de módulo (`modules/<tipo>/module.json`)

```json
{
  "type": "button",
  "name": "Pulsador",
  "category": "entrada",
  "svg": "button.svg",
  "pins": [
    { "name": "OUT", "x": 10, "y": 40, "kind": "digital-out" },
    { "name": "GND", "x": 30, "y": 40, "kind": "ground" }
  ],
  "bridge": { "role": "input", "pin": "OUT", "activeLevel": 0, "pull": "up" },
  "controls": [ { "kind": "momentary", "label": "Apretar" } ],
  "props": { "label": { "type": "string", "default": "Botón" } }
}
```

`bridge.role` define cómo interactúa con el puente:

| role | Significado |
|---|---|
| `input` | El módulo pone un nivel en un pin del ESP32 (botón, interruptor) |
| `output` | El módulo muestra el nivel de un pin del ESP32 (LED, relé, buzzer) |
| `rf-rx` | Receptor 433 MHz en un pin: recibe códigos de los módulos de aire |
| `rf-tx` | Transmisor 433 MHz en un pin: lo que el firmware transmite llega a los módulos de aire |
| `air` | Módulo sin cables: emite o recibe códigos RF (control, sensor, sirena) |

### 6.3 Placa (`boards/esp32-s3-devkitc-1.json`)

Lista de pines con coordenadas del SVG y restricciones. Pinout de la ESP32-S3-DevKitC-1 (dos tiras de 22 pines). **Verificar contra la [guía oficial de Espressif](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide.html) antes de cargarlo**:

| Tira J1 | Tira J3 |
|---|---|
| 3V3, 3V3, RST, GPIO4, GPIO5, GPIO6, GPIO7, GPIO15, GPIO16, GPIO17, GPIO18, GPIO8, GPIO3, GPIO46, GPIO9, GPIO10, GPIO11, GPIO12, GPIO13, GPIO14, 5V, GND | GND, TX (GPIO43), RX (GPIO44), GPIO1, GPIO2, GPIO42, GPIO41, GPIO40, GPIO39, GPIO38, GPIO37, GPIO36, GPIO35, GPIO0, GPIO45, GPIO48, GPIO47, GPIO21, GPIO20, GPIO19, GND, GND |

Restricciones que la app debe marcar:

| Pines | Estado | Motivo |
|---|---|---|
| 43, 44 | bloqueados | UART0: consola obligatoria en simulación |
| Los dos pines que use el puente para UART1 (8.2) | bloqueados | Puente de simulación |
| 0, 3, 45, 46 | advertencia | Pines de arranque (strapping) |
| 26–32 | no expuestos | Flash interna |
| 35, 36, 37 | advertencia | Ocupados en módulos con PSRAM octal (N8R8, N16R8) |
| 19, 20 | advertencia | USB nativo |
| 48 | advertencia | LED RGB integrado en algunas revisiones |

---

## 7. El puente de simulación (firmware ⇄ app)

Como no se pueden manejar pines desde afuera (2.3), el firmware de simulación lleva un componente ESPHome, `sim_bridge`, que habla con la app por UART1. **Solo se agrega en la simulación**: el YAML que el usuario flashea en la placa real no lo incluye.

### 7.1 Protocolo (texto, una línea por mensaje)

- Codificación ASCII, líneas terminadas en `\n`, máximo 256 bytes.
- Formato: `@<TIPO> <campos separados por espacio>`.
- Velocidad UART1: 115200 baudios (en el emulador no afecta la velocidad real, pero debe coincidir en ambos lados).

**App → firmware**

| Mensaje | Significado |
|---|---|
| `@HELLO 1` | Saludo con versión de protocolo |
| `@WATCH <pin>` | Reportar cambios de nivel de salida de este pin |
| `@IN <pin> <0\|1>` | Poner este nivel en un pin de entrada |
| `@RF <bits> <protocolo>` | Llega por radio este código al receptor |
| `@PING <n>` | Chequeo de vida |

**Firmware → app**

| Mensaje | Significado |
|---|---|
| `@READY 1 <versión-esphome>` | Puente listo; se manda al arrancar y en respuesta a `@HELLO` |
| `@OUT <pin> <0\|1>` | Cambió el nivel de salida de un pin vigilado |
| `@TX <bits> <protocolo>` | El firmware transmitió este código RF |
| `@PONG <n>` | Respuesta a `@PING` |
| `@ERR <código> <texto>` | Error del puente (pin inválido, mensaje mal formado) |

Reglas:
- La app espera `@READY` antes de mandar nada. Si el emulador se resetea, llega otro `@READY` y la app reenvía todos los `@WATCH` y el estado actual de las entradas.
- Si no hay respuesta a `@PING` en 5 s, la app marca el puente como caído.
- Mensajes desconocidos se ignoran (compatibilidad futura).

### 7.2 Estrategias por tipo de módulo

Cada estrategia tiene un plan principal y uno alternativo. **La Fase 0 decide cuál se usa.**

| Tipo | Plan principal | Plan alternativo |
|---|---|---|
| **Salidas** (LED, relé) | `sim_bridge` lee los registros de salida GPIO (`GPIO_OUT_REG`, `GPIO_OUT1_REG`) en cada `loop()` y manda `@OUT` cuando cambian. No toca el código del usuario. | Transformar el YAML: `output`/`switch` con `platform: gpio` pasa a `platform: template` con una acción que manda `@OUT`. |
| **Entradas** (botón) | `sim_bridge` pone el pin en modo entrada-salida (`GPIO_MODE_INPUT_OUTPUT`) y fija el nivel con `gpio_set_level`: en el silicio real, la lectura de entrada devuelve el nivel de salida. | Transformar el YAML: `binary_sensor` con `platform: gpio` pasa a `platform: template` y `sim_bridge` le publica el estado por `id`. |
| **RF recepción** (RXB6) | `sim_bridge` usa un canal RMT transmisor libre para generar la forma de onda EV1527/RCSwitch del código recibido; `--rmt-loopback` la mete en el canal receptor que usa `remote_receiver`. El firmware la decodifica igual que en la placa real. | Transformar el YAML: cada `binary_sensor` con `platform: remote_receiver` pasa a `template`; `sim_bridge` compara `@RF` con su patrón (`x` = comodín) y lo pulsa (ON 200 ms → OFF). |
| **RF transmisión** (STX882) | `--rmt-loopback` desde el canal TX del `remote_transmitter` del usuario hacia un canal RX libre que escucha `sim_bridge`; decodifica con RCSwitch y manda `@TX`. | Transformar el YAML: cada acción `remote_transmitter.transmit_rc_switch_raw` se reemplaza por `uart.write` de `@TX <code> <protocolo>`. |

Criterio de elección: si los experimentos E1–E4 de la Fase 0 dan bien, se usa el plan principal (más fiel: el código del usuario corre sin cambios). Si uno falla, ese tipo usa el alternativo. Se pueden mezclar.

### 7.3 Componente `sim_bridge` (ESPHome external component)

Archivos en `firmware/components/sim_bridge/`:

- `__init__.py`: esquema de configuración. Depende de `uart`. Opciones: `uart_id`, `rf_tx_channel` y `rf_rx_channel` (si se usa el plan principal de RF), `poll_interval` (por defecto 10 ms).
- `sim_bridge.h/.cpp`: clase `SimBridge : public Component, public uart::UARTDevice`.
  - `setup()`: manda `@READY`.
  - `loop()`: lee bytes de UART1 y arma líneas; procesa mensajes; cada `poll_interval` compara los registros de salida de los pines vigilados y manda `@OUT` por los que cambiaron.
  - Procesa `@IN` (según la estrategia elegida), `@RF` (genera la onda o publica al sensor), `@PING`.
  - Nunca bloquea: nada de `delay()`; usar timers de ESPHome (`set_timeout`).
  - Loguea sus mensajes con el tag `sim_bridge` en nivel `VERBOSE` para no ensuciar la consola.

Referencias para escribirlo: [External Components](https://esphome.io/components/external_components/), [UART Bus](https://esphome.io/components/uart/), código de `remote_base/rc_switch_protocol.cpp` de ESPHome (tiempos de los protocolos RCSwitch).

Formas de onda RCSwitch protocolo 1 (la que usan EV1527/PT2262), con pulso base de 350 µs:
- bit 0: 1 alto + 3 bajos; bit 1: 3 altos + 1 bajo; sincronía: 1 alto + 31 bajos.
- Repetir el código 5 veces, igual que un control real.

### 7.4 El puente en cada lenguaje

El protocolo (7.1) es el mismo para todos. Para no escribir la lógica tres veces, hay un **núcleo en C** (`firmware/bridge-core/`) con el parser de líneas, la lectura de registros de salida y la generación de ondas RF; ESPHome y ESP-IDF/Arduino lo envuelven. MicroPython tiene su propia versión en Python.

| Lenguaje | Cómo se agrega | Qué escribe el usuario | Cómo se "ve" una entrada | Cómo se reportan salidas |
|---|---|---|---|---|
| ESPHome | La app lo inyecta en `main.sim.yaml` (8.2) | Nada | Estrategia de 7.2 | Automático (registros) |
| C/C++ ESP-IDF | Componente `sim_bridge` agregado por la app a `EXTRA_COMPONENT_DIRS` solo en la simulación; arranca solo con un constructor (`__attribute__((constructor))` + tarea FreeRTOS) | Nada; opcionalmente `#include "sim_bridge.h"` para usar la API RF | Estrategia de 7.2 (E2); si falla, `sim_gpio_get_level(pin)` como reemplazo de `gpio_get_level` | Automático (registros) |
| C++ Arduino | Igual que ESP-IDF (Arduino corre como componente de ESP-IDF, 8.7) | Nada | Igual que ESP-IDF; alternativa `simDigitalRead(pin)` | Automático (registros) |
| MicroPython | La app sube `simbridge.py` y un `boot.py` que lo arranca en un hilo (`_thread`) antes de `main.py` | Nada | Estrategia E2 con `machine.Pin`; si falla, `simbridge.pin(n).value()` como reemplazo | Lectura de `machine.mem32[GPIO_OUT_REG]` en el hilo |

API opcional del puente para C/C++ (`sim_bridge.h`), para quien quiera simular RF sin `remote_transmitter`:

```c
void sim_rf_send(const char *bits, int protocol);                 // el firmware "transmite"
void sim_rf_on_receive(void (*cb)(const char *bits, int protocol)); // el firmware "recibe"
int  sim_gpio_get_level(int pin);                                 // solo si falla E2
```

Equivalentes en MicroPython: `simbridge.rf_send(bits, proto)`, `simbridge.on_rf(callback)`, `simbridge.pin(n)`.

Si el usuario flashea este mismo código en la placa real: en C/C++ las funciones `sim_*` existen como stubs vacíos en un header de producción (`sim_bridge_stub.h`); en MicroPython `simbridge` es opcional (el código debe hacer `try: import simbridge`).

---

## 8. Pipeline de compilación y ejecución por lenguaje

`BuildService` tiene una implementación por lenguaje con la misma interfaz: `build(proyecto) → { ok, firmware, elf?, errors }` y `run(proyecto)`. 8.1–8.5 describen ESPHome; 8.6–8.8, los otros lenguajes. Regla común a todos: **la consola tiene que ir por UART0** (2.1).

### 8.1 ESPHome: pasos de `build(proyecto)`

1. Leer `main.yaml` con el paquete `yaml` usando `parseDocument` y tags propios que conserven `!secret`, `!lambda`, `!include`, `!extend`, `!remove` sin interpretarlos.
2. Validar lo mínimo: que exista `esphome:` y `esp32:` con una placa S3. Si no, error claro antes de llamar a Docker.
3. Aplicar los **ajustes obligatorios de simulación** (8.2).
4. Si hay módulos con estrategia alternativa, aplicar las transformaciones de 7.2.
5. Escribir el resultado en `.build/<proyecto>/main.sim.yaml`; copiar `secrets.yaml` si existe.
6. Compilar con Docker (8.3) y transmitir cada línea por WebSocket.
7. Si el código de salida es 0, verificar que existan `firmware.factory.bin` y `firmware.elf`.
8. Si falla, extraer errores (8.5).

### 8.2 Ajustes obligatorios que agrega la app

| Clave | Valor | Motivo |
|---|---|---|
| `logger.hardware_uart` | `UART0` | Sin esto el emulador se cuelga (2.1). Si el usuario puso otra cosa, se reemplaza y se avisa en la consola. |
| `wifi.ssid` / `wifi.password` | los de `project.json → sim` | Tienen que coincidir con el access point del emulador |
| `wifi.networks` | se elimina si existe | Evita que prefiera otra red |
| `external_components` | se agrega `firmware/components` como fuente local | El puente |
| `uart` | un bus nuevo `id: sim_bridge_uart`, UART1, 115200 baudios, en dos pines libres fijos (por ejemplo GPIO17/18) | El puente; esos pines se bloquean en la placa |
| `sim_bridge` | con los canales RMT que correspondan | El puente |
| `web_server.local` | `true` si el usuario usa `web_server` | Que no baje nada de internet |
| `api.encryption` | se mantiene | Ya probado que funciona con el emulador |

Si una clave ya existe como lista (por ejemplo `external_components` o `uart`), se agrega un elemento; no se pisa lo del usuario.

### 8.3 Comando Docker

```bash
docker run --rm \
  -u "$(id -u):$(id -g)" \
  -v "<ruta>/.build/<proyecto>":/config \
  -v "<ruta>/firmware/components":/components:ro \
  -v "<ruta>/.cache/esphome":/cache \
  ghcr.io/esphome/esphome:2026.9.0 compile main.sim.yaml
```

- `-u`: los archivos quedan del usuario, no de root.
- `/cache` compartido: el framework ESP-IDF (varios cientos de MB) se descarga una sola vez para todos los proyectos. La primera compilación tarda cerca de 10 minutos; las siguientes, 2 a 4 [verificado sin caché compartida].
- Fijar la versión de la imagen (`2026.9.0`) y actualizarla a propósito, no con `latest`.
- La ruta de los componentes dentro del contenedor (`/components`) es la que se escribe en `external_components` del YAML de simulación.

Salida: `.build/<proyecto>/.esphome/build/<nombre>/build/firmware.factory.bin` y `firmware.elf` [verificado].

### 8.4 Detalles

- Una sola compilación a la vez por proyecto; si llega otra, se cancela la anterior (`docker kill` del contenedor, nombrado `emu-build-<proyecto>`).
- Timeout: 20 minutos la primera vez, 10 las siguientes.
- Si una carpeta `.esphome` quedó de root por compilaciones viejas: `docker run --rm -v "$PWD":/config alpine rm -rf /config/.esphome`.

### 8.5 Errores al editor

ESPHome reporta errores de configuración así [verificado]:

```
script: [source panel-alarma.yaml:86]
  ...
  Invalid RCSwitch raw code character '4'.Only '0', '1' and 'x' are allowed.
```

- Parsear `[source <archivo>:<línea>]` y el mensaje siguiente.
- Como la app modifica el YAML, mantener un **mapa de líneas** de `main.sim.yaml` a `main.yaml` para mostrar la marca en la línea correcta del editor. Las líneas agregadas por la app se marcan como "generadas".
- Errores de compilación C++ (en lambdas): parsear `error:` con archivo y línea; mostrarlos en la consola y, si se puede ubicar la lambda, en el editor.

### 8.6 C/C++ con ESP-IDF

Proyecto ESP-IDF estándar: el usuario edita `main/main.c` (o `main.cpp`) y puede agregar archivos en `main/`. La plantilla trae un `app_main` que ya bootea en el emulador.

**Ajustes obligatorios** (la app los escribe en `.build/<proyecto>/sdkconfig.defaults.sim`, que se suma a los `sdkconfig.defaults` del usuario):

```
CONFIG_IDF_TARGET="esp32s3"
CONFIG_ESP_CONSOLE_UART_DEFAULT=y
CONFIG_ESP_CONSOLE_UART_NUM=0
CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y
```

El default de ESP-IDF en S3 ya es consola por UART0 (lo confirma el `sdkconfig` que generó ESPHome [verificado]), pero se fuerza por si el usuario lo cambió.

**WiFi**: la app genera `sim_config.h` con `#define SIM_WIFI_SSID "…"` y `SIM_WIFI_PASSWORD`; la plantilla lo incluye con `#if __has_include("sim_config.h")`.

**Compilación**:

```bash
docker run --rm -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "<ruta>/projects/<proyecto>":/project \
  -v "<ruta>/.build/<proyecto>":/build \
  -v "<ruta>/firmware":/firmware:ro \
  -w /project espressif/idf:v5.5.5 \
  idf.py -B /build \
    -D SDKCONFIG=/build/sdkconfig \
    -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;/build/sdkconfig.defaults.sim" \
    -D EXTRA_COMPONENT_DIRS=/firmware/idf-components \
    set-target esp32s3 build merge-bin -o /build/merged_flash.bin
```

- `-B /build`: la compilación queda fuera de la carpeta del proyecto.
- `EXTRA_COMPONENT_DIRS` solo en la simulación: así el puente no aparece al compilar para la placa real.
- Salidas para el emulador: `/build/merged_flash.bin` (`--firmware`) y `/build/<nombre>.elf` (`--elf`).
- La primera vez tarda por la imagen (~3 GB); las compilaciones siguientes, un par de minutos. Compilaciones incrementales: no borrar `/build` entre ejecuciones.
- Errores: formato GCC `archivo:línea:columna: error: mensaje`. Mapear la ruta `/project/main/...` al archivo del editor.

**[a validar en E7]**: que un `hello_world` de ESP-IDF 5.5.5 compilado así bootee en `esp-emu`. Muy probable: el firmware de ESPHome es una app ESP-IDF 5.5.5 y bootea [verificado].

### 8.7 C++ con Arduino

Arduino para ESP32 se usa **como componente de ESP-IDF** ([arduino-esp32 como componente](https://docs.espressif.com/projects/arduino-esp32/en/latest/esp-idf_component.html)). Así se reutiliza todo 8.6: misma imagen, mismo puente, mismo `merge-bin`.

- La plantilla es un proyecto ESP-IDF con `main/idf_component.yml` que pide `espressif/arduino-esp32` (versión compatible con ESP-IDF 5.5.x; confirmarla en su registro de componentes) y `CONFIG_AUTOSTART_ARDUINO=y`.
- El editor muestra un solo archivo, `sketch.cpp`, con `setup()` y `loop()`; la app lo copia a `main/` antes de compilar.
- Consola: `Serial` sale por UART0 si `ARDUINO_USB_CDC_ON_BOOT` está en 0 (default en la DevKitC-1). Forzarlo en `sdkconfig.defaults.sim`.
- La primera compilación descarga el componente Arduino (necesita internet esa única vez; después queda en caché en `/build/managed_components`).

**[a validar en E8]**: que un sketch con `Serial.println` bootee y se vea en la consola.

Alternativa si E8 falla: [PlatformIO](https://docs.platformio.org) en Docker con `platform = espressif32`, `framework = arduino`, `board = esp32-s3-devkitc-1`, y `esptool.py merge_bin` con los offsets de su salida.

### 8.8 Python con MicroPython

Acá **no se compila**: el firmware de MicroPython ya está hecho y el código del usuario se le carga en caliente.

[verificado] El firmware oficial `ESP32_GENERIC_S3-20260824-v1.29.0.bin` bootea en `esp-emu` sin ningún ajuste, con la REPL (la consola interactiva de Python) por UART0. Se le mandó `print("hola desde micropython", 6*7)` por la entrada estándar del emulador y respondió `hola desde micropython 42`.

El binario oficial empieza en el offset 0 de la flash, así que va directo a `--firmware`. No hay ELF.

**Ejecutar código** (`run(proyecto)`):

1. Si el emulador no está corriendo con MicroPython, arrancarlo (una sola vez; queda vivo entre ejecuciones).
2. Esperar el prompt `>>> `.
3. Entrar al **modo REPL crudo** (raw REPL) con `Ctrl-A` (`\x01`): permite mandar código de varias líneas sin eco. Esperar `raw REPL; CTRL-B to exit\r\n>`.
4. Para ejecutar sin guardar: mandar el código y `Ctrl-D` (`\x04`). La respuesta es `OK`, la salida, `\x04`, los errores, `\x04>`.
5. Para guardar archivos en la flash del ESP32 (como `mpremote cp`): mandar, por el mismo modo, código que abre el archivo y escribe el contenido en bloques (por ejemplo de 256 bytes, codificados en base64 para evitar problemas con caracteres especiales).
6. Botón "Ejecutar": guarda `simbridge.py`, `boot.py` (que arranca el puente), `wifi_sim.py` (SSID/clave de la simulación) y los `.py` del usuario; luego hace `Ctrl-D` fuera del modo crudo (soft reset), que vuelve a correr `boot.py` y `main.py`.
7. Botón "Parar": `Ctrl-C` (`\x03`) interrumpe el programa y deja la REPL libre.

El protocolo del modo crudo es el mismo que usa [`mpremote`](https://docs.micropython.org/en/latest/reference/mpremote.html); leer su código (`pyboard.py`) es la referencia de implementación.

**Canal**: la app habla con la REPL por la entrada estándar del emulador (probado) o por `--uart-tcp 127.0.0.1:<p>` (mejor para una app: canal bidireccional aparte; [a validar] que la salida de la REPL también llegue por ese TCP). Todo lo que la REPL imprime se muestra en la consola de la app.

**Errores**: los tracebacks traen `File "main.py", line N` → marca en el editor.

**Consola interactiva**: con MicroPython, la pestaña de consola del emulador acepta que el usuario escriba: lo que tipea va a la REPL. Así puede probar cosas en vivo (`machine.Pin(7, machine.Pin.OUT).on()` y ver el LED virtual).

**WiFi**: `wifi_sim.py` define `SSID` y `PASSWORD`; la plantilla de `main.py` los usa con `network.WLAN`.

**Módulos útiles ya incluidos en el firmware**: `machine` (Pin, UART, Timer), `network`, `socket`, `_thread`, `asyncio`, `esp32.RMT` (transmisión por RMT; en MicroPython no hay recepción por RMT, así que para recibir RF se usa la API `simbridge.on_rf` de 7.4).

---

## 9. Gestor del emulador

### 9.1 Arranque

```bash
esp-emu --chip esp32s3 \
  --firmware <build>/firmware.factory.bin \
  --elf <build>/firmware.elf \
  --wifi-ssid <sim.wifiSsid> --wifi-password <sim.wifiPassword> \
  --uart1-tcp 127.0.0.1:<pBridge> \
  --control-tcp 127.0.0.1:<pControl> \
  --net "user,hostfwd=tcp:127.0.0.1:<pApi>-:6053,hostfwd=tcp:127.0.0.1:<pWeb>-:80" \
  [--rmt-loopback <tx>:<rx>,…] \
  --log-color never
```

- `spawn` sin shell, con los argumentos en un array.
- Ligar los hostfwd a `127.0.0.1` y no a `0.0.0.0`, para no exponer el dispositivo a la red.
- `--log-color never`: los colores de ESPHome vienen igual en los logs; esto solo evita los del emulador.
- stdout y stderr línea por línea → `logParser` → WebSocket.
- Por lenguaje: ESPHome/ESP-IDF/Arduino pasan `--elf` (backtraces con líneas de código); MicroPython no tiene ELF y agrega `--uart-tcp 127.0.0.1:<pRepl>` para la REPL (8.8). Los hostfwd de API (6053) y web (80) solo se agregan si el proyecto los usa.
- MicroPython: el emulador queda vivo entre ejecuciones (cargar código es un soft reset, 8.8). Los demás lenguajes lo reinician con el firmware nuevo.

### 9.2 Estados y detección

| Estado | Cómo se detecta |
|---|---|
| `starting` | Proceso lanzado |
| `booted` | ESPHome: `setup() finished successfully!` [verificado]. ESP-IDF/Arduino: `Calling app_main()` o el primer log del usuario. MicroPython: prompt `>>> ` [verificado] |
| `wifi` | Línea `[wifi…]: Connected` y la IP [verificado] |
| `bridge` | Llegó `@READY` por UART1 |
| `crashed` | Líneas `Guru Meditation`, `abort()` o `Backtrace:`; el emulador intercepta los pánicos y muestra backtrace con líneas de código [verificado que instala los interceptores] |
| `hung` | Sin ninguna línea nueva durante 60 s en `starting` |
| `stopped` | El proceso terminó |

### 9.3 Puertos

- Reservar 4 puertos por instancia (puente, control, API, web) buscando libres a partir de 20000: abrir un servidor en el puerto, cerrarlo y usarlo.
- Nunca asumir 8080 ni 6053 en la PC: 8080 está ocupado acá [verificado].
- Si `esp-emu` imprime `bind TCP … failed: Address already in use` [verificado], reintentar con otros puertos.

### 9.4 Parada y reset

- Reset: enviar `reset\n` al canal de control; el proceso sigue vivo y el log continúa [documentado por Espressif].
- Parar: `SIGTERM`, esperar 3 s, `SIGKILL`.
- Al cerrar el backend (`SIGINT`, `SIGTERM`, `exit`), matar todos los emuladores hijos.
- **No usar `pkill -f esp-emu`** en scripts: también mata la shell que lo ejecuta [verificado]. Usar el PID guardado, o `pkill -x esp-emu`.
- La v1 permite una instancia a la vez (cada una consume cerca de 0,7 núcleos).

---

## 10. API del backend

Escucha en `127.0.0.1` y un puerto configurable (por defecto 5180, verificando que esté libre).

### 10.1 REST

| Método y ruta | Uso |
|---|---|
| `GET /api/boards` | Placas disponibles |
| `GET /api/modules` | Catálogo de módulos (JSON + URL del SVG) |
| `GET /api/projects` | Lista de proyectos |
| `POST /api/projects` | Crear (`{ name, language }`); copia la plantilla del lenguaje, que ya bootea |
| `GET /api/projects/:name` | `project.json` + lista de archivos de código |
| `GET /api/projects/:name/files/*path` | Leer un archivo de código |
| `PUT /api/projects/:name/files/*path` | Guardar un archivo de código (crea si no existe) |
| `DELETE /api/projects/:name/files/*path` | Borrar un archivo de código |
| `PUT /api/projects/:name/diagram` | Guardar el dibujo |
| `POST /api/projects/:name/build` | Compilar (responde al instante; el progreso va por WebSocket). En MicroPython no hace nada. |
| `POST /api/projects/:name/run` | ESPHome/C/C++: compilar si hace falta y arrancar. MicroPython: cargar archivos y soft reset (8.8). |
| `POST /api/emulator/stop` | Parar |
| `POST /api/emulator/reset` | Reset |
| `GET /api/emulator` | Estado, puertos, proyecto en ejecución |

### 10.2 WebSocket `/ws`

Servidor → navegador:

| `type` | Contenido |
|---|---|
| `build.log` | `{ line }` |
| `build.done` | `{ ok, durationMs, errors: [{ line, message }] }` |
| `emu.state` | `{ state }` (9.2) |
| `emu.log` | `{ line }` (con ANSI) |
| `pin.out` | `{ pin, level }` |
| `rf.tx` | `{ bits, protocol }` |
| `bridge.state` | `{ connected }` |

Navegador → servidor:

| `type` | Contenido |
|---|---|
| `pin.in` | `{ pin, level }` |
| `rf.send` | `{ bits, protocol }` |
| `console.input` | `{ data }` — lo que el usuario tipea en la consola (REPL de MicroPython, o `Serial` de Arduino si lee entrada). Se reenvía a UART0 RX. |

Las rutas de archivos se validan: relativas a la carpeta del proyecto, sin `..`, solo extensiones permitidas por lenguaje (`.yaml`; `.c .cpp .h .hpp CMakeLists.txt sdkconfig.defaults idf_component.yml`; `.py`).

Todos los mensajes se validan con los esquemas de `shared/src/protocol.ts`.

---

## 11. Frontend

### 11.1 Distribución

```
┌──────────────────────────────────────────────────────────────────┐
│ [Proyecto ▾] [▶ Ejecutar] [■ Parar] [↻ Reset]  Estado: ● wifi    │
├─────────────┬─────────────────────────────────┬──────────────────┤
│  Paleta de  │                                 │  Editor YAML     │
│  módulos    │     Placa + módulos + cables    │  (CodeMirror)    │
│             │            (SVG)                │                  │
│             │                                 │                  │
├─────────────┴─────────────────────────────────┴──────────────────┤
│ Consola (xterm.js)  [Compilación | Emulador]   [Abrir web ↗]     │
└──────────────────────────────────────────────────────────────────┘
```

- "Abrir web ↗" aparece si el proyecto usa `web_server` y abre `http://127.0.0.1:<pWeb>`.
- Paneles redimensionables. El editor se puede maximizar.

### 11.2 Placa y cables

- SVG con la placa y cada pin como un círculo clickeable con su nombre al pasar el mouse.
- Cablear: click en un pin del módulo → click en un pin de la placa. Cable como línea con curva y color según el tipo (rojo alimentación, negro GND, verde señal).
- Borrar: seleccionar y `Supr`. Mover módulos arrastrando; los cables los siguen.
- Pines bloqueados en gris; los de advertencia con un ícono (6.3).
- Zoom con la rueda y paneo con arrastre del fondo.

### 11.3 Módulos durante la ejecución

- `input`: botón momentáneo (apretado mientras se mantiene el mouse), o interruptor que alterna. Envía `pin.in`.
- `output`: el LED toma su color con `pin.out = 1`.
- `air`: el control remoto muestra sus botones; el sensor de puerta un botón "Abrir/Cerrar"; la sirena se anima cuando llega un `rf.tx` con su código.
- Sin emulador corriendo, los controles se muestran deshabilitados.

### 11.4 Editor

- Modo según el lenguaje del proyecto: YAML, C/C++ o Python. Numeración de líneas, búsqueda.
- Pestañas de archivos: ESPHome usa uno (`main.yaml` + `secrets.yaml`); C/C++ y MicroPython pueden tener varios (crear, renombrar, borrar desde un árbol simple).
- Guardado automático 1 s después de dejar de escribir, y con `Ctrl+S`.
- `Ctrl+Enter` = Ejecutar.
- Marcas de error por línea (8.5), que se limpian al editar esa línea.

### 11.5 Consola

- Dos pestañas: compilación y emulador. Colores ANSI.
- La pestaña del emulador acepta escritura (mensaje `console.input`): es la REPL en MicroPython y la entrada de `Serial` en Arduino.
- Filtro de texto y botón para limpiar. Límite de 10.000 líneas.

### 11.6 Chequeo dibujo ↔ código

Antes de ejecutar, comparar los pines del dibujo con los del código y avisar, sin bloquear. Detección de pines por lenguaje (aproximada, con expresiones regulares; solo sirve para avisos):
- ESPHome: `pin:` y `number:` del YAML.
- ESP-IDF: `GPIO_NUM_<n>` y literales en `gpio_set_level(`, `gpio_get_level(`, `gpio_config`.
- Arduino: primer argumento de `pinMode(`, `digitalWrite(`, `digitalRead(`.
- MicroPython: `Pin(<n>` y `Pin("GPIO<n>"`.

Casos a avisar:
- Un módulo cableado a un pin que el código no usa.
- Un pin del código que no tiene ningún módulo en el dibujo.
- Un pin bloqueado usado en el código.

---

## 12. Catálogo de módulos v1

| Tipo | Rol | Pines | Control / visual | Propiedades |
|---|---|---|---|---|
| `button` | input | OUT, GND | Momentáneo | `label`, `activeLevel` (0 con pull-up) |
| `switch` | input | OUT, GND | Interruptor | `label` |
| `led` | output | IN, GND | Se enciende en `1` | `color` |
| `relay` | output | IN, VCC, GND | Muestra abierto/cerrado | `label` |
| `rxb6` | rf-rx | DATA, VCC, GND | Parpadea al recibir | — |
| `stx882` | rf-tx | DATA, VCC, GND | Parpadea al transmitir | — |
| `remote-433` | air | — | 4 botones, cada uno manda su código | `codes[4]`, `protocol` |
| `door-sensor-433` | air | — | Abrir/Cerrar; al abrir manda su código | `code`, `protocol` |
| `siren-433` | air | — | Se anima al recibir su código aprendido | `learnedCode`, `protocol` |

Los módulos de aire solo tienen efecto si hay un `rxb6` o `stx882` cableado. Para la alarma: el sensor de puerta y el control hablan con el `rxb6`; el `stx882` le habla a la sirena.

Para agregar un módulo nuevo después: crear `modules/<tipo>/module.json` + SVG. Si su `bridge.role` es uno de los existentes, no hace falta tocar el backend ni el firmware.

### 12.1 Extensión (después de la v1): módulos con lógica propia en la PC

Para módulos cuyo comportamiento no es "prender/apagar" (un sensor de temperatura que varía, un motor con inercia), la definición puede apuntar a un script que corre **en la PC**:

- `module.json` → `"behavior": { "runtime": "python", "file": "behavior.py" }` (o `"runtime": "c"` con un ejecutable compilado).
- El backend lo lanza como proceso hijo por cada instancia del módulo y le habla por stdin/stdout con JSON por línea: recibe `{"event":"pin.out","pin":7,"level":1}` y responde `{"action":"pin.in","pin":6,"level":0}` o `{"action":"rf.send",...}`.
- Python: el de la PC (3.14; no hace falta `pip` para esto, solo la biblioteca estándar). C: compilar con `gcc` y lanzar el binario.
- Seguridad: son scripts propios del usuario; se ejecutan con sus permisos, sin red, con timeout y límite de memoria (`ulimit`), y se matan al parar la simulación.

---

## 13. Seguridad

- El backend escucha **solo en `127.0.0.1`**. Lanza contenedores Docker, lo que equivale a permisos de root en la PC: nunca exponerlo a la red.
- Nombres de proyecto: solo `[a-z0-9-]`, máximo 40 caracteres. Rechazar `..` y `/` para evitar escribir fuera de `projects/`.
- Docker y `esp-emu` se lanzan con argumentos en array, nunca armando un string para la shell.
- El YAML del usuario puede tener lambdas en C++: se ejecutan dentro del emulador, que es un proceso del usuario sin privilegios; no dentro del backend.
- `secrets.yaml` nunca se envía al navegador; el editor muestra `!secret` como texto.
- Los hostfwd del emulador se ligan a `127.0.0.1`.
- `.build/` y `.cache/` van en `.gitignore`.

---

## 14. Pruebas y criterios de aceptación

### 14.1 Unitarias (Vitest)

- Transformación de YAML: conserva tags y comentarios, agrega los ajustes de 8.2, respeta listas existentes, mapa de líneas correcto.
- Parser del protocolo del puente: mensajes válidos, inválidos, líneas partidas entre paquetes TCP.
- Parser de logs: estados de 9.2 con líneas reales copiadas de esta guía.
- Reserva de puertos: no devuelve puertos ocupados.
- Chequeo dibujo ↔ código (11.6).

### 14.2 Integración (sin navegador)

Un proyecto de prueba con botón en GPIO6, LED en GPIO7, `rxb6` en GPIO4 y `stx882` en GPIO5:
- Compila y el emulador llega a `bridge`.
- `@IN 6 0` → el firmware lo ve (su log lo imprime).
- El firmware prende GPIO7 → llega `@OUT 7 1`.
- `@RF <código>` → el `binary_sensor` de ese código pasa a ON.
- El firmware transmite → llega `@TX <código>`.
- `reset` por el canal de control → nuevo `@READY` y la app reenvía el estado.

### 14.2b Integración por lenguaje

El mismo circuito (botón en GPIO6, LED en GPIO7) con una plantilla de cada lenguaje que copia el botón al LED:

| Lenguaje | Prueba |
|---|---|
| ESPHome | `binary_sensor` GPIO6 + `output` GPIO7 con automatización |
| ESP-IDF C | `gpio_get_level(6)` → `gpio_set_level(7, …)` en un bucle |
| Arduino | `digitalWrite(7, digitalRead(6))` en `loop()` |
| MicroPython | `Pin(7, Pin.OUT).value(Pin(6, Pin.IN, Pin.PULL_UP).value())` en un bucle |

En los cuatro: `@IN 6 0` → llega `@OUT 7 1`. Además: un error de sintaxis a propósito marca la línea correcta en el editor (YAML, GCC y traceback de Python).

### 14.3 De punta a punta (Playwright)

- Crear proyecto, cablear botón y LED, escribir el YAML, Ejecutar, apretar el botón virtual y ver el LED encendido.
- Error de YAML → marca en la línea correcta del editor.
- Parar y volver a ejecutar sin reiniciar el backend.

### 14.4 Escenario de aceptación: la alarma

Con el `panel-alarma.yaml` del proyecto (ajustado a los pines del dibujo):
1. Ejecutar → estado `DISARMED` visible en la consola y en "Abrir web".
2. Armar desde la web del ESP32 → pasa a `ARMING` y a los 30 s a `ARMED_AWAY`.
3. "Abrir" en el sensor de puerta → `PENDING`; a los 30 s → `TRIGGERED`.
4. La sirena virtual se anima (llegó su código por `stx882`).
5. Desarmar con el código → `DISARMED`.

---

## 15. Fases de implementación

Cada fase termina con algo que se puede probar.

### Fase 0 — Experimentos de validación (antes de escribir la app)

Proyecto ESPHome de prueba, sin app, corriendo `esp-emu` a mano. Resultado: una tabla con ✅/❌ que define las estrategias de 7.2.

| # | Experimento | Éxito si… |
|---|---|---|
| E1 | Salida: `output` GPIO en GPIO7 que alterna cada 1 s; una lambda lee `REG_READ(GPIO_OUT_REG)` y lo loguea | El bit 7 alterna en el log |
| E2 | Entrada: una lambda pone GPIO6 en `GPIO_MODE_INPUT_OUTPUT` y alterna `gpio_set_level`; un `binary_sensor` GPIO en GPIO6 lo lee | El `binary_sensor` cambia de estado |
| E3 | RF: `remote_transmitter` en GPIO5 + `remote_receiver` con `dump: rc_switch` en GPIO4; un `interval` transmite un código; correr con `--rmt-loopback` probando pares de canales (en S3 los TX son 0–3 y los RX 4–7 según el manual técnico; confirmar) | El receptor imprime el código transmitido |
| E4 | UART1 por TCP: `uart` en UART1 + `--uart1-tcp`; eco de líneas desde un script en Node | Ida y vuelta de 1.000 líneas sin pérdida |
| E5 | Compilar con `-u $(id -u):$(id -g)` y `/cache` compartido desde cero | Compila y los archivos quedan del usuario |
| E6 | MicroPython oficial v1.29.0 en S3: bootea y ejecuta código por la REPL | ✅ **Ya verificado** el 2026-09-28 (8.8). Falta probar el modo REPL crudo, la escritura de archivos y `--uart-tcp` |
| E7 | ESP-IDF 5.5.5: `hello_world` + `blink` compilados con el comando de 8.6 | Bootea y se ven los logs |
| E8 | Arduino como componente de ESP-IDF: sketch con `Serial.println` | Bootea y se ve la salida |
| E9 | Repetir E1–E2 desde C (ESP-IDF) y MicroPython (`machine.mem32`) | Mismo resultado que en ESPHome |

Si E3 no funciona con ningún par de canales, RF usa las transformaciones de YAML. Anotar los resultados en esta guía (sección 7.2).

### Fase 1 — Backend mínimo y panel de control

- Proyectos (crear, listar, leer, guardar), BuildService con 8.2, EmulatorManager, WebSocket de logs.
- Frontend: selector de proyecto, botones, consola, editor sin marcas de error.
- **Listo cuando**: se escribe un YAML en la web, "Ejecutar" compila, arranca y se ven los logs; Parar y Reset funcionan.

### Fase 2 — Placa y cableado

- Placa SVG con pines y restricciones, paleta, arrastrar módulos, cables, guardado en `project.json`, chequeo 11.6.
- **Listo cuando**: el dibujo se guarda, se recarga igual y avisa de pines incoherentes.

### Fase 3 — Puente e interacción

- Componente `sim_bridge`, `BridgeClient`, mensajes `pin.in`/`pin.out`, módulos `button`, `switch`, `led`, `relay`.
- **Listo cuando**: pasan las pruebas de 14.2 de entradas y salidas y la de Playwright del botón y el LED.

### Fase 4 — RF

- `rxb6`, `stx882`, `remote-433`, `door-sensor-433`, `siren-433` y los mensajes RF.
- **Listo cuando**: pasa el escenario de la alarma (14.4).

### Fase 5 — C/C++ y Python

- Núcleo del puente en C (`bridge-core`) y sus envoltorios ESP-IDF y MicroPython (7.4).
- `BuildService` para ESP-IDF, Arduino y MicroPython (8.6–8.8), plantillas de cada lenguaje, editor con varios archivos, consola con entrada.
- **Listo cuando**: pasan las pruebas de 14.2b en los cuatro lenguajes.

Orden sugerido dentro de la fase: MicroPython primero (ya bootea y no necesita compilar), después ESP-IDF, después Arduino.

### Fase 6 — Pulido

- Marcas de error en el editor con mapa de líneas, atajos, guardado automático, "Abrir web", mensajes de estado claros, README de uso.

---

## 16. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| `esp-emu` es beta y cerrado: una versión nueva rompe algo | Fijar versión (`install.sh --version 0.44.0`); correr las pruebas de integración antes de actualizar |
| Los experimentos E1–E3 fallan | Estrategias alternativas por transformación de YAML (7.2) |
| El dibujo y el código se desincronizan | Chequeo 11.6 antes de cada ejecución |
| Primera compilación muy lenta (≈10 min) | Caché compartida; mostrar el progreso real; avisarlo en la interfaz la primera vez |
| Archivos de root por Docker | `-u` desde el inicio; comando de limpieza en 8.4 |
| Puertos ocupados | Reserva dinámica (9.3) |
| Procesos huérfanos de `esp-emu` | Matarlos al cerrar el backend; al arrancar, detectar y ofrecer matarlos por PID |
| El firmware de simulación difiere del real | El puente solo se agrega en `main.sim.yaml`; `main.yaml` queda intacto y es el que se flashea |
| El usuario usa UART1 en su código | Detectarlo y avisar que en simulación está ocupado por el puente |
| La imagen de ESP-IDF pesa ~3 GB | Descargarla solo cuando se crea el primer proyecto C/C++, con aviso y barra de progreso (`docker pull`) |
| Arduino como componente pide una versión de ESP-IDF distinta | Fijar la pareja de versiones en la plantilla; alternativa PlatformIO (8.7) |
| MicroPython queda colgado por un bucle infinito del usuario | "Parar" manda `Ctrl-C`; si en 3 s no aparece `>>>`, reset por el canal de control |
| El firmware de MicroPython cambia de versión | Fijar el archivo (`v1.29.0`) en `firmware/micropython/` y verificar su hash SHA-256 al descargarlo |

---

## 17. Comandos de referencia

Todos probados en esta PC salvo los marcados.

```bash
# Validar y compilar un YAML de ESPHome
docker run --rm -v "$PWD":/config ghcr.io/esphome/esphome config  mi.yaml
docker run --rm -v "$PWD":/config ghcr.io/esphome/esphome compile mi.yaml

# Correr en el emulador con API y web expuestas
esp-emu --chip esp32s3 \
  --firmware .esphome/build/<nombre>/build/firmware.factory.bin \
  --elf .esphome/build/<nombre>/build/firmware.elf \
  --wifi-ssid "<ssid>" --wifi-password "<clave>" \
  --net "user,hostfwd=tcp::6053-:6053,hostfwd=tcp::18080-:80"

# Conectarse a la API cifrada como lo haría Home Assistant
docker run --rm --network host -v "$PWD":/config ghcr.io/esphome/esphome logs mi.yaml --device 127.0.0.1

# Consultar la web del ESP32 (REST de web_server)
curl "http://localhost:18080/alarm_control_panel/Alarma%20Casa"

# MicroPython: bajar el firmware y probar la REPL por la entrada estándar [verificado]
curl -fsSL -o mp-s3.bin https://micropython.org/resources/firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin
(printf 'print("hola", 6*7)\r\n'; sleep 30) | esp-emu --chip esp32s3 --firmware mp-s3.bin

# ESP-IDF (no probado todavía; ver 8.6)
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/project -w /project \
  espressif/idf:v5.5.5 idf.py set-target esp32s3 build merge-bin -o build/merged_flash.bin

# Canal de control (no probado todavía)
printf 'reset\n' | nc 127.0.0.1 <pControl>

# Parar el emulador sin matar la shell
pkill -x esp-emu

# Limpiar una carpeta .esphome que quedó de root
docker run --rm -v "$PWD":/config alpine rm -rf /config/.esphome
```

---

## 18. Checklist final

**Preparación**
- [ ] Fase 0 hecha y resultados anotados en 7.2
- [ ] Pinout de la DevKitC-1 verificado contra la guía de Espressif
- [ ] Versiones fijadas: `esp-emu` 0.44.0, imagen ESPHome 2026.9.0

**Backend**
- [ ] Escucha solo en 127.0.0.1
- [ ] Validación de nombres de proyecto
- [ ] Ajustes obligatorios de 8.2 aplicados, incluido `hardware_uart: UART0`
- [ ] Docker con `-u` y caché compartida
- [ ] Puertos dinámicos, hostfwd ligados a 127.0.0.1
- [ ] Emuladores hijos se matan al cerrar el backend
- [ ] Mensajes del WebSocket validados con zod

**Firmware**
- [ ] `sim_bridge` con `@READY`, `@WATCH`, `@IN`, `@OUT`, `@RF`, `@TX`, `@PING`
- [ ] Nunca bloquea el `loop()`
- [ ] Solo presente en la compilación de simulación (`main.sim.yaml`, `EXTRA_COMPONENT_DIRS`, `boot.py` subido por la app)
- [ ] Núcleo en C compartido por ESPHome y ESP-IDF/Arduino; versión Python para MicroPython
- [ ] Stubs de producción (`sim_bridge_stub.h`, `try: import simbridge`)

**Lenguajes**
- [ ] Plantilla de cada lenguaje que bootea en el emulador
- [ ] Consola forzada a UART0 en ESPHome, ESP-IDF y Arduino
- [ ] ESP-IDF: `sdkconfig.defaults.sim`, `sim_config.h`, `merge-bin`
- [ ] Arduino: componente con versión fija, `sketch.cpp` → `main/`
- [ ] MicroPython: firmware v1.29.0 con hash verificado, modo REPL crudo, subida de archivos, soft reset, `Ctrl-C`
- [ ] Errores al editor: YAML, GCC y tracebacks de Python

**Frontend**
- [ ] Placa con pines bloqueados y de advertencia
- [ ] Cablear, mover, borrar; se guarda y se recarga igual
- [ ] Editor con guardado automático, `Ctrl+Enter` y marcas de error
- [ ] Consola con colores y dos pestañas
- [ ] Módulos interactivos deshabilitados sin emulador
- [ ] Chequeo dibujo ↔ código antes de ejecutar

**Pruebas**
- [ ] Unitarias de 14.1
- [ ] Integración de 14.2
- [ ] Integración por lenguaje de 14.2b
- [ ] Playwright de 14.3
- [ ] Escenario de la alarma de 14.4

**Documentación**
- [ ] README de la app: cómo arrancarla, cómo crear un módulo nuevo
- [ ] Esta guía actualizada con lo que cambió durante la implementación
