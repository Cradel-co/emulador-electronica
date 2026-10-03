# Emulador de electrónica

Plataforma local de **prototipado de hardware**: armás un circuito con módulos reales, escribís el firmware y lo ves correr sobre un **emulador real del chip**, con física eléctrica calculada (Ley de Ohm de verdad, no un dibujo animado).

No es un emulador de Home Assistant ni está atado a ESPHome. La idea es: **antes de comprar un módulo, probalo acá** y mirá cómo se comporta junto con el resto del circuito.

- **Chips emulados de verdad:** ESP32-S3 / C3 / C6 (motor `esp-emu` de Espressif) y ATmega328P (motor `avr8js`). No hay intérprete: corre el firmware compilado de verdad.
- **Lenguajes:** ESPHome (YAML), ESP-IDF (C y C++), Arduino y MicroPython.
- **Las placas son datos:** cada placa es un `module.json` con su bloque `board`. Una placa nueva con un chip que ya tiene motor se agrega **sin tocar código**.
- **Agente de IA:** expone un server **MCP** con herramientas para controlar todo (crear proyectos, editar código, cablear, compilar, ejecutar, accionar módulos, debuggear). Lo que hace el agente se ve en vivo en la UI.

Alcance completo y límites honestos: [`docs/vision-y-alcance.md`](docs/vision-y-alcance.md).

---

## Requisitos

