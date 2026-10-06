# Audio: módulos que suenan

Cómo funciona el sonido en el emulador, qué hay implementado y cómo se agrega un módulo que
suene. El *por qué* de cada decisión está en [SDD-AUDIO.md](../SDD-AUDIO.md).

## El principio: el DAC lo pone tu placa de sonido

El emulador **no convierte números en voltaje**. Eso ya lo hace el hardware de audio de la
máquina. Lo que el emulador produce es la *descripción* del sonido —qué frecuencia, con cuánta
amplitud, desde qué módulo— y el navegador la sintetiza con la Web Audio API.

```
motor (.op) → tensión entre los pines del buzzer → sonidosDelCircuito → electrico.sonidos
           → /api/projects/<p>/pins → app.ts → ControladorAudio → Web Audio → suena
```

El sonido viaja en la **misma instantánea** que el `ui` de cada módulo, no en un evento aparte:
salen del mismo cálculo, así que llegan juntos.

Son dos caminos que no se cruzan. El motor eléctrico sigue contestando lo de siempre con `.op`
(¿le llega tensión?, ¿cuánto consume?, ¿se quema?) sin enterarse de que algo suena.

**La frecuencia no la calcula el motor.** Sin análisis transitorio no hay forma: para reproducir
2 kHz habría que resolver el circuito decenas de miles de veces por segundo. Así que la
frecuencia se **declara**, y de dónde sale es lo único que distingue los tres casos.

| `fuente` | De dónde sale la frecuencia | Ejemplo | Estado |
|---|---|---|---|
| `nivel` | De la hoja de datos: el componente trae su oscilador | Buzzer activo (TMB12A05) | **implementado** (sin reproducir todavía) |
| `pwm` | La pone el micro y la declara el puente | Buzzer pasivo, piezo | **implementado** |
| `i2s` | Un flujo de muestras hacia un DAC externo | MAX98357A, DFPlayer | falta I2S en el puente |

## Declarar una salida de sonido

En el `module.json` del módulo:

```json
"salidas": [
  {
    "tipo": "sonido",
    "fuente": "nivel",
    "pins": ["IN", "GND"],
    "hz": 2400,
    "umbralV": 2.5,
    "dbA": 85,
    "referencia": { "v": 5, "cm": 10 },
    "forma": "cuadrada"
  }
]
```

| Campo | Qué es |
|---|---|
| `fuente` | `nivel`, `pwm` o `i2s` (ver la tabla de arriba). |
| `pins` | Entre qué dos pines se mide la tensión que lo alimenta, el `+` primero. |
| `hz` | Frecuencia de la hoja de datos. Solo con `fuente: "nivel"`. |
| `umbralV` | Tensión mínima a la que arranca el oscilador. Por debajo **no suena**: no suena flojo. |
| `dbA` + `referencia` | Presión sonora de la hoja de datos, con la tensión y la distancia a las que se midió. De ahí sale la amplitud. |
| `forma` | `cuadrada` o `seno`. Un buzzer es cuadrada. |

Todos los campos menos `tipo`, `fuente` y `pins` son opcionales, y la ausencia de cada uno
tiene un significado explícito: sin `umbralV`, cualquier tensión positiva lo hace sonar; sin
`referencia`, no se inventa una curva de volumen y suena a amplitud plena.

## El tono por PWM (`fuente: "pwm"`)

Un buzzer **pasivo** no tiene oscilador: la frecuencia la pone el micro. Eso es lo que permite
tocar notas, y lo que un buzzer activo no puede hacer.

**El tono se declara, no se mide.** El puente muestrea los registros de salida del GPIO, así que
un tono de cientos o miles de hertz se perdería en el aliasing si se intentara reconstruir de los
flancos. El shim de MicroPython reemplaza `machine.PWM` y avisa una vez por cambio:

```
@PWM <gpio> <hz> <duty_u16> <ticks>     frecuencia y ciclo de trabajo nuevos
@PWM <gpio> off 0 <ticks>               el programa liberó el pin (deinit)
```

Del lado del server lo recibe [`pwmEsp.ts`](../app/server/src/pwmEsp.ts), que guarda el estado por
GPIO. El sonido lo pide por **pin del módulo**, así que `index.ts` resuelve el cableado con
`gpioDe` (que además sigue los `passthrough`).

La consecuencia a tener en cuenta: **el PWM que no pase por `machine.PWM` no se oye.** Prender y
apagar un pin a mano en un bucle no produce sonido, porque nadie declara una frecuencia.

