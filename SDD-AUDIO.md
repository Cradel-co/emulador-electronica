# SDD — Salida de audio y entrada de micrófono

Diseño de los módulos que **suenan** y de los que **escuchan**. Tres niveles de fidelidad
para la salida, uno para la entrada, y un solo contrato que los une.

Estado: el **caso A está implementado de punta a punta y suena**. Falta solo el control visible
de volumen y silencio (ver sección 11). Los casos B y C siguen siendo diseño. Para usarlo: [docs/audio.md](./docs/audio.md).

## 1. El problema

Un módulo que suena no se puede resolver como un LED. El LED tiene un solo dato — está
prendido o no — y el motor lo calcula con `.op`. Un sonido necesita **frecuencia**, y la
frecuencia no sale del punto de operación: sale de cómo varía la señal en el tiempo, que
es justo lo que el motor no calcula (ver [SDD-MODULOS.md](./SDD-MODULOS.md), sección 7).

La trampa está en querer resolverlo con análisis transitorio. No hace falta, y no
alcanzaría: para reproducir 2 kHz habría que resolver el circuito decenas de miles de
veces por segundo y en tiempo real.

## 2. Principio: el navegador ya tiene el DAC

El emulador **no convierte números en voltaje**. La placa de sonido de la máquina del
usuario ya hace eso. Lo que el emulador tiene que producir es la *descripción* del sonido
—qué frecuencia, con cuánta amplitud, desde qué módulo— y el navegador la sintetiza con
la Web Audio API.

```
firmware emulado → "GPIO5: PWM 440 Hz, duty 50%" → evento de sonido → navegador → suena
motor eléctrico  → "el buzzer tiene 4,8 V y consume 29 mA" → ui.on, avisos, consumo
```

Son **dos caminos separados que no se cruzan**. El motor sigue respondiendo lo de siempre
(¿le llega tensión?, ¿cuánto consume?, ¿se quema?) con `.op` y sin enterarse de que algo
suena. El audio es una salida declarada, no un resultado del solver. El nivel de soporte
del módulo tiene que decirlo con esas palabras: **el tono está declarado, no calculado**.

## 3. Un solo contrato, tres fuentes

Los tres casos de salida difieren únicamente en **de dónde sale la frecuencia**. Todo lo
que viene después —el evento, el transporte, el adaptador del navegador, el control de
volumen— se escribe una sola vez.

### 3.1 `salidas` en module.json

Hoy `salidas` no existe: no está en ningún `module.json` ni en el esquema, solo en el
diseño de [SDD-MODULOS.md](./SDD-MODULOS.md) sección 5.3. Se implementa así:

```json
"salidas": [
  {
    "tipo": "sonido",
    "fuente": "nivel",
    "pin": "IN",
    "hz": 2400,
    "dbA": 85,
    "referencia": { "v": 5, "cm": 10 }
  }
]
```

| Campo | Qué es |
|---|---|
| `fuente` | `nivel` \| `pwm` \| `i2s`. **El único campo que distingue los tres casos.** |
| `pin` | Cuál de sus pines manda el sonido. |
| `hz` | Frecuencia fija de la hoja de datos. Solo con `fuente: "nivel"` (el oscilador es interno). |
| `dbA` | Presión sonora de la hoja de datos, con su `referencia` (tensión y distancia). De ahí sale la ganancia. |

### 3.2 El evento de sonido (server → web)

```ts
export interface EventoSonido {
  modulo: string;            // id de la instancia
  sonando: boolean;
  ganancia: number;          // 0..1, derivada de la tensión o del duty
  hz?: number;               // fuente nivel | pwm
  forma?: 'cuadrada' | 'seno';
  pista?: { archivo: string; ms: number };   // fuente i2s, variante pragmática (6.2)
}
```

Viaja por el WebSocket que ya existe, junto a los demás eventos de simulación. `sonando`
y `ganancia` son suficientes para los tres casos; `hz` y `pista` son los que varían.

## 4. Caso A — nivel de pin (buzzer activo)

**No necesita un solo cambio en el motor ni en el puente.** Es el caso que conviene hacer
primero y entrega sonido real.

