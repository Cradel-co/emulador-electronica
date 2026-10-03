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
3. La meta es que el circuito se comporte eléctricamente como en la vida real y que el
   código corra en un emulador del chip, no en un intérprete inventado. Cada resultado
   depende de los componentes y fenómenos que estén modelados: el estado actual y sus
   límites se documentan abajo y en [`motor-electrico.md`](motor-electrico.md). No se
   promete exactitud física universal para cualquier circuito o componente.
4. Al final, la app tiene que poder darte **el esquemático final de todo conectado y
   andando**, con propiedades, cableado y mediciones calculadas en un formato legible
   por una persona o un agente/IA. Ya se pueden consultar mediciones eléctricas en vivo
   en la aplicación y en la API de pines; falta incorporarlas al resultado de
   `ver_proyecto` y ofrecer una exportación final del esquemático. Ver "Pendiente" más
   abajo.

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

### Placas de fábrica

Estado documental actualizado el 2026-10-03 contra el código y las pruebas versionadas;
no implica una nueva certificación de hardware en esta máquina.

| Placa | Chip / motor | Lenguajes | Qué anda de punta a punta (compilación + emulador reales) | Límites honestos |
|---|---|---|---|---|
| ESP32-S3 DevKitC-1 | ESP32-S3 (Xtensa LX7) / `esp-emu` | ESPHome, ESP-IDF C/C++, Arduino (componente de ESP-IDF), MicroPython | **ESPHome** y **MicroPython**: botón → LED en vivo; certificada "emula". RF 433 (ESPHome). | ESP-IDF/Arduino-ESP32 no verificados en esta PC (falta bajar la imagen de 3 GB) y sin puente: en C/C++ las entradas no llegan al código. Entradas por el puente, no por el pad (límite de esp-emu). |
| ESP32-C3 DevKitM-1 | ESP32-C3 (RISC-V) / `esp-emu --chip esp32c3` | ídem S3 | **ESPHome** y **MicroPython**: botón → LED en vivo; certificada "emula". | Puente en UART1 = GPIO0/1 (reservados). Sin RF 433. ESP-IDF/Arduino sin verificar (ídem S3). |
| ESP32-C6 DevKitC-1 | ESP32-C6 (RISC-V) / `esp-emu --chip esp32c6` | ídem S3 | **ESPHome** y **MicroPython**: botón → LED en vivo; certificada "emula". | Puente en UART1 = GPIO0/1 (reservados). Sin RF. ESP-IDF/Arduino sin verificar (ídem S3). |
| Arduino Uno R3 | ATmega328P a 16 MHz / `avr8js` (Wokwi), en un hilo aparte | Arduino (arduino-cli + core arduino:avr 1.8.6, imagen `docker/arduino-avr`) | Compila en ~3 s, corre ciclo a ciclo, Serial en la consola (y entrada por consola), D2 → D13 en vivo; certificada "emula". **Las entradas llegan al pad real** (digitalRead, pull-ups, interrupciones). Lógica de 5 V en la Ley de Ohm. | **I2C y SPI hacia los chips del dibujo** (BME280, DS3231 + AT24C32, SSD1306, MPU-6050 y TFT ST7735: ver `chips/README.md`); las librerías de cada módulo se instalan solas al compilar (`drivers` y `librerias.txt`). Sin RF, ADC siempre en 0 V. Si la PC está muy cargada corre más lento que el tiempo real (lo avisa en la consola; los chips siguen el tiempo de la emulación). |

Los ESP32 con MicroPython también tienen chips I2C/SPI mediante el puente de drivers
`machine.I2C`, `SoftI2C`, `SPI` y `SoftSPI`. Los pines elegidos por el programa deben
coincidir con el dibujo. En el Uno, el bus lo ejecuta el periférico emulado; en ESP32
las transacciones pasan por UART y no conservan los tiempos del bus real. Ver
[`chips/README.md`](../chips/README.md).

El ESP32 clásico (Xtensa LX6) sigue sin poder emularse: `esp-emu` no lo soporta.

## Cobertura de electrónica

El producto es hoy un **entorno de prototipado con simulación eléctrica y ejecución de
firmware**, no un curso interactivo que enseñe estos temas paso a paso. La cobertura
implementada es la siguiente:

