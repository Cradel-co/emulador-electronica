# Catálogo de módulos

Cada módulo es una carpeta `modules/<tipo>/` con dos archivos:

```
modules/
└── zumbador/
    ├── module.json   # nombre, pines, rol en la simulación, propiedades
    └── module.svg    # el dibujo
```

No hace falta tocar el código de la app para agregar uno: se importa desde la UI (**+ Importar** en el catálogo), por la API (`POST /api/modules/import`) o por MCP (`importar_modulo`). También se puede copiar la carpeta acá y reiniciar el server.

Los módulos **no traen código**: solo describen el dibujo, los pines y cómo se conectan con la simulación. Por eso importar uno de terceros no ejecuta nada. Igual, el SVG se revisa al importar y otra vez antes de dibujarlo (ver [Seguridad](#seguridad)).

## module.json

```json
{
  "type": "zumbador",
  "name": "Zumbador",
  "category": "Salidas",
  "description": "Suena cuando el ESP32 pone su pin en 1.",
  "width": 60,
  "height": 60,
  "pins": [
    { "name": "SIG", "x": 20, "y": 60, "kind": "digital-in" },
    { "name": "GND", "x": 40, "y": 60, "kind": "ground" }
  ],
  "bridge": { "role": "output", "pin": "SIG" },
  "controls": [],
  "props": { "etiqueta": { "type": "string", "default": "BZ", "label": "Rótulo" } }
}
```

| Campo | Qué es |
|---|---|
| `type` | Id del módulo y nombre de la carpeta: `[a-z0-9-]`, hasta 40. |
| `name`, `category`, `description` | Lo que se ve en el catálogo. Las categorías nuevas aparecen solas. |
| `width`, `height` | Tamaño del dibujo, en las mismas unidades que el SVG. |
| `pins` | `name` (único, `[A-Za-z0-9_+-]`), posición `x`,`y` dentro del módulo (normalmente en el borde) y `kind`: `digital-in`, `digital-out`, `digital-io`, `power`, `ground`, `analog-in`, `other`. Los pines los dibuja la app encima del SVG. |
| `bridge` | Cómo participa en la simulación (opcional). `role`: `input` (el módulo maneja un pin del ESP32, como un botón; `activeLevel` 0 o 1), `output` (muestra el nivel de un pin, como un LED), `rf-rx` / `rf-tx` (receptor/transmisor 433 MHz), `air` (inalámbrico, sin cables). `pin`: cuál de sus pines se conecta al ESP32. Sin `bridge`, el módulo se cablea pero es pasivo. |
| `controls` | Qué se puede tocar: `momentary` (mientras se mantiene), `toggle` (alterna), `button`. |
| `props` | Propiedades editables en el panel: `type` `string`/`number`/`boolean`, `default`, `label`, `enum`, `min`, `max`. |
| `vars` | Valores para el SVG que dependen de una propiedad (ver abajo). |
| `passthrough` | Componente de 2 pines "en línea" (como una resistencia): para la lógica digital (qué GPIO prende qué salida) la app lo salta, como si el cable siguiera derecho. Requiere `ohmsProp`. |
| `ohmsProp` | Nombre de la prop (`type: "number"`) que tiene su resistencia en ohms — la usa el chequeo de Ley de Ohm. |
| `diode` | Se comporta como un diodo (LED): cae una tensión fija al conducir en vez de ser lineal como una resistencia. El valor sale de `vars.vf` (ver abajo) o de `diodeVfDefault` (por defecto 2 V). |

Un módulo `programmable` es una **placa** (ESP32, Arduino...): corre el código del proyecto y lleva un bloque `board` con su chip, motor de emulación, toolchains por lenguaje, pines del MCU (`pins`: nombre del dibujo → `gpio`, y `port`/`bit` si el motor es nativo), pines reservados/advertencias, `io` (puente por UART o nativo), niveles eléctricos (`logicVoltage`, `maxPinCurrentMa`, `pinOutputOhm`) y el circuito de prueba (`demo`). El importador acepta placas si ese bloque es válido. Esquema completo: `GET /api/boards/schema`; ejemplos: `esp32-s3-devkitc-1/`, `esp32-c3-devkitm-1/`, `esp32-c6-devkitc-1/`, `arduino-uno/`; motores y toolchains disponibles: `app/server/src/engines/README.md` y `app/server/src/toolchains/README.md`. Cada proyecto corre una sola placa.

### Ley de Ohm real (cortocircuitos y sobrecorriente)

La app arma la red eléctrica del dibujo (cables = 0 Ω, cada `passthrough` con su resistencia, cada `diode` con su caída de tensión y su resistencia interna) y calcula la corriente real de cada camino desde una fuente (3V3, 5V o un GPIO de salida) hasta GND — **I = (V − Vf) / (R_fuente + R_serie)**. La fuente no es ideal: un pin de salida tiene resistencia interna (`board.pinOutputOhm` de la placa: ~33 Ω en los ESP32, ~25 Ω en el ATmega328P) y la tensión en alto es la de la placa (`board.logicVoltage`: 3.3 V o 5 V). Avisa (no bloquea, `#avisos-dibujo` y el MCP):

- **Cortocircuito** — una fuente conectada a GND sin nada de por medio.
- **LED que se quema** — por encima de `electrical.burnCurrentMa` del LED (60 mA en el de fábrica): p. ej. un LED rojo directo a un pin de un Arduino Uno (~75 mA). Es "peligro".
- **LED sobreexigido** — entre `electrical.maxCurrentMa` (20 mA) y el umbral de quemado: p. ej. un LED rojo directo a un GPIO de un ESP32 (~27 mA): brilla de más y dura menos. Es "advertencia".
- **Sobrecorriente en el pin** — más de `board.maxPinCurrentMa` (40 mA en ESP32 y ATmega328P) es "peligro"; más de lo recomendado (20 mA) es "advertencia".

`GET /api/projects/:nombre/pins` devuelve además `electrico.leds: [{ id, mA, estado: "ok" | "sobreexigido" | "se-quema" }]` (con cada pin/fuente en alto).

Si tu módulo es un componente pasivo con resistencia (como la resistencia de fábrica, `modules/resistor/`) o se comporta como un diodo, declará `passthrough`/`ohmsProp` o `diode`/`vars.vf` (y `electrical` con `seriesOhm`, `maxCurrentMa`, `burnCurrentMa`) para que el chequeo lo tenga en cuenta. Sin eso, un módulo importado simplemente no participa del cálculo eléctrico (se cablea igual, pero no suma ni resta corriente).

## module.svg

Un SVG normal con `viewBox="0 0 <width> <height>"`, dibujado con origen en la esquina superior izquierda del módulo. Los textos pueden usar las clases de la app (`txt-mini`, `txt-chico`, `txt-pin`, `claro`, `oscuro`), pero no hace falta.

Para que el dibujo reaccione a la simulación se marcan partes con atributos:

| Atributo | Efecto |
|---|---|
| `data-si="on"` / `data-si="!on"` | La parte se ve solo si el estado vale (o no vale). |
| `data-ctrl="momentary"` / `"toggle"` / `"boton"` (+ `data-indice="0"`) | La parte es un control que se puede tocar durante la simulación. |
| `{{props.etiqueta}}` | Se reemplaza por el valor de la propiedad. |
| `{{vars.claro}}` | Se reemplaza por el valor de `vars` (ver abajo). |

Estados para `data-si`:

| Estado | Cuándo vale |
|---|---|
| `on` | Módulos `output`: el pin conectado está en 1 (LED prendido). |
| `presionado` / `activo` | Módulos `input`: el control está apretado / encendido. |
| `flash` | Parpadeo breve: el módulo transmitió o recibió por radio. |
| `sonando` | Módulos inalámbricos que reaccionan a un código RF (sirena). |
| `boton0` … `boton3` | Controles remotos: ese botón se está apretando. |

`vars` sirve para colores que dependen de una propiedad, como el LED:

```json
"props": { "color": { "type": "string", "default": "red", "enum": ["red", "green"] } },
"vars": {
  "claro": { "prop": "color", "map": { "red": "#ff4d3d", "green": "#4dff7a" }, "default": "#ff4d3d" }
}
```

y en el SVG: `<path data-si="on" fill="{{vars.claro}}" .../>`.

Ejemplos completos: [`led/`](led/), [`button/`](button/), [`remote-433/`](remote-433/).

## Importar

| Desde | Cómo |
|---|---|
| Carpeta | Una carpeta con `module.json` + `module.svg`, o una colección con una subcarpeta por módulo. |
| Zip | Lo mismo, comprimido. Límites: 512 KB por archivo y 8 MB en total. |
| Chip de Wokwi | El `.chip.json` de un [chip custom](https://docs.wokwi.com/chips-api/chip-json). Se importan los pines con un dibujo genérico (pines a los costados, como Wokwi). La lógica del chip (WASM) **no** se ejecuta; se le puede asignar un rol (`input`, `output`, `rf-rx`, `rf-tx`). |
| URL | `https://` a un zip, un `module.json` (su SVG se busca al lado), un `.chip.json`, o un repo de GitHub: `https://github.com/dueño/repo` o `…/tree/rama/carpeta`. |

Una colección puede mezclar módulos y chips de Wokwi. Si uno falla, los demás entran igual y el resultado dice qué pasó con cada uno. **Solo validar** revisa todo sin instalar nada. Los módulos de fábrica no se pueden reemplazar ni quitar; los importados sí, con **Reemplazar** o con la × de su tarjeta. Si se quita un módulo que un circuito usa, el circuito lo muestra como desconocido hasta que se vuelva a importar o se borre.

## Seguridad

El SVG termina dentro de la página, así que al importar se **rechaza** (no se "arregla") si trae:

- elementos fuera de la lista permitida: `<script>`, `<foreignObject>`, `<iframe>`, `<a>`, `<style>`, `<image>`, etc.;
- atributos de eventos (`onclick`, `onload`, …);
- referencias externas: `href` o `url(...)` que no empiecen con `#`, o `javascript:`;
- `DOCTYPE` o entidades XML.

Los elementos permitidos son `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`, `title`, `desc`, `defs`, `linearGradient`, `radialGradient`, `stop`, `clipPath`, `mask`, `pattern`, `use` y `symbol`. Además, el navegador vuelve a filtrar con la misma lista antes de dibujar. Las descargas por URL solo aceptan `https://`, con un máximo de 15 MB y 20 s.