Un buzzer activo trae su propio oscilador: si le llega tensión suficiente, suena a una
frecuencia fija de fábrica. El modelo eléctrico ya está escrito y verificado en
`modulos-y-su-codigo.md`: a 5 V consume 30,6 mA y da `on: true`; a 2 V el oscilador no
arranca; a 12 V avisa que se daña.

Lo único que falta es traducir ese `ui.on` más la tensión a un evento de sonido:

- `sonando` ← `ui.on` (el `interruptorControlado` con umbral 2,5 V e histéresis ya existe)
- `hz` ← `salidas[].hz` del `module.json` (dato de hoja de datos, no se calcula)
- `ganancia` ← interpolación de la tensión contra `dbA`/`referencia`

Módulos nuevos: `modules/buzzer-activo/`. **No usar `zumbador`**: ese nombre ya está
tomado como ejemplo canónico del formato en [modules/README.md](./modules/README.md) y
como fixture del importador en `app/tests/e2e/importador.spec.ts`.

Partes reales que entran acá: TMB12A05 (serie TMB12), módulo KY-012, piezos autoexcitados
de la serie Murata PKB.

**Hecho:** `salidas` en el esquema (`app/shared/src/module.ts`), la lógica pura de amplitud
(`app/shared/src/audio.ts`), el módulo `modules/buzzer-activo/` y sus tests contra ngspice
(`app/server/src/sim/buzzerActivo.test.ts`). **Falta** publicar el `EventoSonido` desde el
server y el adaptador del navegador (sección 8).

## 5. Caso B — PWM (buzzer pasivo, melodías)

Un buzzer pasivo no tiene oscilador: la frecuencia la pone el micro. Necesita que el
puente informe el PWM.

### 5.1 Por qué no se puede leer los flancos

El puente **muestrea** los registros de salida GPIO cada `poll_interval` y manda `@OUT`
cuando cambian ([GUIA-IMPLEMENTACION.md](./GUIA-IMPLEMENTACION.md), sección 7). Un tono
de 2 kHz conmuta 4.000 veces por segundo: contra un muestreo así, lo que se recupera es
aliasing, no una onda. Y aunque se pudiera, el protocolo es texto, una línea por mensaje y
máximo 256 bytes: 4.000 líneas por segundo para un solo pin no es una opción.

### 5.2 La solución: declarar el PWM, no transmitirlo

El puente MicroPython ya reemplaza los drivers de `machine` por el suyo para I2C y SPI.
Se hace lo mismo con `machine.PWM`: cuando el código del usuario fija frecuencia y duty,
el puente lo informa una vez, declarativamente.

Protocolo nuevo (firmware → app):

| Mensaje | Significado |
|---|---|
| `@PWM <pin> <hz> <duty>` | Ese pin quedó en PWM. `duty` en 0–1023, como `machine.PWM`. |
| `@PWM <pin> off` | Se liberó el pin (`deinit()`), vuelve a nivel digital. |

Del lado del módulo: `hz` va derecho al evento, y `duty` sale como ganancia por su valor
RMS. El `.op` sigue dando la tensión y el consumo medio.

**Esto no es infraestructura solo de audio.** El mismo `@PWM` habilita el brillo de un LED
por PWM y, más adelante, el ángulo de un servo. Conviene diseñarlo pensando en esos tres
consumidores, no solo en el buzzer.

**Pendiente de decidir antes de implementarlo:** `@PWM <pin> ...` asume que el PWM sale de un
GPIO de la placa. Un expansor como el PCA9685 (16 canales por I2C, con su propio reloj) no
funciona así: recibe órdenes por I2C y genera el PWM en salidas propias, que no son pines del
ESP32. Si ese chip va a entrar algún día al catálogo, el mensaje tiene que direccionar la
salida y no el pin — algo como `@PWM <origen> <canal> <hz> <duty>`, donde el origen puede ser
la placa o un chip del bus. Conviene resolverlo ahora que el protocolo todavía no existe.

### 5.3 Límite por lenguaje

