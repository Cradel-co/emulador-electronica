# Visión y alcance del proyecto

> Corrección de rumbo pedida por el usuario el 2026-09-29: este documento fija qué es
> el proyecto y qué no, para que no se vuelva a angostar sin querer.

## Qué es

Una plataforma general de prototipado de hardware, **no** un emulador de Home
Assistant ni algo atado a ESPHome. La idea de uso real:

1. Antes de comprar un módulo (un sensor, un display, un motor, lo que sea), lo cargás
   acá y ves cómo se comporta y cómo interactúa con el resto del circuito.
2. Armás un proyecto combinando módulos del catálogo (los de fábrica, o los que
   importaste) más el código que quieras escribir vos.
3. La app tiene que **emular todo con exactitud** — no solo mostrar un dibujo lindo:
   el circuito tiene que comportarse eléctricamente como en la vida real (ver
   [`motor-electrico.md`](motor-electrico.md): ngspice resuelve todo el circuito con
   Ohm, Kirchhoff y la conservación de la energía, no una aproximación visual) y el
   código tiene que correr en un emulador real del chip, no en un intérprete inventado.
4. Al final, la app tiene que poder darte **el esquemático final de todo conectado y
   andando** — y ese esquemático tiene que llevar todos los valores del circuito
   (props de cada módulo, cableado completo, corrientes y tensiones calculadas), en
   un formato que un agente/IA pueda leer y examinar, no solo una imagen para mirar.
   **Esto todavía no existe** — ver "Pendiente" más abajo.

ESPHome es **una de las opciones**, no una dependencia de la arquitectura. Ver
`shared/src/languages.ts` → `LANGUAGES`: **ESPHome (YAML), ESP-IDF (C), ESP-IDF (C++),
Arduino y MicroPython**. Elegís la **placa** y el lenguaje al crear el proyecto.

## Placas: son datos, no código

Cada placa es un módulo programable del catálogo (`modules/<id>/module.json` +
`module.svg`) con un bloque `"board"` que dice qué chip tiene, con qué **motor** se emula,
qué **toolchain** compila cada lenguaje, qué pin del dibujo es qué pin del MCU, qué pines
usa la propia simulación y cuánta corriente aguanta. El server arma el registro de placas
leyendo el catálogo (incluidos los módulos importados), así que **una placa nueva con un
chip que ya tiene motor se agrega sin tocar código** — la puede escribir un dev o un
agente de IA desde un esquemático:

1. `GET /api/boards/schema` (o MCP `esquema_placa`): JSON Schema del bloque `board`.
2. `POST /api/boards/validate` (MCP `validar_placa`): esquema, pines contra `pins[]` del
   módulo, reservados, motor/toolchains existentes y sus opciones.
3. Importarla con el importador de módulos de siempre (carpeta, zip, URL, GitHub).
4. `POST /api/boards/:id/certify` (MCP `certificar_placa`): compila su plantilla, la emula
   y comprueba que el botón de prueba prenda el LED. Nivel de soporte resultante:
   **emula** / **compila** / **solo-dibujo** (se ve en `GET /api/boards`).

Motores y toolchains son plugins del server (`app/server/src/engines/`,
`app/server/src/toolchains/`, cada carpeta con su README con la interfaz). Un chip de otra
familia = un motor nuevo, no cambios en el resto.

### Placas de fábrica (verificado el 2026-09-30)

| Placa | Chip / motor | Lenguajes | Qué anda de punta a punta (compilación + emulador reales) | Límites honestos |
|---|---|---|---|---|
| ESP32-S3 DevKitC-1 | ESP32-S3 (Xtensa LX7) / `esp-emu` | ESPHome, ESP-IDF C/C++, Arduino (componente de ESP-IDF), MicroPython | **ESPHome** y **MicroPython**: botón → LED en vivo; certificada "emula". RF 433 (ESPHome). | ESP-IDF/Arduino-ESP32 no verificados en esta PC (falta bajar la imagen de 3 GB) y sin puente: en C/C++ las entradas no llegan al código. Entradas por el puente, no por el pad (límite de esp-emu). |
| ESP32-C3 DevKitM-1 | ESP32-C3 (RISC-V) / `esp-emu --chip esp32c3` | ídem S3 | **ESPHome** y **MicroPython**: botón → LED en vivo; certificada "emula". | Puente en UART1 = GPIO0/1 (reservados). Sin RF 433. ESP-IDF/Arduino sin verificar (ídem S3). |
| ESP32-C6 DevKitC-1 | ESP32-C6 (RISC-V) / `esp-emu --chip esp32c6` | ídem S3 | **ESPHome** y **MicroPython**: botón → LED en vivo; certificada "emula". | Puente en UART1 = GPIO0/1 (reservados). Sin RF. ESP-IDF/Arduino sin verificar (ídem S3). |
| Arduino Uno R3 | ATmega328P a 16 MHz / `avr8js` (Wokwi), en un hilo aparte | Arduino (arduino-cli + core arduino:avr 1.8.6, imagen `docker/arduino-avr`) | Compila en ~3 s, corre ciclo a ciclo, Serial en la consola (y entrada por consola), D2 → D13 en vivo; certificada "emula". **Las entradas llegan al pad real** (digitalRead, pull-ups, interrupciones). Lógica de 5 V en la Ley de Ohm. | **I2C hacia los chips del dibujo** (BME280, DS3231 + AT24C32, SSD1306, MPU-6050: ver `chips/README.md`); las librerías de cada módulo se instalan solas al compilar (`drivers` y `librerias.txt`). Sin SPI hacia el dibujo, sin RF, ADC siempre en 0 V. Si la PC está muy cargada corre más lento que el tiempo real (lo avisa en la consola; los chips siguen el tiempo de la emulación). |