### El volumen con PWM: de dónde sale el sen(π·duty)

Dos factores: la tensión, igual que en `fuente: "nivel"`, y el ciclo de trabajo. El segundo no es
una curva elegida a dedo — sale de la **serie de Fourier** de la señal que el micro genera.

Una onda cuadrada **no es un tono puro**. La serie de Fourier dice que cualquier señal periódica
es una suma de senos: uno a la frecuencia base (el **fundamental**) más otros a 2×, 3×, 4× esa
frecuencia (los **armónicos**). Para un pulso que va de 0 a V con ciclo de trabajo *d*, la
amplitud del fundamental es:

```
a₁ = (2V/π) · sen(π·d)
```

De ahí el factor. Se usa el fundamental y no toda la señal por dos razones que se suman: **el oído
toma el fundamental como la nota** (los armónicos cambian el timbre, no la altura), y **un piezo es
resonante**, así que responde cerca de su frecuencia propia y filtra buena parte de los armónicos.

Tres consecuencias que se ven en el emulador:

| Lo que dice la fórmula | Lo que pasa |
|---|---|
| `sen(π·0,5) = 1` | el 50 % es el volumen máximo: la cuadrada simétrica pone la mayor energía en el fundamental |
| `sen(0) = sen(π) = 0` | con duty 0 % o 100 % la señal es **continua**: no hay oscilación, el piezo no mueve aire y **no suena** |
| `sen(π(1−d)) = sen(π·d)` | es **simétrica**: 25 % y 75 % suenan igual, y 5 % y 95 % también |

La simetría tiene explicación física: un pulso del 25 % y uno del 75 % son la misma forma de onda
invertida — mismo fundamental, fase opuesta, y el oído no distingue la fase.

Medido con el firmware corriendo, a 440 Hz:

| duty | sen(π·duty) | Ganancia | dBA |
|---|---|---|---|
| 5 % | 0,156 | 0,156 | 54,7 |
| 25 % | 0,707 | 0,707 | 67,8 |
| 50 % | 1,000 | 1,000 | 70,8 |
| 75 % | 0,707 | 0,707 | 67,8 |
| 95 % | 0,156 | 0,156 | 54,7 |
| 100 % | 0 | — | no suena |

Al 25 % se pierden 3 dB, que es `20·log10(0,707)`.

**Lo que NO se modela: el timbre.** Los armónicos existen en la señal real y cambian cómo suena la
nota — una cuadrada al 10 % se oye más delgada y nasal que una al 50 %. El navegador sintetiza
siempre una cuadrada simétrica y solo le ajusta la ganancia, así que bajar el duty se oye como
**lo mismo más bajo**, no como otro timbre. Modelarlo pediría generar la forma de onda con su duty
real (un `PeriodicWave` de Web Audio), y no está hecho.

### Dos cosas del ritmo

**El emulador no corre en tiempo real.** Una melodía va a sonar irregular, y no es un error:
medido sobre la plantilla, un `sleep_ms(220)` se convierte en entre 35 y 1517 ms de reloj de pared
(mediana ~250). El tono sigue fielmente al programa; el reloj no. Lo que agrega el emulador en
avisar y recalcular son 9 a 41 ms, despreciable al lado de eso.

**Conviene un solo cambio por nota.** `freq()` y `duty_u16()` avisan por separado, y entre los dos
el pin queda con la frecuencia nueva y el duty viejo — saliendo de un silencio, eso es un instante
de silencio en cada nota. `init(freq=..., duty_u16=...)` lo hace en un solo aviso.

### El módulo que ya está: `buzzer-pasivo`

Un disco piezoeléctrico (PS1240P02BT y equivalentes). Eléctricamente **es un capacitor**: en
continua no conduce, así que no carga el pin que lo maneja — por eso consume casi nada al lado de
un buzzer activo. La plantilla
[`melodia-con-buzzer-pasivo`](../projects/_template/melodia-con-buzzer-pasivo/) toca una escala.

**Lo que no modela:** la resonancia mecánica (uno real suena mucho más fuerte cerca de sus 4 kHz
que en las notas graves, y acá el volumen no depende de la frecuencia), la impedancia que cambia
con la frecuencia, ni la caja o el soporte.

## Quién decide si suena

