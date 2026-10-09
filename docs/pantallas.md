# Módulos de pantalla: qué se puede hoy y qué haría falta

> Pedido del usuario el 2026-10-01: "queríamos saber sobre un módulo en específico, y es el
> módulo de pantalla (...) deja documentada cada una de las posibilidades, y sumale la
> e-paper, independientemente la medida, para evaluarlo más adelante".

## Estado actual (2026-10-04)

| Pantalla | Arduino Uno | ESP32 con MicroPython | ESP32 con ESPHome / ESP-IDF / Arduino |
|---|---|---|---|
| OLED SSD1306 128×64 (`oled-ssd1306-128x64`) | I2C emulado por el TWI del ATmega328P | I2C por el puente de `machine.I2C` / `SoftI2C` | Sin soporte de chips hacia el dibujo |
| TFT ST7735 128×160 (`tft-st7735-128x160`) | SPI emulado: D13 SCK, D11 MOSI; CS/DC/RESET en GPIO | SPI por el puente de `machine.SPI` / `SoftSPI` | Sin soporte de chips hacia el dibujo |
| ArduCAM Mini 2MP Plus → TFT ST7735 (`arducam-tft-esp32-s3`) | — | Captura webcam solicitada por firmware, JPEG→RGB565 y TFT por SPI compartido | Solo foto fija; el primer decodificador reduce por promedio de bloque (detalle efectivo ~40×30); hardware físico pendiente |
| 7 segmentos / matriz LED | Pendiente | Pendiente | Pendiente |
| LCD HD44780 | Pendiente | Pendiente | Pendiente |
| E-paper | Pendiente: falta elegir y emular un controlador concreto | Ídem | Además falta soporte del bus hacia el dibujo |

Los controladores viven en `chips/solomon-ssd1306` y `chips/sitronix-st7735`;
la electrónica de cada placa vive en su `model.js`. Publican el framebuffer con
`ctx.publicar`, y la app actualiza una imagen sobre `data-pantalla` sin reconstruir
el circuito. La TFT publica RGB565 y admite las variantes de panel negra/roja/verde.
Los tests versionados comparan las pantallas del Uno con los búferes de las librerías
Adafruit. El soporte y sus límites están en [`../chips/README.md`](../chips/README.md).

En MicroPython los pines del programa deben coincidir con los cables del dibujo.
El puente UART no reproduce los tiempos físicos de una transacción I2C/SPI. En el Uno,
una TFT que redibuja toda la pantalla puede correr más lento que el tiempo real;
ver las mediciones en el README de chips.

Para e-paper ya existen SPI, sandbox de chips y publicación de imágenes. El trabajo
pendiente es el controlador y el módulo concreto, incluyendo BUSY, refresco y persistencia
de la imagen sin alimentación. Para 7 segmentos sigue pendiente la representación de
estado por partes; para LCD, el controlador y su representación visual.

## Análisis original (2026-10-01)

**Las barreras, costos y orden sugerido que siguen describen el estado anterior a los
buses y pantallas implementados.** Se conservan como contexto de diseño; para decidir
el próximo trabajo, usar el estado actual de arriba. B2 ya se resolvió en el Uno y en
ESP32 con MicroPython, B3 con los comportamientos de chip y B4 con el render incremental.
B1 se resolvió para framebuffers mediante la salida del chip, sin ampliar `ui` a partes.

Cuando se escribió, **no había ningún módulo de pantalla** en el catálogo, y no era un olvido: la
plataforma no tenía las piezas para representar una. Este documento explica cuáles faltaban y
compara las cinco formas de resolverlo, para poder decidir con el costo a la vista.

