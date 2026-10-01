# Alimentación: fuentes regulables y energía de la placa

> Pedido del usuario el 2026-09-30: poder poner varios "puntos de energía" en el
> circuito, cada uno con su voltaje (positivo o negativo) y su límite de corriente, ver
> cuánto consumen, y que **la placa no ande sin la energía adecuada** — como en la
> vida real.

## La idea central

Dos cosas que antes no existían:

1. **La Fuente regulable** es un módulo más del catálogo (como la resistencia o el LED),
   no un componente especial del canvas: el canal de una fuente de laboratorio, con
   voltaje y límite de corriente ajustables. Se agregan tantas como se quiera.
2. **La placa ya no está siempre viva.** Antes, sus pines 3V3/5V y sus GPIO entregaban
   tensión siempre. Ahora la placa solo arranca si está enchufada por USB (un
   interruptor de la placa, apagado por defecto) o alimentada por una fuente dentro de
   rango. Con sobretensión se quema.

| Capa | Qué cambió |
|---|---|
| **Catálogo** | `modules/fuente-regulable/` (nuevo). Las 4 placas: prop `usb` y bloque `board.power`. |
| **Schema** (`app/shared`) | `source: { voltageProp, currentProp? }` en `ModuleDefSchema`; `power` en `BoardDescriptorSchema`. |
| **Motor eléctrico** (hoy `sim/`, ver [motor-electrico.md](motor-electrico.md)) | Fuentes de catálogo, tensiones negativas, modo CC, estado de alimentación de la placa. |
| **Server** (`index.ts`) | No arranca sin energía; corta la simulación si se pierde; guarda la placa quemada. |
| **UI** (`app.ts`, `canvas.ts`) | Botón USB, píldora de alimentación, columna "Alimentación" en Debug, placa quemada. |
| **MCP** (`mcp.ts`) | `ver_proyecto` muestra alimentación y fuentes; tool `reemplazar_placa`; `ejecutar` explica por qué no arrancó. |
| **Cableado, canvas genérico** | Nada: la fuente se cablea y se dibuja como cualquier módulo. |

## La fuente regulable

```jsonc
{
  "type": "fuente-regulable",
  "pins": [
    { "name": "V", "x": 0, "y": 30, "kind": "power" },
    { "name": "GND", "x": 90, "y": 30, "kind": "ground" }
  ],
  "props": {
    "voltage": { "type": "number", "default": 5, "label": "Voltaje (V)", "min": -12, "max": 12 },
    "currentLimitMa": { "type": "number", "default": 500, "label": "Límite de corriente (mA)", "min": 1, "max": 5000 }
  },
  // qué props leer como tensión y como límite (análogo a "ohmsProp" de la resistencia)
  "source": { "voltageProp": "voltage", "currentProp": "currentLimitMa" }
}
```

El visor del SVG muestra el voltaje y el límite en vivo (`{{props.voltage}}`,
`{{props.currentLimitMa}}`).

Comportamiento, como una fuente de laboratorio:

- **CV (voltaje constante):** la carga pide menos que el límite → entrega el voltaje
  ajustado y lo que la carga pida.
- **CC (corriente constante):** la carga pediría más que el límite → entrega el límite
  y el voltaje de salida baja. Se aplica **antes** de calcular los LEDs: un LED sin
  resistencia detrás de una fuente limitada a 10 mA lleva 10 mA y no se quema.
- **corto:** su salida cableada directo contra otra tensión (p. ej. contra GND).

La fuente paga todo lo que cuelga de ella: sus ramas propias y, si alimenta la placa,
el consumo típico de la placa más lo que cuelga de los rieles y GPIO de la placa.

**Requisito de cableado:** el GND de la fuente tiene que estar unido al GND de la
placa (referencia común). No hay fuentes flotantes.

## La energía de la placa

Cada placa declara en su descriptor por dónde se la puede alimentar:

```jsonc
"power": {
  "inputs": [
    // min: por debajo no arranca · max: por encima se quema
    // feeds: "vin" = entra a un regulador (VIN del Uno), "5v" = es el riel de 5 V,
    //        "3v3" = directo al riel del chip (el de 5 V queda sin tensión)
    { "pin": "5V", "min": 4.0, "max": 6.0, "feeds": "5v" },
    { "pin": "3V3", "min": 3.0, "max": 3.6, "feeds": "3v3" }
  ],
  "currentMa": 120   // consumo típico andando: lo que le pide a la fuente
}
```

| Placa | Entradas | Consumo típico |
|---|---|---|
| ESP32-S3 DevKitC-1 | 5V: 4,0–6,0 V · 3V3: 3,0–3,6 V | 120 mA |
| ESP32-C3 / C6 | 5V: 4,0–6,0 V · 3V3: 3,0–3,6 V | 90 mA |
| Arduino Uno R3 | VIN: 7–20 V · 5V: 4,5–5,5 V | 50 mA |

Los rangos y consumos son aproximaciones de las hojas de datos (el 3,6 V del ESP32 es
su máximo absoluto de VDD); una placa sin bloque `power` (importada vieja) se asume
siempre alimentada.

Estados (`calcularAlimentacion()` en `app/server/src/sim/analisis.ts`):

| Estado | Cuándo | Qué pasa |
|---|---|---|
| `ok` | USB conectado, o fuente con GND común que mantiene el riel del chip por encima del brownout | Arranca. Si la entrada está por debajo de su mínimo (p. ej. 3,5 V en el pin 5V: el regulador en dropout), arranca igual pero avisa "fuera de especificación". |
| `sin-energia` | Nada conectado, o la fuente llega pero su GND no cierra | No arranca. |
| `baja` | Tensión por debajo del mínimo, o fuente con límite menor al consumo de la placa (entra en CC y cae) | No arranca. |
| `quema` | Tensión por encima del máximo, o polaridad invertida | Se quema: queda muerta hasta "Reemplazar placa", aunque se arregle el cableado. |