El **modelo del módulo**, no el `umbralV` declarado. Si `observar` devolvió `ui.on`, ese veredicto
manda y la tensión queda solo para la amplitud; `umbralV` es el respaldo para un módulo sin
modelo.

Tiene que ser así porque el umbral real vive en el modelo, con su histéresis, y además ve la
corriente. Declararlo dos veces los hacía discrepar: en la plantilla
`volumen-con-potenciometro`, a 2,44 V el modelo conducía y el sonido decía silencio, y a 2,50 V
al revés — el módulo prendía su dibujo y se quedaba callado.

## De la tensión a la amplitud

La presión sonora es proporcional a la tensión, así que la amplitud también. La regla que usa
[`app/shared/src/audio.ts`](../app/shared/src/audio.ts):

- **ganancia** = `v / referencia.v`, recortada en 1. Por encima de su tensión nominal un buzzer
  distorsiona y se daña; no suena proporcionalmente más fuerte. Avisar de eso es tarea del
  `model.js`, no de la ganancia.
- **dBA estimado** = `dbA + 20·log10(v / referencia.v)`. Esto **no** se recorta: es un dato que
  se informa, no una señal que se reproduce. La mitad de tensión son 6 dB menos.

## El módulo que ya existe: `buzzer-activo`

Un buzzer activo de 5 V (TMB12A05 y compatibles): dos patas, oscilador propio, zumba con solo
recibir tensión. Es el caso más simple del mercado y el único que no necesita nada del motor ni
del puente.

Su [`model.js`](../modules/buzzer-activo/model.js) solo resuelve lo eléctrico — un
`interruptorControlado` con umbral de 2,5 V (el oscilador) y la resistencia equivalente de los
30 mA a 5 V (lo que consume zumbando). La frecuencia no está ahí: está en `salidas`.

Verificado contra ngspice en `app/server/src/sim/buzzerActivo.test.ts`:

| Tensión | Qué pasa |
|---|---|
| 5 V | arranca, consume ~30 mA, ganancia 1, 85 dBA |
| 3 V | zumba con ganancia ~0,6 y menos de 81 dBA |
| 2 V | el oscilador no arranca: silencio y consumo < 0,1 mA |
| 12 V | avisa que se daña (máximo 6 V) |
| al revés | no zumba y lo avisa |

## Probarlo

La plantilla [`volumen-con-potenciometro`](../projects/_template/volumen-con-potenciometro/) trae
el circuito armado: fuente regulable, potenciómetro como divisor y buzzer. Girando el cursor el
zumbido baja, y su README tiene la tabla de tensión, consumo y dBA en cada posición, medida con el
motor.

## Qué tan "real" es esta emulación

"Emulación real" puede querer decir tres cosas distintas, y las respuestas son muy diferentes.
Conviene tenerlas separadas para no prometer lo que no se puede.

### 1. Tiempo real: que `sleep_ms(220)` tarde 220 ms — **no se puede**

`esp-emu` (v0.45.0) **no tiene ninguna opción de tiempo real ni de throttling**. Sus opciones son
chip, firmware, red, UART, GDB, trazas, strap, PSRAM y poco más; nada de reloj.

Y hay una razón de fondo que no depende de la herramienta: **el throttling solo sirve para frenar
un emulador que va más rápido que la realidad.** El nuestro va más lento — mediana de 250 ms contra
220 pedidos. No hay nada que frenar; habría que acelerarlo primero.

Emular un micro en tiempo real pide virtualización asistida por hardware (no aplica: RISC-V sobre
x86) o un emulador bastante más rápido. Está fuera de alcance.

**El único margen conocido:** la opción `--batch-size` (50.000 instrucciones por iteración, por
defecto) que hoy no se pasa. Un lote más chico entrelaza más fino y **podría achicar los picos** a
cambio de throughput. No convierte nada en tiempo real, y no está medido.

### 2. La forma de onda: el timbre — **sí se puede**