| Tema | Estado actual | Límite o faltante |
|---|---|---|
| **Ley de Ohm y leyes de Kirchhoff** | Implementadas por el motor ngspice para redes de CC. Se comprueban circuitos en serie y paralelo, mallas y puentes; las pruebas verifican corrientes de nodo y conservación de energía. | El resultado solo es tan completo como los modelos físicos conectados y el tipo de análisis disponible. |
| **Resistencias** | Hay una resistencia configurable y se calculan su caída, corriente y potencia. | No se simula temperatura ni cambio de valor por calentamiento. |
| **Capacitores e inductores** | El SDK de modelos admite primitivas de capacitor e inductor. | No hay módulos de catálogo ni simulación temporal: en el análisis actual se comportan como circuito abierto y cable, respectivamente. No se muestran carga, descarga, filtros ni transitorios. |
| **Diodos y transistores** | Los LED tienen un modelo no lineal con polaridad y curva de corriente; la placa incluye diodos de protección. El relé modela su bobina y contacto controlado. | No existe un catálogo general de diodos ni transistores discretos (BJT/MOSFET) que el usuario pueda añadir como componentes. |
| **CC y CA** | Las fuentes regulables simulan tensión continua ajustable, límite de corriente, modo CV/CC y polaridad. | No hay fuentes sinusoidales, análisis de CA/frecuencia ni formas de onda transitorias. |
| **Analógico y digital** | El firmware de las placas soportadas acciona salidas y lee entradas digitales. El motor calcula tensión de pines y aplica umbrales lógicos de cada placa; el gráfico de pines en Debug traza niveles digitales 0/1 como analizador lógico simplificado. | Las lecturas ADC (`analogRead`, `sensor: adc`) aún no salen de la tensión resuelta por el circuito; no hay un catálogo genérico de compuertas TTL/CMOS. El gráfico lógico no sustituye una forma de onda de voltaje. Ver [cómo leer los niveles de pin](depuracion.md). |
| **Topologías y prototipado** | El lienzo permite colocar módulos y cablear pines; se resuelven redes con ramas y mallas sin limitarse a un camino fuente-carga. | No existe un modelo físico de breadboard con filas y rieles internos. El lienzo no reemplaza todavía un editor/exportador de esquemáticos eléctricos estándar. |
| **Potencia, fuentes y consumo** | Se modelan alimentación USB y fuentes regulables con límite, reguladores de placas y consumo de módulos. La UI muestra tensión, corriente, resistencia y potencia calculadas, además de tensión por pin. | Son valores de simulación basados en parámetros/modelos, no mediciones de hardware real. Los modelos térmicos y el daño acumulado están pendientes. |

El detalle de las ecuaciones, modelos y pruebas está en [`motor-electrico.md`](motor-electrico.md).
La descripción de fuentes, alimentación de placa y lecturas en vivo está en
[`fuentes-de-alimentacion.md`](fuentes-de-alimentacion.md). El catálogo concreto está en
[`../modules/README.md`](../modules/README.md).

## Qué NO es (todavía) — límite real, no de diseño

**No emula cualquier chip.** Cada familia necesita un motor de CPU real: hoy hay dos
(`esp-emu` para ESP32-S3/C3/C5/C6/H2/P4 y `avr8js` para ATmega328P). Una Raspberry Pi Pico
(RP2040), un STM32 o un nRF52 necesitan otro motor. El camino previsto está preparado
(interfaz + plan, sin implementar): el motor genérico **Renode** (Cortex-M/RISC-V descritos
con archivos `.repl`) y el toolchain genérico **PlatformIO** — ver
`app/server/src/engines/renode.ts` y `app/server/src/toolchains/platformio.ts`. Mientras no
estén, una placa de otra familia se puede cargar igual y queda en "solo dibujo".

## Pendiente (para no perderlo de vista)

- **Modularización de la UI:** la migración de paneles a React está terminada; queda
  separar las responsabilidades que siguen en `app/web/app.ts`, siguiendo las
  [reglas de arquitectura](arquitectura-web.md).

- **Esquemático final exportable con todos los valores.** Hoy la ventana Debug y
  `GET /api/projects/:nombre/pins` muestran mediciones eléctricas en vivo (tensión,
  corriente y potencia de la alimentación; mediciones por componente; tensión por pin).
  `ver_proyecto` (MCP) devuelve el circuito en JSON (módulos, propiedades, cableado y
  avisos), pero todavía falta incluir allí el detalle completo de las mediciones y crear
  una exportación visual PNG/SVG/PDF pensada para imprimir o adjuntar.
- **Más familias de chips** (RP2040, STM32, nRF52...): motor Renode + toolchain PlatformIO
  (preparados, sin implementar). Más placas AVR (Nano, Pro Mini) ya son solo datos.
- Puente para ESP-IDF/Arduino-ESP32 (hoy en C/C++ las entradas no llegan al código) y
  verificar esos toolchains con la imagen `espressif/idf` bajada.
- Chips I2C/SPI en ESP32 con ESPHome, ESP-IDF y Arduino: falta el puente para esos
  lenguajes. **MicroPython ya tiene I2C/SPI** reemplazando los drivers `machine` por el
  puente UART; sus tiempos de transacción no son los del bus real.
- Más chips SPI: e-paper y SD. El bus del Uno y la TFT ST7735 ya están implementados.
- Catálogo con más partes reales (motores, buzzers, más sensores) — cada una con su
  `model.js`, ver [`modulos-y-su-codigo.md`](modulos-y-su-codigo.md).
- **Ampliar la simulación eléctrica:** análisis transitorio para capacitores, inductores,
  PWM y tiempos de conmutación (por ejemplo, el clic del relé); fuentes y análisis de CA;
  modelos de transistores y otros semiconductores; y lecturas ADC derivadas del voltaje
  calculado por el motor. Los modelos térmicos también quedan pendientes (ver los
  límites en [`motor-electrico.md`](motor-electrico.md)).
- **Prototipado y documentación del circuito:** decidir si el alcance necesita una
  breadboard con conexiones internas, y completar la exportación de esquemáticos con
  propiedades, conexiones y mediciones para PNG/SVG/PDF y para `ver_proyecto` (MCP).

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