El puente de MicroPython reemplaza drivers; en C/C++ (ESP-IDF, Arduino-ESP32) todavía no
hay puente y las entradas no llegan al código. Así que el caso B arranca **solo en
MicroPython**, y el nivel de soporte del módulo lo tiene que decir. En ESPHome el camino
equivalente es transformar `output` con `platform: ledc`.

Partes reales: TDK PS1240P02BT, módulo KY-006, Murata serie PKM.

## 6. Caso C — I2S (DAC externo y parlante)

El más caro y el que menos valor educativo agrega. Conviene dejarlo último y, cuando se
haga, empezar por la variante pragmática.

### 6.1 El problema de fondo

Ninguna de las tres placas del repo (C3, C6, S3) tiene DAC interno: Espressif lo sacó
después del ESP32 clásico y el S2. Entonces el audio analógico sale obligatoriamente por
I2S hacia un chip externo (MAX98357A, PCM5102A, UDA1334A), y el puente hoy tiene I2C y
SPI pero **no I2S**.

Y el protocolo no da: ASCII, una línea por mensaje, 256 bytes. Audio mono de 16 bits a
8 kHz son 16 KB/s; en base64, 21,3 KB/s, que son unas 120 líneas por segundo de carga
útil llena, para la calidad más pobre que se puede aceptar. Transmitir muestras por ese
canal exige extenderlo con tramas binarias y contrapresión explícita.

### 6.2 La variante pragmática: informar la pista, no las muestras

Casi todo proyecto real de audio en ESP32 reproduce **un archivo** (un WAV en flash, un
MP3 en una SD), no muestras generadas al vuelo. Para esos casos no hace falta mover
muestras: alcanza con que el puente informe *qué archivo se está reproduciendo y desde
qué posición*, y que el navegador lo reproduzca desde el sistema de archivos del proyecto.
De ahí el campo `pista` del evento.

Eso cubre entero el **DFPlayer Mini** (DFRobot DFR0299), que además es un módulo con
micro propio: su "audio" literalmente es un número de pista por UART. Es el mejor primer
módulo de este caso, y no necesita I2S en absoluto.

El streaming de muestras crudas queda fuera de alcance hasta que exista una necesidad
concreta.

## 7. Entrada: micrófono

No comparte nada con lo anterior: un micrófono es un **sensor analógico**, lo lee el ADC y
el DAC no participa.

Con el ADC con perfiles del PR #54 mergeado, un micrófono analógico es un módulo de
catálogo sin infraestructura nueva. El candidato más limpio es el **DFRobot SEN0232**:
entrega dB linealmente en 0,6–2,6 V, con error declarado (±1,5 dB), respuesta de
31,5 Hz–8,5 kHz y constante de 125 ms. Son todos números de hoja de datos: el modelo no
inventa nada.

Lo que falta ahí es menor pero real: `entorno` hoy existe a nivel de **chip**
(`chips/*/chip.json`: BME280, MPU6050, DS3231), no a nivel de módulo. Un micrófono sin
chip necesita que `entorno` se soporte también en el `module.json`, o bien declararlo como
chip. Decidirlo antes de escribir el módulo.