Discusión y seguimiento: [issue #14](https://github.com/Cradel-co/emulador-electronica/issues/14).

## Las cuatro barreras

Cada opción se define por cuáles de estas necesita, así que conviene entenderlas primero.

### B1 — Un módulo solo puede mostrar `on` y `brillo`

El modelo de un módulo le devuelve a la UI únicamente esto:

```ts
ui?: { on?: boolean; brillo?: number }   // app/shared/src/modelo.ts
```

El SVG puede traer partes condicionales con `data-si="on"`, pero todas responden al mismo
flag. Con eso **ni un display de 7 segmentos es representable**: no hay forma de decir
"segmento A prendido, segmento B apagado". `vars` no alcanza, porque depende de las
propiedades editables del módulo y no de su estado en vivo.

Es la barrera más barata de levantar y la que más desbloquea: bastaría que `ui` admitiera
estado por partes (por ejemplo un `partes: Record<string, boolean>` que active
`data-si="<nombre>"`) y, para las pantallas de píxeles, un framebuffer.

### B2 — El puente solo transporta niveles de pin

El protocolo por UART1 es `@IN <pin> <nivel>` / `@OUT <pin> <nivel>`
(`app/shared/src/protocol.ts`). No lleva bytes de bus, y los roles de módulo admitidos son
`input`, `output`, `rf-rx`, `rf-tx` y `air` (`app/shared/src/module.ts`): no existe un rol
de bus.

`PIN_CAPS` incluye `i2c` y `spi`, pero eso es metadata de qué sabe hacer un pin de la placa,
no un bus emulado. En ese momento el Arduino Uno aún no tenía buses hacia los chips del dibujo;
actualmente tiene I2C y SPI.

Del lado del firmware hay que interceptar el bus, y el costo depende del lenguaje:

| Lenguaje | Costo | Por qué |
|---|---|---|
| MicroPython | moderado | Hay precedente: el puente ya reemplaza `machine.Pin` antes de que corra `main.py` (`app/server/src/templates/micropythonBridge.ts`). Parchear `machine.I2C`, `machine.SoftI2C` o `machine.SPI` es el mismo patrón. |
| ESP-IDF y Arduino | alto | Habría que interceptar el driver I2C/SPI desde `sim_bridge` en C++. |
| ESPHome | aparte | Tiene sus propios componentes de display; sería otro camino. |

### B3 — El modelo de un módulo describe circuitos, no lógica digital

`model.js` declara elementos físicos (resistencias, diodos, interruptores, fuentes,
capacitores) y los resuelve [ngspice](motor-electrico.md). Un controlador de display es otra
cosa: una máquina de estados que interpreta comandos. Ver
[modulos-y-su-codigo.md](modulos-y-su-codigo.md).

Hay una parte a favor: **los modelos ya tienen estado interno** que viaja entre pasadas (el
campo `estado` va y vuelve en `circuito`/`observar`), así que el lugar donde guardar un
framebuffer o un cursor ya existe.

Y una en contra: `observar()` se llama **cuando se resuelve el circuito**
(`app/server/src/sim/analisis.ts`), no cuando llega tráfico de datos. El ciclo de vida de un
módulo está atado al análisis eléctrico, y un display necesita reaccionar a bytes: hace falta
otro disparador.

### B4 — El SVG no puede traer imágenes, y el render no soporta refresco

El importador rechaza cualquier `href` que no apunte dentro del mismo SVG
(`app/server/src/moduleImporter.ts`), así que un `<image href="data:image/png;base64,...">`
queda descartado: la salida fácil para pintar un framebuffer no está disponible. Habría que
decidir que el framebuffer lo pinte la app como caso especial (a través de `ui`) y no el SVG
del módulo.

Y el render: hoy cada cambio rearma el árbol SVG completo — unos 8.177 nodos con 300 módulos.
Una pantalla refrescando es el peor caso imaginable, y si los píxeles fueran nodos, una sola
de 128×64 agregaría 8.192 más. **Cualquier pantalla con refresco frecuente necesita el render
incremental hecho antes.**

## Las cinco opciones

| Opción | Bus | Barreras | Esfuerzo | ¿Corre el firmware real? |
|---|---|---|---|---|
| 1. 7 segmentos / matriz LED | ninguno (pines) | B1 | bajo | sí |
| 2. LCD 16x2 (HD44780) | ninguno (pines) | B1 + B3 | medio | sí |
| 3. OLED SSD1306 | I2C | las cuatro | alto | sí |
| 4. E-paper | SPI | las cuatro | alto | sí |
| 5. Pantalla "de simulación" | ninguno | B1 + canal propio | muy bajo | **no** |

### 1. Display de 7 segmentos o matriz LED, por pines

Cada segmento colgado de un GPIO con su resistencia. Es electricidad pura y encaja con la
arquitectura tal como está: el motor ya resuelve los LEDs, la corriente y los avisos de
sobreexigido.

Solo hace falta **B1**, y es la opción con mejor relación entrega/costo. Además es fiel al
espíritu del proyecto: enseña multiplexado, corriente por pin y por qué hace falta una
resistencia por segmento.

La variante con driver (74HC595, MAX7219) requiere además B2/B3, porque el driver habla por
un bus serie.

### 2. LCD 16x2 con HD44780, por pines paralelos

No necesita bus —va por 4 u 8 bits de datos más RS/E—, así que **esquiva B2**, pero requiere
**B3**: un modelo con estado que interprete sus comandos (modo nibble, cursor, DDRAM, la
secuencia de inicialización) y un `ui` capaz de mostrar texto. Al ser 16×2 caracteres y no
píxeles, es más barato que un framebuffer.

Intermedio y pedagógicamente valioso: es el display por el que pasa casi todo el que arranca
con Arduino, y su protocolo es lo bastante simple para modelarlo.

### 3. OLED SSD1306 por I2C

La pantalla típica de los proyectos ESP32 y probablemente la más pedida. Requiere **las
cuatro barreras**: framebuffer en `ui`, tráfico I2C por el puente, el modelo del controlador
(comandos, direccionamiento de página y columna, 128×64 monocromo) y resolver cómo se pinta.

Es un proyecto, no un módulo. Nota de alcance: hacerlo **solo para MicroPython** (parcheando
`machine.I2C`) baja bastante el costo y cubre al público que más lo usaría; en IDF y Arduino
quedaría sin soporte hasta interceptar el driver en C++.

### 4. E-paper por SPI

Independientemente de la medida y del controlador concreto (SSD1680, IL0373 y UC8151 son los
habituales en los Waveshare y Good Display). Requiere las mismas cuatro barreras que el OLED,
con SPI en lugar de I2C.

Tiene dos particularidades que lo vuelven **el mejor candidato para estrenar la
infraestructura**:

- **El refresco es lentísimo**: del orden de segundos para un refresco completo y unas
  décimas para uno parcial. Eso anula B4 como problema de rendimiento — no hay que sostener
  30 fps, se repinta cada varios segundos.
- **La imagen es bistable**: persiste sin alimentación. Se modela con el estado interno que
  ya existe, y es didáctico: el dibujo debería seguir mostrando lo último escrito aunque la
  placa se apague, que es exactamente lo que desconcierta la primera vez.

Detalles de realismo que se pueden simular o ignorar según cuánto se quiera invertir: el
*ghosting* tras refrescos parciales, la diferencia entre refresco completo y parcial, y el
consumo (casi nulo en reposo frente al pico durante el refresco, que sí se podría modelar
eléctricamente y encajaría bien con el motor).

> Los tiempos y comportamientos de arriba son conocimiento general sobre e-paper, correctos
> en orden de magnitud pero **no verificados contra la hoja de datos de un modelo concreto**.
> Antes de implementar hay que fijar controlador y leer su datasheet.

### 5. Pantalla "de simulación" (API de alto nivel)

No emular ningún chip: exponer algo como `simbridge.display.texto("Hola")` y mostrarlo en el
dibujo. Requiere **B1** más un canal en el puente, pero ningún modelo de controlador ni bus.

Es de lejos lo más rápido, y tiene precedente: `simbridge.pin()` ya existe con esa lógica.
Sirve para prototipar la lógica de una aplicación que muestra datos.

**Pero rompe la premisa central del proyecto**: el código no sería portable a hardware real.
Quien escriba contra `simbridge.display` tendría que reescribir para una pantalla de verdad,
y el README promete lo contrario ("antes de comprar un módulo, probalo acá"). Si se hace,
conviene que quede etiquetada como pantalla de simulación y no como un modelo de hardware.
Ver [vision-y-alcance.md](vision-y-alcance.md).

## Qué hay que decidir

1. **¿La pantalla tiene que ser hardware real o alcanza con prototipar?** Si alcanza lo
   segundo, la opción 5 es cuestión de días. Si tiene que ser real, la 1 es el único camino
   barato.
2. **¿Qué lenguajes?** Limitar a MicroPython abarata de forma drástica las opciones 3 y 4.
3. **¿Se levanta B1 sola, primero?** Es útil por sí misma, es chica y es prerrequisito de las
   cinco opciones.

## Orden sugerido, si se avanza

1. **B1**: ampliar `ui` a estado por partes. Chico, y habilita todo lo demás.
2. **Opción 1** (7 segmentos): valida B1 con hardware real y sin bus.
3. **Render incremental**: prerrequisito de cualquier pantalla con refresco.
4. **B2 + B3** solo para MicroPython, y recién ahí elegir entre **opción 3** (OLED) y
   **opción 4** (e-paper). El e-paper es el más cómodo para estrenar la infraestructura,
   porque su refresco lento hace irrelevante el rendimiento del render.
