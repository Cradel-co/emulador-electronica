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
| `pwm` | La pone el micro y la declara el puente | Buzzer pasivo, piezo | falta `@PWM` en el puente |
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

## Lo que falta (y hay que decirlo)

- **Falta el control de volumen y silencio.** El `ControladorAudio` ya los implementa
  (`silenciar()`, `cambiarVolumen()`), pero no hay nada visible que los toque: el volumen queda
  en el 0,5 inicial. Hacerlo tocaría `index.html`, `react/montar.ts` y `react/puente.ts`.
- **El tono está declarado, no calculado.** Sale de la hoja de datos o del PWM que informa el
  firmware, no del motor.
- **No hay audio por flancos de GPIO**: el puente muestrea los registros de salida, y el muestreo
  aliasa. Un tono de 2 kHz no se puede reconstruir así.
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