Con el motor nuevo la placa es un circuito más (USB, reguladores, el consumo del chip,
diodos de protección de los GPIO; ver [motor-electrico.md](motor-electrico.md#la-placa)):
sus rieles tienen la tensión que realmente queda, y sus GPIO solo manejan corriente con
el chip andando. Si la energía entra por 3V3, el riel de 5 V queda sin tensión (el
regulador no conduce al revés).

## Server

- `runProject()` se niega a arrancar si la placa no está en `ok` o está quemada (UI y
  MCP pasan por ahí). La tool `ejecutar` lo distingue de un error de compilación.
- `revisarAlimentacion()` corre después de cada cambio del dibujo (UI y MCP): si la
  simulación está corriendo y la placa pierde la energía, la corta y lo avisa en la
  consola del emulador.
- La placa quemada vive en memoria del server (`placasQuemadas`): se limpia con
  `POST /api/projects/:name/board/replace` o la tool MCP `reemplazar_placa` (o
  reiniciando el server).
- `GET /api/projects/:name/pins` devuelve `electrico.placa` (estado + mensaje +
  quemada) y `electrico.fuentes` (por fuente: ajuste, límite, salida, mA, W, modo).

## UI

- **Botón USB** en la barra de arriba, al lado de la placa: enchufa/desenchufa.
- **Píldora de alimentación** en la cabecera del circuito: "USB", "fuente1 · 5.00 V ·
  147 mA", "Sin alimentación", "Tensión insuficiente" o "Placa quemada · Reemplazar"
  (click = reemplazar).
- **Ventana Debug → Alimentación:** estado de la placa y una fila por fuente (ajuste,
  salida, consumo, potencia, modo CV/CC).
- Placa quemada: el mismo efecto que un LED quemado (explosión, chamuscado, humo).
- Ejecutar sin energía: no arranca y dice por qué (nota + consola de compilación).

## Circuitos sin código: interruptores y LED por corriente

Pedido después: armar un "circuito continuo" (fuente → pulsador → LED → resistencia →
GND) donde el LED prenda por la corriente que pasa al apretar, sin firmware.

- **Interruptores:** flag `switch: true` en `module.json` (pulsador y llave). Mientras
  su control está activo, el motor eléctrico une sus dos pines como un cable
  (`analizarCircuito(..., cerrados)`). Sirve igual cableado a un GPIO (entrada para el
  código) que en serie con una carga. Un pulsador apretado entre 3V3 y GND es un
  cortocircuito, como en la realidad.
- **Estado de los controles en el server:** `controlesCerrados` (por proyecto), que
  llega desde la UI (`POST /api/projects/:name/controls { id, cerrado }`) y desde el MCP
  (`accionar_modulo`). Se vacía al arrancar o parar la simulación. Un interruptor
  también puede cortar o dar la alimentación de la placa.
- **LED por corriente:** cada LED trae `mAFijo` (corriente desde fuentes que no
  dependen del código: fuente regulable, 3V3/5V de la placa). La UI lo prende si es
  mayor a 0,5 mA, además del caso de siempre (su GPIO en 1). Si la corriente lo quema y
  está prendido, se quema igual que antes.
- **Consumo en vivo:** cuando el firmware cambia un pin, la UI recalcula (agrupado cada
  300 ms) para que el consumo de la fuente incluya lo que manejan los GPIO.

## Plantillas de proyecto: `projects/_template/<id>/`

Cada subcarpeta es un proyecto completo (`project.json` + código + `README.md`); el
título y el primer párrafo del README son el nombre y la descripción que ve la UI. No
aparecen en la lista de proyectos ("_" no es un nombre válido). Crear desde una
plantilla copia la carpeta tal cual con el nombre nuevo (sin archivos ocultos).

- HTTP: `GET /api/templates`; `POST /api/projects { name, template }`.
- MCP: `plantillas`; `crear_proyecto { nombre, plantilla }`.
- UI: selector "Plantilla" en Nuevo proyecto (placa y lenguaje los define la plantilla).
- Primera plantilla: `circuito-continuo` (fuente de 5 V alimentando la placa por 5V y
  un pulsador → LED → 220 Ω → GND; ~14 mA al apretar).
- `.gitignore`: `projects/*` salvo `projects/_template/` — los proyectos de cada uno no
  se versionan, las plantillas sí.

## Proyectos sin placa

Pedido después: "no es necesario usar placa; solo la fuente regulable y componentes, como
en la vida real". Un proyecto puede no tener placa (`board: null`, `language: null`):

- **Crear:** en Nuevo proyecto, la opción "Sin placa (solo circuito)"; por API
  `POST /api/projects { name, board: null }`; por MCP `crear_proyecto` con `sin_placa: true`.
  Trae una fuente de 5 V (100 mA), un pulsador, un LED y una resistencia de 220 Ω ya
  cableados (13,8 mA al apretar).
- **▶ energiza, ⏹ corta:** sin firmware que correr, Ejecutar prende las fuentes
  (`POST /api/projects/:name/energia { encendido }`). Apagado, las fuentes no entregan
  nada (`modo: "apagada"`). Los pulsadores se usan igual que con simulación.
- **La placa es un módulo más:** se agrega eligiendo su lenguaje (botón "Agregar placa" o
  arrastrándola del catálogo; `POST /api/projects/:name/board { board, language }`; MCP
  `agregar_modulo` con `lenguaje`) y se quita con la × (`DELETE /api/projects/:name/board`).
  Al quitarla se borran sus cables.
- **La tierra** es el GND de la primera fuente.

## Estado

- **Hecho:** todo lo de arriba. Desde el motor nuevo los tests están en
  `app/server/src/sim/motor.test.ts` (ver [motor-electrico.md](motor-electrico.md#cómo-se-verificó)).
- **Cambio de comportamiento:** los proyectos existentes y los nuevos arrancan con el
  USB desenchufado; hasta prenderlo (o cablear una fuente) no ejecutan.
- **Resuelto por el motor nuevo** (antes eran límites): mallas genéricas, polaridad de
  los diodos, la tensión exacta en modo CC con varias ramas. Un corto de una fuente contra
  su GND ahora es lo que haría una de laboratorio: entrega su límite con ~0 V (modo
  "corto"); se sigue avisando como cortocircuito porque no alimenta nada útil.
- **Siguiente:** `min`/`max` de las props siguen siendo decorativos (no hay slider ni
  validación de rango); mejora aparte, útil para todos los módulos.
