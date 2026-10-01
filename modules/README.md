# Catálogo de módulos

Cada módulo es una carpeta `modules/<tipo>/`:

```
modules/
└── zumbador/
    ├── module.json   # nombre, pines, rol en la simulación, propiedades
    ├── module.svg    # el dibujo
    └── model.js      # (opcional) su modelo eléctrico: con qué está hecho por dentro
```

No hace falta tocar el código de la app para agregar uno: se importa desde la UI (**+ Importar** en el catálogo), por la API (`POST /api/modules/import`) o por MCP (`importar_modulo`). También se puede copiar la carpeta acá y reiniciar el server.

El código de un módulo (`model.js`) describe su circuito interno con elementos físicos y lo resuelve el motor eléctrico (ngspice): **cómo funciona y cómo escribir uno está en [`../docs/modulos-y-su-codigo.md`](../docs/modulos-y-su-codigo.md)**. Ese código nunca corre en el server: corre en un sandbox aislado, y el importador lo prueba antes de instalarlo. El SVG se revisa al importar y otra vez antes de dibujarlo (ver [Seguridad](#seguridad)).

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
| `ohmsProp` | Nombre de la prop (`type: "number"`) que tiene su resistencia en ohms — con ella el motor eléctrico le arma su resistencia si no tiene `model`. |
| `diode` | Se comporta como un diodo (LED). Su Vf a 20 mA sale de `vars.vf` (ver abajo) o de `diodeVfDefault` (por defecto 2 V). |
| `switch` | Contacto de 2 pines: une sus pines mientras su control está activo (pulsador, llave). |
| `source` | Fuente regulable: `{ voltageProp, currentProp? }` (props con el voltaje y el límite en mA). |
| `electrical` | Datos de hoja de datos: `maxCurrentMa` (recomendado) y `burnCurrentMa` (se quema), para los avisos de LEDs. |
| `model` | Punto de entrada a su código: un `.js` de la carpeta del módulo (ver [Modelo eléctrico](#modelo-eléctrico)). Sin `model`, los flags `passthrough`/`diode`/`switch`/`source` arman uno básico. |
| `chips` | Los chips con lógica que lleva la placa (`chips/<id>/`: sensor, reloj, pantalla). Cada uno: `id`, `pines` (pin del módulo → pin del chip), `porCableado` (props que salen de cómo está cableado un pin: `{ "sdo": { "pin": "SDO", "aTierra": "bajo", "aAlimentacion": "alto" } }`) y `pullUps` (pines del chip con pull-up en la placa). Ver [`../chips/README.md`](../chips/README.md). |
| `drivers` | Librerías que usa el código para este módulo: `{ "arduino": { "librerias": ["RTClib@2.1.4"] } }`. Se instalan solas al compilar un proyecto que lo tenga (el proyecto puede sumar otras en `librerias.txt`). |

Un módulo `programmable` es una **placa** (ESP32, Arduino...): corre el código del proyecto y lleva un bloque `board` con su chip, motor de emulación, toolchains por lenguaje, pines del MCU (`pins`: nombre del dibujo → `gpio`, y `port`/`bit` si el motor es nativo), pines reservados/advertencias, `io` (puente por UART o nativo), niveles eléctricos (`logicVoltage`, `maxPinCurrentMa`, `pinOutputOhm`) y el circuito de prueba (`demo`). El importador acepta placas si ese bloque es válido. Esquema completo: `GET /api/boards/schema`; ejemplos: `esp32-s3-devkitc-1/`, `esp32-c3-devkitm-1/`, `esp32-c6-devkitc-1/`, `arduino-uno/`; motores y toolchains disponibles: `app/server/src/engines/README.md` y `app/server/src/toolchains/README.md`. Cada proyecto corre una sola placa.

### Modelo eléctrico

Todo el circuito (módulos, placa y fuentes) lo resuelve un motor eléctrico real (ngspice): Ohm, Kirchhoff, la curva de los diodos, fuentes con límite de corriente, reguladores, brownout de la placa. Cada módulo aporta su circuito interno:

- con **código** (`"model": "model.js"`): cualquier combinación de resistencias, diodos, fuentes, interruptores, capacitores; sus propias reglas (avisos) y lo que muestra (`ui.on`). Guía completa y SDK: [`../docs/modulos-y-su-codigo.md`](../docs/modulos-y-su-codigo.md); lo que un módulo *muestra* desde su modelo se limita a `ui.on` y `ui.brillo`; una pantalla la dibuja su chip (ver `data-pantalla` abajo y [`../docs/pantallas.md`](../docs/pantallas.md));
- **sin código**: los flags `passthrough` + `ohmsProp`, `diode`, `switch`, `source` le arman un modelo básico;
- sin ninguno de los dos, se cablea igual pero eléctricamente no está.

Los avisos (cortocircuito, LED que se quema o sobreexigido, pin por encima de su corriente, tensión de afuera en un pin, fuente en modo CC, avisos de cada modelo) salen en `#avisos-dibujo`, en Problemas y en el MCP. `GET /api/projects/:nombre/pins` devuelve además `electrico` (LEDs, fuentes, alimentación de la placa, tensión de cada pin y lo que muestra cada módulo). Cómo funciona el motor y qué leyes respeta: [`../docs/motor-electrico.md`](../docs/motor-electrico.md).

## module.svg

Un SVG normal con `viewBox="0 0 <width> <height>"`, dibujado con origen en la esquina superior izquierda del módulo. Los textos pueden usar las clases de la app (`txt-mini`, `txt-chico`, `txt-pin`, `claro`, `oscuro`), pero no hace falta.

Para que el dibujo reaccione a la simulación se marcan partes con atributos:

| Atributo | Efecto |
|---|---|
| `data-si="on"` / `data-si="!on"` | La parte se ve solo si el estado vale (o no vale). |
| `data-ctrl="momentary"` / `"toggle"` / `"boton"` (+ `data-indice="0"`) | La parte es un control que se puede tocar durante la simulación. |
| `{{props.etiqueta}}` | Se reemplaza por el valor de la propiedad. |
| `data-pantalla` | En un `rect`: ahí la app dibuja la imagen que publica el chip del módulo (una pantalla). El SVG del módulo no puede traer imágenes: la pone la app. |
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
| Carpeta | Una carpeta con `module.json` + `module.svg` (+ su `model.js`), o una colección con una subcarpeta por módulo. |
| Zip | Lo mismo, comprimido. Límites: 512 KB por archivo y 8 MB en total. |
| Chip de Wokwi | El `.chip.json` de un [chip custom](https://docs.wokwi.com/chips-api/chip-json). Se importan los pines con un dibujo genérico (pines a los costados, como Wokwi). La lógica del chip (WASM) **no** se ejecuta; se le puede asignar un rol (`input`, `output`, `rf-rx`, `rf-tx`). |
| URL | `https://` a un zip, un `module.json` (su SVG y su modelo se buscan al lado), un `.chip.json`, o un repo de GitHub: `https://github.com/dueño/repo` o `…/tree/rama/carpeta`. |

Una colección puede mezclar módulos y chips de Wokwi. Si uno falla, los demás entran igual y el resultado dice qué pasó con cada uno. **Solo validar** revisa todo sin instalar nada. Los módulos de fábrica no se pueden reemplazar ni quitar; los importados sí, con **Reemplazar** o con la × de su tarjeta. Si se quita un módulo que un circuito usa, el circuito lo muestra como desconocido hasta que se vuelva a importar o se borre.

## Seguridad

El `model.js` corre aislado en un sandbox (sin acceso al server, con tiempo límite, y lo que devuelve se revisa entero); al importar se lo carga y se lo prueba, y si falla no se instala. Detalle en [`../docs/modulos-y-su-codigo.md`](../docs/modulos-y-su-codigo.md#seguridad-por-qué-se-puede-importar-código-de-otros).

El SVG termina dentro de la página, así que al importar se **rechaza** (no se "arregla") si trae:

- elementos fuera de la lista permitida: `<script>`, `<foreignObject>`, `<iframe>`, `<a>`, `<style>`, `<image>`, etc.;
- atributos de eventos (`onclick`, `onload`, …);
- referencias externas: `href` o `url(...)` que no empiecen con `#`, o `javascript:`;
- `DOCTYPE` o entidades XML.

Los elementos permitidos son `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`, `title`, `desc`, `defs`, `linearGradient`, `radialGradient`, `stop`, `clipPath`, `mask`, `pattern`, `use` y `symbol`. Además, el navegador vuelve a filtrar con la misma lista antes de dibujar. Las descargas por URL solo aceptan `https://`, con un máximo de 15 MB y 20 s.