El ESP32 clásico (Xtensa LX6) sigue sin poder emularse: `esp-emu` no lo soporta.

## Qué NO es (todavía) — límite real, no de diseño

**No emula cualquier chip.** Cada familia necesita un motor de CPU real: hoy hay dos
(`esp-emu` para ESP32-S3/C3/C5/C6/H2/P4 y `avr8js` para ATmega328P). Una Raspberry Pi Pico
(RP2040), un STM32 o un nRF52 necesitan otro motor. El camino previsto está preparado
(interfaz + plan, sin implementar): el motor genérico **Renode** (Cortex-M/RISC-V descritos
con archivos `.repl`) y el toolchain genérico **PlatformIO** — ver
`app/server/src/engines/renode.ts` y `app/server/src/toolchains/platformio.ts`. Mientras no
estén, una placa de otra familia se puede cargar igual y queda en "solo dibujo".

## Pendiente (para no perderlo de vista)

- **Esquemático final exportable con todos los valores.** Hoy `ver_proyecto` (MCP) ya
  devuelve el circuito completo en JSON (módulos, props, cableado, avisos) — falta
  sumarle los valores eléctricos calculados (corriente y tensión por rama, no solo
  los avisos de peligro) y una exportación visual (PNG/SVG/PDF) del circuito ya
  armado, pensada para imprimir o adjuntar, no para seguir editando.
- **Más familias de chips** (RP2040, STM32, nRF52...): motor Renode + toolchain PlatformIO
  (preparados, sin implementar). Más placas AVR (Nano, Pro Mini) ya son solo datos.
- Puente para ESP-IDF/Arduino-ESP32 (hoy en C/C++ las entradas no llegan al código) y
  verificar esos toolchains con la imagen `espressif/idf` bajada.
- I2C hacia los chips en los ESP32: esp-emu no acepta dispositivos I2C propios; con MicroPython
  se puede reemplazando `machine.I2C` por el puente (ver `SDD-MODULOS.md`, sección 6).
- SPI hacia los chips del dibujo en el Uno (avr8js trae `AVRSPI`): pantallas TFT, e-paper, SD.
- Catálogo con más partes reales (motores, buzzers, más sensores) — cada una con su
  `model.js`, ver [`modulos-y-su-codigo.md`](modulos-y-su-codigo.md).
- **Motor eléctrico, siguiente fase:** análisis transitorio (capacitores que se cargan,
  PWM, el clic del relé), que lo que el firmware lee (entradas, ADC) salga del motor, y
  modelos térmicos (ver los límites en [`motor-electrico.md`](motor-electrico.md)).

## Documentos relacionados

- [`../GUIA-IMPLEMENTACION.md`](../GUIA-IMPLEMENTACION.md) — diseño técnico completo
  (arquitectura, protocolo del puente, pipeline por lenguaje).
- [`../modules/README.md`](../modules/README.md) — formato de módulo y cómo importar uno.
- [`motor-electrico.md`](motor-electrico.md) — el motor eléctrico (ngspice), las leyes que
  respeta y cómo se verificó.
- [`modulos-y-su-codigo.md`](modulos-y-su-codigo.md) — el código de los módulos y cómo
  crear uno nuevo.
- [`fuentes-de-alimentacion.md`](fuentes-de-alimentacion.md) — fuentes regulables,
  energía de la placa y proyectos sin placa.
- [`esp-emulator.md`](esp-emulator.md) — qué es y qué no es `esp-emu`.
