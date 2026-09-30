# Emulador de electrónica (Wokwi)

Workspace de simulación de hardware **de uso general** — no es parte del proyecto de la alarma, aunque viva dentro de esta carpeta, y no está atado a ESPHome ni a Home Assistant. La idea: antes de comprar un módulo, cargarlo acá y ver cómo funciona junto con el resto del circuito. Hoy emula con precisión real (firmware de verdad en un emulador del chip, no un intérprete) cuatro placas: **ESP32-S3, ESP32-C3 y ESP32-C6** (con `esp-emu`) y **Arduino Uno R3** (ATmega328P, con `avr8js`). Lenguajes: ESPHome, ESP-IDF (C/C++), Arduino y MicroPython, según la placa. Las placas son datos (`modules/<placa>/module.json`, bloque `board`): se pueden sumar otras sin tocar código si su chip ya tiene motor; cada familia nueva (RP2040, STM32...) necesita un motor propio. Ver [`docs/vision-y-alcance.md`](docs/vision-y-alcance.md) para el alcance completo y qué falta.

## Qué se instaló (2026-09-28)

| Herramienta | Qué es | Instalado en |
|---|---|---|
| **[`esp-emu`](https://github.com/espressif/esp-emulator)** (Espressif, beta, gratis pero no open source) | Emulador **100% local** de ESP32-S3/C3/C5/C6/H2/P4 — CPU, WiFi, BLE, RMT, sin ningún servidor externo. Solo terminal, sin interfaz gráfica. **Herramienta principal** de este workspace. En S3 requiere `logger: hardware_uart: UART0` (ver `docs/esp-emulator.md`). | `~/.local/bin/esp-emu`, ya en el `PATH` |
| [`wokwi-cli`](https://github.com/wokwi/wokwi-cli) | CLI para correr simulaciones Wokwi desde la terminal (motor en la nube, gratis) | `~/.wokwi/bin/wokwi-cli` (symlink en `~/bin/wokwi-cli`, ya en el `PATH` vía `~/.bashrc`) |
| Extensión **Wokwi Simulator** para VS Code (`wokwi.wokwi-vscode`) | Simulador visual (diagrama + partes arrastrables) para prototipar cableado rápido | Ya instalada en este VS Code |

Verificar: `esp-emu --version` / `wokwi-cli --version` (en una terminal nueva, o `source ~/.bashrc`).

### Por qué dos herramientas

- **`esp-emu`** es el camino principal: 100% local, sin cuenta, sin nube. Emula ESP32-S3/C3/C6 en la app (el ESP32 clásico no está soportado — ver [`docs/esp-emulator.md`](docs/esp-emulator.md) y la decisión registrada en [`../IDEA.md`](../IDEA.md)).
- **Wokwi** queda como alternativa: útil para armar/ver el cableado visualmente y para chips custom con interfaz gráfica (botones/sliders), a costa de depender de su servidor. Ver `docs/bridge-mode.md` y `docs/custom-chips.md`.

## App gráfica

App web local sobre `esp-emu`: circuito con módulos y cables, editor de código (ESPHome YAML, C/C++ y MicroPython) y simulación interactiva. El diseño completo está en [`GUIA-IMPLEMENTACION.md`](GUIA-IMPLEMENTACION.md).

```bash
cd app && npx tsx server/src/index.ts     # → http://127.0.0.1:5180
```

- **Módulos:** el catálogo vive en [`modules/`](modules/). Se agregan módulos nuevos (carpeta, zip, chip de Wokwi, URL o repo de GitHub) sin tocar código: ver [`modules/README.md`](modules/README.md).
- **MCP:** la app expone un server MCP en `http://127.0.0.1:5180/mcp` que permite controlarla por completo: proyectos, código, circuito, catálogo, compilar/ejecutar y accionar módulos. Todo lo que hace el agente se ve en vivo en la UI. Para usarlo desde Claude Code, con la app corriendo:
  ```bash
  claude mcp add --transport http emulador-esp32 http://127.0.0.1:5180/mcp
  ```
  (o abrir Claude Code en esta carpeta: toma [`.mcp.json`](.mcp.json)). Solo acepta clientes locales: las páginas web de otro origen reciben 403.
- **Tests:** desde `app/`: `npm test` (unitarios), `npx playwright test` (e2e, con un server y un catálogo aislados), `E2E_EMU=1 npx playwright test simulacion` (con Docker y el emulador reales).

## Paso pendiente (manual, no lo puedo hacer yo)

Wokwi es gratuito pero necesita una cuenta:

1. Entrar a la extensión en VS Code (ícono de Wokwi en la barra lateral) o a [wokwi.com](https://wokwi.com) y crear cuenta gratis.
2. Para usar `wokwi-cli` desde la terminal hace falta un token: [wokwi.com/dashboard/ci](https://wokwi.com/dashboard/ci) → copiarlo y exportarlo:
   ```bash
   export WOKWI_CLI_TOKEN=tu_token
   ```
   (agregalo a `~/.bashrc` si lo vas a usar seguido).
3. Para el **modo bridge** (que el ESP32 simulado tenga IP real en tu LAN y lo detecte Home Assistant solo) hace falta `wokwigw`, que se instala aparte — ver `docs/bridge-mode.md`.

## Estructura de esta carpeta

```
emulador-electronica/
├── chips/                # Chips custom REUTILIZABLES entre proyectos (RXB6, STX882, etc.)
├── projects/
│   ├── _template/         # Punto de partida para un proyecto nuevo
│   └── <tu-proyecto>/     # Un subdirectorio por cada simulación
└── docs/                  # Notas y guías (bridge mode, custom chips, etc.)
```

## Cómo arrancar un proyecto nuevo

```bash
cp -r projects/_template projects/mi-proyecto-nuevo
cd projects/mi-proyecto-nuevo
# editar diagram.json (agregar/cablear componentes) y wokwi.toml (apuntar al firmware)
```

- **Desde VS Code**: abrir `diagram.json` del proyecto → botón ▶ (play) en la esquina.
- **Desde terminal** (útil para probar rápido o en CI): `wokwi-cli .` parado en la carpeta del proyecto.

## Chips custom compartidos (`chips/`)

Ahí van los módulos que no existen en la librería de Wokwi y que probablemente reutilices en varios proyectos (ej. el receptor/transmisor 433 MHz del proyecto de la alarma). Cada chip es una carpeta con su `.chip.json` + `.chip.c` (+ `.wasm` compilado). Wokwi busca los archivos de chips **en la carpeta del proyecto**, así que para usar uno de estos en un proyecto nuevo: symlink en vez de copiar, para no desincronizar versiones:

```bash
ln -s ../../chips/rxb6/rxb6.chip.json projects/mi-proyecto/rxb6.chip.json
ln -s ../../chips/rxb6/rxb6.chip.c    projects/mi-proyecto/rxb6.chip.c
```

Ver `docs/custom-chips.md` para cómo crear uno nuevo.

## Referencia de esta carpeta en el proyecto de la alarma

El primer uso real de este workspace es simular el ESP32 + RF de la alarma: ver [`projects/alarma-esp32/`](projects/alarma-esp32/) (se crea cuando armemos ese proyecto puntual) y el diseño general en [`../IDEA.md`](../IDEA.md).