| Herramienta | Para qué | Obligatoria |
|---|---|---|
| **Node.js 24** | la app | ✅ sí |
| **Docker** | compilar ESPHome, ESP-IDF y Arduino | ✅ sí (salvo que solo uses MicroPython) |
| **[`esp-emu`](https://github.com/espressif/esp-emulator)** (Espressif, beta, gratis, no open source) | emular ESP32-S3/C3/C6 | para las placas ESP32 |
| **[`wokwi-cli`](https://github.com/wokwi/wokwi-cli)** + cuenta Wokwi | alternativa en la nube, chips custom, diagrama visual | opcional |
| Extensión **Wokwi Simulator** para VS Code | simulador visual para prototipar cableado rápido | opcional |

`esp-emu` va en `~/.local/bin/esp-emu` y `wokwi-cli` (opcional) en `~/bin/wokwi-cli`. Si `esp-emu` no está, cualquier proyecto ESP32 falla al arrancar — ver [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Instalación

Son cinco pasos, en orden. El 1 y el 3 se saltean fácil y son la causa más común de que después no arranque nada.

### 1. Node.js 24

```bash
node -v && npm -v        # ambos tienen que imprimir un número
```

Si `node: orden no encontrada`, no tenés Node. Con [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
nvm install 24 && nvm use 24
```

> **Ojo con esto**: nvm es una función de shell, no un ejecutable. Si instalaste
> nvm y `node` sigue sin aparecer, no es que falle — es que la terminal actual no
> tiene el PATH. Abrí una terminal nueva, o `source ~/.bashrc`. Es la causa más
> común de `npm: orden no encontrada` en una máquina que sí tiene Node.

### 2. Docker

```bash
docker info >/dev/null && echo ok
```

Solo hace falta si vas a compilar ESPHome, ESP-IDF o Arduino. Con MicroPython no se usa.

Si `permission denied`, tu usuario no está en el grupo `docker`: `sudo usermod -aG docker $USER` y cerrá sesión.

### 3. `esp-emu` — solo si vas a usar placas ESP32

```bash
curl -fsSL https://raw.githubusercontent.com/espressif/esp-emulator/main/install.sh | sh
```

Queda en `~/.local/bin/esp-emu`. **Verificalo antes de seguir**:

```bash
which esp-emu && esp-emu --version
```

Si `which` no imprime nada, lo tenés que agregar al PATH: `export PATH="$HOME/.local/bin:$PATH"` en tu `.bashrc`.

> Sin esto, cualquier proyecto ESP32 falla al arrancar con `no se pudo conectar al REPL en 15 s`. Es el error más común al instalar en una máquina nueva.

### 4. Dependencias de la app

```bash
cd app
npm install            # instala los 3 workspaces (shared, server, web)
```

### 5. Arrancar

```bash
cd app
npm run dev            # server con tsx watch (la UI la sirve el mismo server)
```

O, sin watch (lo que corre un servicio):

```bash
cd app && npm run build:web && npx tsx server/src/index.ts
```

Abrí **http://127.0.0.1:5180**. Listo.

> **Un solo proceso.** No hay que levantar la UI por separado: el server sirve los estáticos. `npm run dev` corre `dev:server` y `dev:web` juntos. La UI es TypeScript y se compila a `web/dist/` con Vite (React + TypeScript), así que en el modo sin watch hay que compilar una vez con `npm run build:web`. Si se olvida, el server igual levanta y avisa por consola.

### La primera compilación de Arduino tarda

La primera vez que compilés un proyecto Arduino la app construye sola la imagen
`emu-arduino-avr:1.5.1-1.8.6` desde [`docker/arduino-avr/Dockerfile`](docker/arduino-avr/Dockerfile). Tarda **un par de minutos** y llena la consola con el log de Docker paso a paso.

No es un error. Las veces siguientes usan la imagen cacheada y compilan en segundos.

### Si algo no arranca

Todo lo que puede fallar en estos pasos, con su síntoma y su causa:
[`docs/troubleshooting.md`](docs/troubleshooting.md).

La regla más útil: **si la UI falla pero la API responde, el problema es del frontend.**

```bash
curl -s http://127.0.0.1:5180/api/health   # si responde JSON, el server está bien
```

## Exponer en la LAN o en una tailnet

Por defecto el server escucha solo en `127.0.0.1` — nunca en `0.0.0.0` — y
valida `Host`/`Origin` contra una allowlist, para protegerse de DNS rebinding.
El puerto se cambia con `PORT=xxxx`.

Para acceder desde otra máquina de la red hay que cambiar las dos cosas:

```bash
HOST=0.0.0.0 \
EMU_ALLOWED_HOSTS=192.168.1.50:5180,emulador.tail.midominio.com:5180 \
npm run dev
```

`EMU_ALLOWED_HOSTS` es una lista separada porque con `HOST=0.0.0.0` no hay un host
concreto de escucha contra el cual validar. Detalle en
[`docs/troubleshooting.md`](docs/troubleshooting.md).

## Cómo se usa

### 1. Crear un proyecto

En la UI: **Nuevo proyecto** → elegís **placa** y **lenguaje** → la app genera un circuito de prueba (botón → LED). O elegís una **plantilla**: un proyecto de ejemplo completo de [`projects/_template/`](projects/_template/) (por ejemplo `circuito-continuo`).

### 2. Armar el circuito

En el catálogo de la izquierda agregás módulos y los conectás con cables. Cada módulo viene con sus pines, y el editor te avisa si un cable no coincide con un pin, si un pin queda al aire o si el circuito **no puede** funcionar (cortocircuito, fuente sobre demandada — ver la Ley de Ohm real en [`modules/README.md`](modules/README.md)).

Módulos disponibles de fábrica: `arduino-uno`, `esp32-s3-devkitc-1`, `esp32-c3-devkitm-1`, `esp32-c6-devkitc-1`, `button`, `switch`, `led`, `relay`, `resistor`, `fuente-regulable`, `rxb6`, `stx882`, `remote-433`, `door-sensor-433`, `siren-433`, y con chip (I2C/SPI): `bme280-adafruit`, `ds3231-zs042`, `oled-ssd1306-128x64`, `mpu6050-gy521`, `tft-st7735-128x160`.

**Chips por I2C y SPI en el Arduino Uno**: el firmware real (Wire, SPI, las librerías de
Adafruit, RTClib) habla ciclo a ciclo con los chips emulados: BME280 (I2C o SPI), DS3231
con EEPROM AT24C32, OLED SSD1306, MPU-6050 y TFT ST7735. Las imágenes de las pantallas se
ven en el circuito y las librerías se instalan al compilar.

**ESP32 con MicroPython**: los mismos chips se conectan por el puente que reemplaza
`machine.I2C`, `SoftI2C`, `SPI` y `SoftSPI`. Los pines del programa deben coincidir con
los del dibujo. Las transacciones pasan por UART y no reproducen los tiempos del bus
real. ESPHome, ESP-IDF y Arduino en ESP32 todavía no tienen este soporte de chips.
El entorno de los sensores se cambia en vivo desde el panel del módulo. Detalles y
límites: [`chips/README.md`](chips/README.md). Pantallas disponibles y opciones pendientes:
[`docs/pantallas.md`](docs/pantallas.md).

### 3. Escribir el código

Editor con pestañas en el panel central. Para ESPHome, la app **inyecta el componente `sim_bridge`** automáticamente: es el puente que le lleva al firmware los eventos de los pines (qué botón se apretó, qué pin se puso en 1).

### 4. Compilar y ejecutar

- **Build** (Alt+0) — compila con Docker. Los errores llegan con archivo y línea, y los marcás en el editor.
- **Emulador** (Alt+F12) — arranca el firmware real. Los botones del diagrama quedan accionables y la consola muestra UART0/Serial en vivo.

### 5. Editar con el emulador corriendo

El código que corre en el chip es el que estaba al arrancar: editar el archivo no lo
cambia solo. Para llevarle los cambios **no hace falta parar y volver a arrancar**:

- **Recargar** (Ctrl+Shift+F5, o el botón ⟳ de la barra) — lleva el código guardado al chip.
- **Simulación → Recargar al guardar** — lo hace solo cada vez que guardás. Viene activado
  en los proyectos nuevos (es `sim.autoReload` en el `project.json`).

Lo que pasa al recargar depende del lenguaje, igual que en una placa real:

| Lenguaje | Qué hace | Cuánto tarda |
|---|---|---|
| MicroPython | re-sube los archivos por el REPL y hace un *soft reboot* | instantáneo, el emulador no se reinicia |
| ESPHome, ESP-IDF, Arduino | compila y relanza la corrida con el firmware nuevo | lo que tarde Docker + el arranque |

En los compilados el código vive dentro del firmware grabado, así que no hay recarga en
caliente posible: es el mismo rebuild que harías a mano, en un paso. Si tenés
**Recargar al guardar** activado en un proyecto compilado, cada guardado dispara un
build — con los guardados seguidos se agrupan y se compila una sola vez.

El programa **se reinicia desde cero** en los dos casos: la recarga no preserva el estado
del que venía corriendo.

### 6. Debuggear

Pestaña **Debug** (Alt+5): breakpoints, paso a paso, variables, pila de llamadas, y un analizador de pines con los últimos 10 segundos. Habla GDB/RSP por debajo. Detalle por motor en [`docs/depuracion.md`](docs/depuracion.md).

## Placas soportadas

| Placa | Chip / motor | Qué anda de punta a punta | Límites honestos |
|---|---|---|---|
| **ESP32-S3 DevKitC-1** | ESP32-S3 (Xtensa LX7) / `esp-emu` | ESPHome y MicroPython: botón → LED en vivo. RF 433. Certificada "emula". | MicroPython tiene I2C/SPI por el puente. Las entradas llegan por UART, no por el pad (límite de `esp-emu`). ESP-IDF/Arduino sin verificar en esta PC. |
| **ESP32-C3 DevKitM-1** | ESP32-C3 (RISC-V) / `esp-emu` | ídem S3 | Puente en UART1 = GPIO0/1 (reservados). Sin RF 433. |
| **ESP32-C6 DevKitC-1** | ESP32-C6 (RISC-V) / `esp-emu` | ídem S3 | ídem C3, sin RF. |
| **Arduino Uno R3** | ATmega328P 16 MHz / `avr8js` | Compila en ~3 s, corre ciclo a ciclo, D2 → D13 en vivo, entradas al **pad real** (pull-ups, interrupciones). Lógica de 5 V. | I2C y SPI hacia los chips del dibujo (incluida la TFT ST7735). Sin RF, ADC siempre en 0 V; una TFT redibujada entera puede correr más lento que el tiempo real. |

El **ESP32 clásico (LX6)** no se puede emular: `esp-emu` no lo soporta. Para otras familias (RP2040, STM32, nRF52) hace falta un motor nuevo — la interfaz está preparada (`renode` + `platformio` están planificados pero sin implementar), así que esas placas se pueden cargar igual y quedan en "solo dibujo".

## Agregar cosas

**Un módulo nuevo** (sin tocar código) — desde la UI con **+ Importar**, o `POST /api/modules/import`, o la herramienta MCP `importar_modulo`. Acepta carpeta, zip, chip de Wokwi, URL o repo de GitHub. Formato y seguridad en [`modules/README.md`](modules/README.md).

**Una placa nueva** — el ciclo es: `GET /api/boards/schema` (JSON Schema del bloque `board`) → armar el `module.json` → `POST /api/boards/validate` → importar → `POST /api/boards/:id/certify` (compila la plantilla, la emula y comprueba que el botón de prueba prenda el LED). El nivel resultante es `emula` / `compila` / `solo-dibujo`.

**Un motor de emulación o un toolchain** — plugins en `app/server/src/engines/` y `app/server/src/toolchains/`, cada carpeta con su README y la interfaz a implementar.

## Controlarlo con un agente de IA (MCP)

Con la app corriendo, expone MCP en `http://127.0.0.1:5180/mcp`:

```bash
claude mcp add --transport http emulador-esp32 http://127.0.0.1:5180/mcp
```

O abrí Claude Code en esta carpeta: toma [`.mcp.json`](.mcp.json) automáticamente. Solo acepta clientes locales — las páginas de otro origen reciben 403.

Herramientas: `estado`, `listar_proyectos`, `crear_proyecto`, `ver_proyecto`, `leer_archivo`, `escribir_archivo`, `placas`, `esquema_placa`, `validar_placa`, `certificar_placa`, `catalogo`, `importar_modulo`, `quitar_modulo_catalogo`, `agregar_modulo`, `quitar_modulo`, `mover_modulo`, `configurar_modulo`, `conectar`, `desconectar`, `compilar`, `ejecutar`, `parar`, `resetear`, `accionar_modulo`, `poner_pin`, `enviar_rf`, `leer_pines`, `leer_log`, `esperar_log`, `chips`, `mover_entorno`. Más las 7 de debug cuando el depurador está activo.

## Tests

```bash
cd app
npm test               # unitarios (Vitest)
npx playwright test    # e2e, con server y catálogo aislados
E2E_EMU=1 npx playwright test simulacion   # e2e con Docker y emulador reales
npx tsc --noEmit -p server      # typecheck del server (no hay script `typecheck` en package.json)
npm run build:web               # compila la UI: React + TypeScript -> web/dist/app.js (Vite)
npx tsc --noEmit -p web         # typecheck de la UI
```

Los e2e usan `EMU_PROJECTS_DIR` y `EMU_MODULES_DIR` para no tocar tus proyectos reales.

## API

REST en `http://127.0.0.1:5180` (`/api/projects`, `/api/modules`, `/api/boards`, `/api/emulator`, `/api/debug/...`) y WebSocket en `/ws` que empuja `emu.log`, `emu.state`, `bridge.state`, `bridge.ready`, `pin.in`, `pin.out`, `pin.watch`. Detalle en [`GUIA-IMPLEMENTACION.md`](GUIA-IMPLEMENTACION.md) §10.

## Estructura

```
emulador-electronica/
├── app/
│   ├── server/src/       # API, MCP, compilación, emulación, depuración
│   │   ├── engines/      # plugins de motor de emulación (esp-emu, avr8js, renode*)
│   │   ├── toolchains/   # plugins de compilación (esphome, esp-idf, arduino-cli, micropython, platformio*)
│   │   ├── debug/        # depurador GDB/RSP + DAP
│   │   └── fixtures/     # binarios y fuentes de prueba
│   ├── shared/src/       # tipos y schemas compartidos con la UI
│   └── web/              # UI (React + TypeScript -> web/dist/ con Vite; index.html y style.css en la raíz)
├── modules/              # catálogo: <tipo>/module.json + module.svg
├── projects/             # un subdirectorio por simulación (no versionado) + _template/ (plantillas)
├── firmware/components/  # sim_bridge: el puente dentro del firmware
├── firmware/micropython/ # firmware oficial de MicroPython
├── chips/                # chips custom de Wokwi reutilizables
├── docker/arduino-avr/   # imagen de compilación para AVR
└── docs/
```

## Documentación

| Documento | Qué cubre |
|---|---|
| [`docs/vision-y-alcance.md`](docs/vision-y-alcance.md) | Qué es el proyecto, qué falta, límites reales |
| [`GUIA-IMPLEMENTACION.md`](GUIA-IMPLEMENTACION.md) | Diseño técnico: arquitectura, protocolo del puente, pipeline por lenguaje, API |
| [`docs/depuracion.md`](docs/depuracion.md) | Modo debug: qué se puede en cada motor, API REST, DAP |
| [`docs/esp-emulator.md`](docs/esp-emulator.md) | Qué es y qué no es `esp-emu` |
| [`docs/bridge-mode.md`](docs/bridge-mode.md) | Que el ESP32 simulado tenga IP real en tu LAN (Home Assistant lo detecta solo) |
| [`docs/placas-como-datos.md`](docs/placas-como-datos.md) | El bloque `board` en detalle |
| [`docs/custom-chips.md`](docs/custom-chips.md) | Crear un chip de Wokwi reutilizable |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Errores de arranque y sus causas (UI en blanco, REPL, 403 en LAN) |
| [`docs/pantallas.md`](docs/pantallas.md) | Pantallas: la OLED SSD1306 por I2C ya está; qué haría falta para 7 segmentos, LCD y e-paper |
| [`chips/README.md`](chips/README.md) | Chips con lógica (sensores, relojes, pantallas): cómo se escriben, se prueban y qué se aprendió |
| [`modules/README.md`](modules/README.md) | Formato de módulo, importación, Ley de Ohm, seguridad del SVG |

## Wokwi (opcional)

Wokwi es gratuito pero necesita cuenta: creala en [wokwi.com](https://wokwi.com), y para la CLI exportá el token de [wokwi.com/dashboard/ci](https://wokwi.com/dashboard/ci):

```bash
export WOKWI_CLI_TOKEN=tu_token
```

Es la alternativa cuando querés el diagrama visual o un chip custom. El camino principal es `esp-emu`: 100% local, sin cuenta, sin nube. Ver [`docs/bridge-mode.md`](docs/bridge-mode.md) para el modo bridge.
