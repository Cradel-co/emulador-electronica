# Chips con lógica

Un **chip** es la pieza de silicio que habla con el micro por un bus: un sensor, un reloj, una
pantalla, una memoria. Un **módulo** del catálogo (`modules/`) es la placa que se compra: lleva
uno o más chips, su electrónica (regulador, pull-ups, LED) y sus pines. Así, varias placas
comerciales con el mismo chip comparten todo lo difícil: el BME280 de Adafruit y un GY-BME280
usan el mismo `chips/bosch-bme280/`.

Hoy hay un bus emulado: el **I2C del Arduino Uno** (el TWI del ATmega328P en avr8js). El firmware
real (Wire, las librerías de Adafruit, RTClib) le habla al chip ciclo a ciclo, con los tiempos
del bus real. En los ESP32 no se puede todavía: esp-emu no acepta dispositivos I2C propios (ver
[`../SDD-MODULOS.md`](../SDD-MODULOS.md), sección 6).

| Chip | Qué emula | Probado con |
|---|---|---|
| [`bosch-bme280`](bosch-bme280/) | Temperatura, humedad y presión: modos, t_measure, filtro IIR, resolución, ruido, compensación de Bosch invertida | Adafruit_BME280 2.3.0 |
| [`maxim-ds3231`](maxim-ds3231/) | Reloj: hora, alarmas con INT/SQW, temperatura cada 64 s, OSF, aging; con pila, la hora sigue entre ejecuciones | RTClib 2.1.4 |
| [`atmel-at24c32`](atmel-at24c32/) | EEPROM de 4 KB: páginas, t_WR con acknowledge polling; lo grabado queda en el proyecto | Wire a mano |
| [`solomon-ssd1306`](solomon-ssd1306/) | Pantalla OLED 128×64: comandos, modos de direccionamiento, remapeos, COM pins; la imagen se ve en el circuito | Adafruit_SSD1306 2.5.17 (píxel por píxel) |
| [`invensense-mpu6050`](invensense-mpu6050/) | Acelerómetro y giróscopo: escalas, muestreo, DLPF, ruido, errores de fábrica, interrupción de dato listo | Adafruit_MPU6050 2.2.9 |

## Una carpeta por chip

```
chips/<fabricante-chip>/
├── chip.json           # qué es, sus pines, su bus, lo que mide, lo que NO emula
└── comportamiento.js   # su lógica (corre en un sandbox)
```

### chip.json

| Campo | Qué es |
|---|---|
| `id` | `[a-z0-9-]`, hasta 40. Convención: `fabricante-chip`. |
| `nombre`, `fabricante`, `descripcion` | Lo que se ve en la UI y en el MCP. La descripción explica las props que usa el chip. |
| `hojaDeDatos` | **Obligatorio en la práctica**: código y revisión de la hoja en la que se basa. Sin esto no se puede verificar nada. |
| `pines` | Los nombres de la hoja (`INT/SQW` vale). |
| `i2c` | `{ sda, scl, maxHz }`: qué pines son el bus y la velocidad máxima (si el firmware la pasa, se avisa). |
| `entorno` | Lo que mide del mundo: `{ unidad, min, max, default, paso?, etiqueta? }`. La UI arma un control deslizante por magnitud. |
| `comportamiento` | El `.js` de la carpeta. |
| `limitaciones` | **Lo que no se emula, dicho claro.** Se muestra en el panel del módulo ("Qué no se emula") y en el MCP. |

### comportamiento.js

Es una caja negra de eventos. El estado vive en las variables del propio archivo (cada instancia
del chip tiene su sandbox), no hay que devolverlo.

```js
module.exports = {
  encender(ctx) {},                 // alimentación: valores de reset; ctx.ocupadoHasta(t) si no contesta al arrancar
  direcciones(ctx) { return [0x76]; }, // o un arreglo fijo: direcciones: [0x68]
  escribir(ctx, bytes) {},          // un segmento de escritura completo (sin la dirección)
  leer(ctx, n) { return [/* n bytes */]; }, // lectura pedida de antemano (una foto del momento)
  leidos(ctx, n) {},                // cuántos de esos se leyeron de verdad (para el puntero)
  tick(ctx) {},                     // despertador pedido con ctx.despertarEn, o aviso antes de cambiar el entorno
  apagar(ctx) {},                   // se corta la alimentación (se detiene la corrida): guardar lo último
};
```

`ctx`:

| Campo | Qué es |
|---|---|
| `ctx.t`, `ctx.ms` | Instante de la **emulación** (µs, ms). No es el reloj de la PC: si el Uno emulado va más lento, el chip también. |
| `ctx.entorno` | Lo que mide ahora (los valores del `entorno`). |
| `ctx.props` | Props de la instancia del módulo (y las que salen del cableado: SDO a GND → `'bajo'`). |
| `ctx.ocupadoHasta(t)` | No contesta a su dirección hasta `t` (arranque, EEPROM grabando). |
| `ctx.pin(nombre, 0 \| 1 \| null)` | Maneja un pin propio (INT, SQW). `null` = suelto (colector abierto: lo sube el pull-up de la placa si hay). |
| `ctx.despertarEn(t)` | Pide un `tick` en el instante `t`, aunque nadie le hable por el bus (un cambio de segundo, una muestra). |
| `ctx.publicar(obj)` | Algo para mostrar. `{ tipo: 'pantalla', ancho, alto, encendida, brillo, filas: [hex...] }` se dibuja sobre la parte `data-pantalla` del SVG del módulo. |
| `ctx.log(texto)` | Aviso a la consola (algo que no se emula, una configuración rara). |
| `ctx.guardar(datos)`, `ctx.guardado` | Memoria no volátil: lo que graba una EEPROM, la hora de un reloj con pila. Se escribe en `projects/<proyecto>/.chips/<id>.json` y vuelve en `ctx.guardado` al encender la próxima vez (JSON, hasta 64 KB). Borrar esa carpeta = chip nuevo de fábrica. |