Partes reales: SEN0232, MAX4466 (Adafruit #1063), MAX9814 (Adafruit #1713), KY-038/KY-037.
Los MEMS digitales (INMP441, SPH0645LM4H) dependen de I2S y quedan con el caso C.

## 8. El adaptador del navegador

Por el criterio permanente del producto ([arquitectura-web.md](./docs/arquitectura-web.md#componentes-propios-y-adaptadores)),
la Web Audio API se integra por un adaptador y su estado no se propaga por la app.

Se sigue el patrón ya probado de `camera.ts`: un controlador con sus dependencias
inyectadas, que se testea con dobles sin tocar el navegador.

- `app/web/audio.ts` — `ControladorAudio` con `Dependencias` inyectables (la fábrica del
  `AudioContext`). Es **el único archivo que toca la Web Audio API**.
- La lógica pura —tensión → ganancia, duty → ganancia RMS, nota → Hz— va aparte y con
  tests en `app/tests/unit/`, sin DOM ni estado global.
- El `AudioContext` solo se puede crear tras un gesto del usuario (política de autoplay de
  los navegadores): hace falta un control explícito de "habilitar sonido", con su estado
  visible, y un control de volumen y silencio global.

## 9. Qué no se puede (y hay que decirlo)

- **El tono está declarado, no calculado.** Sale de la hoja de datos o del PWM que informa
  el firmware, no del motor. Sin análisis transitorio no hay otra opción honesta.
- **No hay audio por flancos de GPIO**: el puente muestrea, y el muestreo aliasa.
- **Caso B solo en MicroPython** hasta que C/C++ tenga puente.
- **No hay DAC interno en C3/C6/S3**: no existe un camino analógico directo que modelar.
- **Soporte de PDM RX sin verificar** por chip: el S3 lo tiene; en C3/C6 hay que
  confirmarlo en el TRM antes de prometer un micrófono PDM.
- **Nada de esto es medición de laboratorio.** Los dB son los de la hoja de datos a su
  distancia de referencia, no una simulación acústica.

## 10. Plan de tests (TDD)

Primero el test que falla por la razón correcta, como pide
[CLAUDE.md](./CLAUDE.md) para cambios de física.

| Nivel | Qué verifica |
|---|---|
| Unitario (puro) | Tensión → ganancia contra los puntos de la hoja de datos; por debajo del umbral, silencio; duty → ganancia RMS; histéresis sin oscilación en el borde. |
| Unitario (adaptador) | `ControladorAudio` con dobles: un evento `sonando: false` corta; cambiar `hz` no recrea el grafo; sin gesto previo no se crea el `AudioContext`. |
| Motor | Caracterización del buzzer activo: a 5 V, 30,6 mA y `on: true`; a 2 V no arranca; a 12 V avisa. Son los números ya verificados en la doc. |
| Protocolo | `@PWM` bien formado actualiza el pin; mal formado responde `@ERR` sin tirar el puente; `@PWM <pin> off` vuelve a nivel digital. |
| e2e | Habilitar sonido y correr un proyecto con el buzzer: se verifica que el adaptador recibió la especificación, no que haya sonado. |

## 11. Orden de implementación

0. **Mergear el PR #54** (`fix/fidelidad-fisica`). Toca `sim/`, `pinScan`, `emulator` e
   `index.ts`, y trae el ADC con perfiles. Cualquier trabajo de audio antes de eso choca
   de frente.
1. **Caso A completo**: contrato `salidas.sonido`, `modules/buzzer-activo/`, adaptador del
   navegador. Es el único que entrega sonido sin tocar motor ni puente.
   - ✅ contrato, lógica de amplitud, módulo y tests contra el motor.
   - ✅ publicar el `EventoSonido` desde el server, en la instantánea de `/pins`.
   - ✅ cablearlo en `app.ts` y habilitar el audio en el click de ▶.
   - ✅ `app/web/audio.ts` con el `ControladorAudio` y la Web Audio API detrás de un puerto
     propio, con sus tests sin navegador.
   - ⬜ el control visible de volumen y silencio (el controlador ya los tiene; falta la UI, que
     toca `index.html`, `react/montar.ts` y `react/puente.ts`: archivos del PR #55).
2. **Micrófono analógico** (SEN0232), resolviendo antes `entorno` a nivel de módulo.
3. **Caso B**: `@PWM` en el puente MicroPython, diseñado también para brillo de LED y
   servo. Después, `modules/buzzer-pasivo/`.
4. **Caso C solo si aparece la necesidad**, y en este orden: DFPlayer Mini por `pista`
   primero; streaming de muestras por I2S al final, o nunca.

## Documentos relacionados

- [docs/audio.md](./docs/audio.md) — cómo se usa: declarar una salida de sonido y qué hay hecho.
- [SDD-MODULOS.md](./SDD-MODULOS.md) — sección 5.3 (`salidas`) y sección 7 (límites).
- [docs/modulos-y-su-codigo.md](./docs/modulos-y-su-codigo.md) — SDK del `model.js` y el
  ejemplo del buzzer activo ya verificado.
- [GUIA-IMPLEMENTACION.md](./GUIA-IMPLEMENTACION.md) — sección 7, protocolo del puente.
- [docs/arquitectura-web.md](./docs/arquitectura-web.md) — componentes propios y adaptadores.
