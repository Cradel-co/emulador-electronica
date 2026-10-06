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

El volumen sigue a `sen(π·duty)`, que es la amplitud del fundamental de una onda cuadrada: máxima
al 50 % y nula en 0 % y 100 %, donde la señal es continua y el piezo no mueve aire. Al 25 % se
pierden 3 dB.

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

Tampoco se respeta el tiempo real: la melodía suena al ritmo al que avance la emulación.
