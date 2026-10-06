# Audio: módulos que suenan

Cómo funciona el sonido en el emulador, qué hay implementado y cómo se agrega un módulo que
suene. El *por qué* de cada decisión está en [SDD-AUDIO.md](../SDD-AUDIO.md).

## El principio: el DAC lo pone tu placa de sonido

El emulador **no convierte números en voltaje**. Eso ya lo hace el hardware de audio de la
máquina. Lo que el emulador produce es la *descripción* del sonido —qué frecuencia, con cuánta
amplitud, desde qué módulo— y el navegador la sintetiza con la Web Audio API.

```
firmware emulado → "GPIO5 en 1" → motor: el buzzer tiene 4,8 V → evento de sonido → navegador
```

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

## Lo que falta (y hay que decirlo)

- **Todavía no suena**, pero por una sola costura. Están el contrato, el módulo, la lógica de
  amplitud y el adaptador del navegador ([`app/web/audio.ts`](../app/web/audio.ts), con el
  `ControladorAudio` y la Web Audio API detrás de un puerto propio). Falta que el server
  publique el `EventoSonido` y que `app.ts` lo rutee al llamar a `eventoSonido()`, que ya está
  exportado.
- **El tono está declarado, no calculado.** Sale de la hoja de datos o del PWM que informa el
  firmware, no del motor.
- **No hay audio por flancos de GPIO**: el puente muestrea los registros de salida, y el muestreo
  aliasa. Un tono de 2 kHz no se puede reconstruir así.
- **Ninguna de las placas del repo (C3, C6, S3) tiene DAC interno.** Espressif lo sacó después
  del ESP32 clásico. El audio analógico de salida obliga a un chip externo por I2S.
- **El `AudioContext` necesita un gesto del usuario** (política de autoplay). El controlador ya
  lo resuelve: no crea el contexto hasta que se llama a `habilitar()`, y entonces arranca lo que
  ya venía zumbando. Falta el control visible que lo dispare.

## Entrada: micrófono

No comparte nada con lo anterior. Un micrófono es un sensor analógico: lo lee el ADC y el DAC no
participa. Ver la sección 7 del [SDD](../SDD-AUDIO.md).
