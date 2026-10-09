# Melodía con un buzzer pasivo

Un buzzer pasivo **no tiene oscilador**: no suena por recibir tensión, suena porque el programa le
pone una señal alterna. Por eso puede tocar notas, y un buzzer activo no. Este proyecto toca una
escala y un arpegio con `machine.PWM`.

## Para probarlo

Apretá **▶**. Además de ejecutar el programa, ese click habilita el audio del navegador, que no
deja sonar nada sin un gesto del usuario.

## Cómo se controla el sonido

| Lo que cambiás | Qué pasa |
|---|---|
| `buzzer.freq(hz)` | **el tono**: 262 Hz es un do, 440 Hz un la |
| `buzzer.duty_u16(32768)` | **el volumen**: máximo al 50 % (32768 de 65535) |
| `buzzer.duty_u16(0)` | **silencio**: sin señal alterna no hay sonido |
| `buzzer.deinit()` | libera el pin y se calla |

El volumen sigue a `sen(π·duty)`: máximo al 50 % y nulo en 0 % y 100 %, donde la señal es continua
y el piezo no mueve aire. Al 25 % se pierden 3 dB, y el 25 % y el 75 % suenan igual. No es una
curva elegida a dedo: es la amplitud del fundamental de la onda cuadrada según su serie de
Fourier, explicada en [`docs/audio.md`](../../../docs/audio.md).

Y el duty también cambia el **timbre**, no solo el volumen: el navegador sintetiza la onda con el
ciclo de trabajo real, así que un pulso angosto se oye más delgado y nasal, como un piezo de
verdad. Probalo cambiando el `32768` de `tocar()` por `6554` (10 %) y comparando.

## Lo que hay que entender del emulador

**El tono no se mide, se declara.** El puente muestrea los registros de salida del GPIO cada
cierto rato, así que un tono de cientos o miles de hertz no se puede reconstruir de los flancos:
se perdería en el aliasing. Lo que viaja es el dato — "GPIO 5, 440 Hz, duty 32768" — una vez por
cambio, y el navegador sintetiza a partir de eso.

La consecuencia buena es que cambiar de nota es exacto y barato. La consecuencia a tener en cuenta
es que **el PWM que no pase por `machine.PWM` no se oye**: prender y apagar un pin a mano en un
bucle no produce sonido, porque nadie declara una frecuencia.

## Lo que no se simula

La **resonancia mecánica** del piezo: uno real suena bastante más fuerte cerca de sus 4 kHz que en
las notas graves de esta melodía, y acá el volumen no depende de la frecuencia. Tampoco la caja ni
el soporte, que en un piezo real cambian mucho el resultado.

## El ritmo no es parejo, y es así

**La melodía va a sonar irregular**: a veces más rápido, a veces trancándose. No es un error del
proyecto ni del audio — es que **el emulador no corre en tiempo real**.

Medido sobre esta plantilla, con el programa pidiendo 220 ms por nota:

| | |
|---|---|
| Lo que pide el programa | 220 ms |
| Mediana real | ~250 ms |
| Mínimo / máximo | 35 ms / 1517 ms |

`esp-emu` ejecuta el ESP32 tan rápido o tan lento como lo deje la máquina, así que un
`sleep_ms(220)` se convierte en lo que salga. El tono sigue fielmente a lo que hace el programa; lo
que no es fiel es el reloj.

La latencia que agrega el emulador mismo —avisar el cambio y recalcular el circuito— es de
**9 a 41 ms**, despreciable al lado de ese jitter.

Si querés oír la melodía a tiempo, el lugar es una placa real.

## Un detalle de la API que vale saber

`tocar()` usa **un solo `init(freq=..., duty_u16=...)`** y no `freq()` seguido de `duty_u16()`.

Cada llamada avisa al emulador por separado, y entre las dos el pin queda con la frecuencia nueva
y el ciclo de trabajo viejo. Saliendo de un silencio eso es un **instante de silencio en cada
nota**. Con un solo `init` hay un aviso por nota y el salto no existe.