Ver [El volumen con PWM](#el-volumen-con-pwm-de-dónde-sale-el-senπduty). Reproducir la onda con su
ciclo de trabajo real, en vez de una cuadrada simétrica con la ganancia ajustada, está al alcance
con `PeriodicWave` de Web Audio a partir de los coeficientes de Fourier del pulso.

### 3. Audio desde el solver: análisis transitorio — **no, por tres órdenes de magnitud**

Sería lo más puro: resolver el circuito en el tiempo y sacar las muestras de ahí. Pero el audio
pide unas 44.100 muestras por segundo y cada resolución de ngspice tarda 10–30 ms. Falta un factor
de mil, y no es un problema de optimización sino de qué clase de herramienta es un solver de
circuitos.

### Lo que sí está medido

| | |
|---|---|
| Lo que pide el programa | 220 ms por nota |
| Mediana real | ~250 ms |
| Mínimo / máximo | 35 ms / 1517 ms |
| Latencia de avisar el cambio y recalcular | 9–41 ms |

La tubería del audio aporta menos del 10 % de ese jitter: **no hay nada que optimizar ahí**. Y
"arreglar" el ritmo compensándolo sería mentir sobre la emulación — el tono tiene que seguir a lo
que el programa hace, no a lo que uno quisiera que hiciera.

## Lo que falta (y hay que decirlo)

- **Falta el control de volumen y silencio.** El `ControladorAudio` ya los implementa
  (`silenciar()`, `cambiarVolumen()`), pero no hay nada visible que los toque: el volumen queda
  en el 0,5 inicial. Hacerlo tocaría `index.html`, `react/montar.ts` y `react/puente.ts`.
- **El tono está declarado, no calculado.** Sale de la hoja de datos o del PWM que informa el
  firmware, no del motor.
- **No hay audio por flancos de GPIO**: el puente muestrea los registros de salida, y el muestreo
  aliasa. Por eso el PWM se declara con `machine.PWM`, y un bucle que prenda y apague un pin a
  mano no suena.
- **Ninguna de las placas del repo (C3, C6, S3) tiene DAC interno.** Espressif lo sacó después
  del ESP32 clásico. El audio analógico de salida obliga a un chip externo por I2S.
- **Un buzzer activo no se desvanece: se corta.** Por debajo de su umbral el oscilador no
  arranca, así que el volumen baja hasta ahí y el zumbido desaparece de golpe.
- **Hay circuitos sin punto de operación.** Con el buzzer justo en el filo de su umbral y
  cargando el divisor que lo alimenta, el estado se vuelve inestable (conduce → baja la tensión →
  deja de conducir → sube) y el motor no converge: la app avisa que no hay solución. Es físico,
  no un error de cálculo; un buzzer real ahí castañetea.
- **El `AudioContext` necesita un gesto del usuario** (política de autoplay). Se habilita en el
  click de ▶: es el gesto que el navegador exige y el momento en que el usuario espera que el
  circuito empiece a funcionar. Lo que ya venía zumbando arranca ahí.

## Entrada: micrófono

No comparte nada con lo anterior. Un micrófono es un sensor analógico: lo lee el ADC y el DAC no
participa — no hay ningún evento de sonido, ni la app sintetiza nada. Ver la sección 7 del
[SDD](../SDD-AUDIO.md).

### El que ya está: `sonometro-sen0232`

El **Gravity: Analog Sound Level Meter** de DFRobot. Entrega el nivel de sonido como una tensión
lineal en decibeles, que es lo que lo hace el más limpio de modelar: todos sus números salen de
la hoja de datos y ninguno hay que inventarlo.

| Dato de la hoja | Valor |
|---|---|
| Rango | 30 a 130 dBA (±1,5 dB) |
| Salida | 0,6 a 2,6 V, lineal → **20 mV por decibel** |
| Alimentación | 3,3 a 5 V |
| Consumo | 14 mA a 5 V, 22 mA a 3,3 V |
| Respuesta | 31,5 Hz a 8,5 kHz, constante de 125 ms |

El nivel del ambiente se pone en la prop **Nivel de sonido del ambiente (dBA)**, igual que la
posición de un potenciómetro. No hay simulación acústica: es un dato de la escena.

**La salida se modela con un `regulador`, no con una `fuenteTension`.** Así la energía que entrega
sale de su VCC en vez de aparecer de la nada, y si la alimentación no alcanza, el fondo de escala
cae solo: a 2,5 V de alimentación ya no puede sostener los 2,6 V de salida.

Cableado a un GPIO con ADC1 (en el S3, del 1 al 10) su tensión llega al canal del ADC y se lee
desde el código. Ese camino es el del PR #54 y está verificado en
`app/server/src/sim/sen0232.test.ts`.

**Lo que no modela**, dicho en el propio modelo: la ponderación A real, la constante de tiempo de
125 ms, el error de ±1,5 dB y el consumo a potencia constante de su regulador conmutado (la hoja
declara dos puntos; el consumo es el que declare el usuario).