`sdk` (global): `u8`, `conSigno(x, bits)`, `sinSigno(x, bits)`, `aBcd`, `deBcd`, `limitar`,
`invertirMonotona(f, objetivo, min, max)` (búsqueda binaria: "qué valor crudo da 22 °C con la
fórmula de la hoja"), `azar(semilla)` (ruido repetible).

### Cómo lo usa el bus

- El bus junta la transacción y llama al chip **una vez por transacción**: lo escrito llega entero
  en `escribir`; una lectura se pide de antemano (32 bytes, el búfer de Wire) y después se avisa
  cuántos se leyeron con `leidos`.
- ACK de la dirección: el chip está alimentado, la dirección es suya y no está ocupado. Los bytes
  escritos siempre tienen ACK.
- Dos chips con la misma dirección contestan los dos: en una lectura gana el 0 (colector abierto),
  y se avisa del conflicto.
- Cada evento tarda en el Uno lo que en el bus real según SCL: 9 períodos por byte.
- Antes de cambiar el entorno, el bus le da al chip un `tick` con el entorno **viejo**: una
  medición que terminó antes del cambio mide lo que había entonces.
- Un chip que tira un error o tarda más de 50 ms queda fuera del bus (deja de contestar) y se avisa.

## Reglas que salieron de hacer estos cinco

1. **Todo con la hoja de datos al lado, y citada.** Cada número del código lleva la sección. Las
   pruebas se escriben contra la hoja, no contra lo que "uno sabe": varias veces el error estaba en
   el test (una cuenta de ruido, un complemento a dos) y la hoja lo resolvió.
2. **Probar con firmware real.** Un maestro virtual sirve para las secuencias de la hoja; las
   librerías reales encuentran lo que uno no pensó. Con Adafruit_BME280, `setSampling(FORCED)`
   justo después de `begin()` deja la humedad en x16 (la hoja, 3.3.1: las escrituras a `ctrl_hum`
   se ignoran mientras hay un cambio de modo pendiente). Es el mismo problema que reporta el
   [issue #40 de la librería de SparkFun](https://github.com/sparkfun/SparkFun_BME280_Arduino_Library/issues/40).
3. **El tiempo de la placa importa.** El BME280 no contesta los primeros 2 ms; el Uno real
   arranca el programa 65 ms después de la alimentación (fusibles LFUSE = 0xFF): por eso la placa
   declara `arranqueMs` y los chips se encienden antes que el micro.
4. **Acotar el trabajo de cada llamada.** El sandbox corta a los 50 ms. Un reloj que revisaba las
   alarmas segundo a segundo después de un hueco de dos días pasaba ese límite bajo carga: se
   miran solo los segundos candidatos según las máscaras.
5. **Los errores reales son parte del chip.** Ruido de las tablas de la hoja, errores de fábrica
   (el giróscopo del MPU-6050 no marca 0 quieto), basura en la RAM de la pantalla al encender. Con
   una prop para apagarlos en los tests (`errores: 'ninguno'`), y con semilla para que sean repetibles.
6. **Decir lo que no se emula.** Cada `limitaciones` es tan importante como el código.
7. **Una placa no es su chip.** La electrónica de la placa (regulador, pull-ups, LED, carga de la
   pila) va en el `model.js` del módulo, sacada de su esquemático: la ZS-042 le mete ~6 mA a la
   CR2032 a 5 V, y eso solo se ve modelando la placa.

## Rendimiento (medido el 2026-10-01, PC sin otra carga)

Segundos emulados por segundo de PC, con firmware real en el Uno (1 = tiempo real):

| Caso | Velocidad |
|---|---|
| Sin chips | 1,69× |
| BME280 leído cada 200 ms | 1,69× |
| MPU-6050 cada 100 ms | 1,70× |
| DS3231 consultado cada 20 ms | 1,67× |
| Pantalla OLED redibujando sin parar a 400 kHz (27 cuadros/s emulados) | 1,23× |

Lo caro de cada llamada al sandbox es su vigilante de tiempo límite (~0,1 ms): por eso el bus llama
una vez por transacción, y la pantalla declara `diferirEscrituras` (sin eso eran 33 llamadas por
cuadro). Con la PC cargada (la suite de tests en paralelo) los números bajan a la mitad.

## Probar un chip

- **Con el maestro virtual** (`app/server/src/bus/maestroVirtual.ts`): `sondear`, `escribir`,
  `leer`, `leerRegistros` y `esperar(ms)` (corre los despertadores en orden). Ver los tests de
  cada chip en `app/server/src/bus/*.test.ts`.
- **Con firmware real**: el sketch va en `app/server/src/fixtures/chips/<nombre>/<nombre>.ino` y
  se compila con `sh app/server/src/fixtures/chips/compilar.sh` (arduino-cli en Docker, librerías
  con versión fija). Los `.hex` se versionan: los tests corren sin Docker.
- `app/server/src/bus/catalogoChips.test.ts` exige que todos los chips de esta carpeta carguen.

## Chips de Wokwi

Los chips custom de Wokwi (`.chip.json` + WASM) se importan como módulo desde la UI, pero su
lógica (WASM) todavía no corre acá: ver [`../modules/README.md`](../modules/README.md#importar).
