# Sonómetro que se lee desde el código

Un SEN0232 mide el nivel de sonido del ambiente y entrega una tensión; el ESP32-S3 la lee con su
ADC y el programa la convierte de vuelta a decibeles. Es el ejercicio clásico de entrada
analógica, con un sensor cuyos números salen de la hoja de datos.

## Para probarlo

Apretá **▶** y mirá la consola: imprime una línea por segundo con las cuentas del ADC, los voltios
y los decibeles. Después cambiá **Nivel de sonido del ambiente (dBA)** en el panel de propiedades
del sonómetro y mirá cómo cambia la lectura.

## Las dos conversiones

```
nivel (dBA) → [sensor] → tensión → [ADC] → cuentas → [tu programa] → nivel (dBA)
```

El sensor es lineal: **20 mV por decibel**, 0,6 V con 30 dBA y 2,6 V con 130 dBA. El ADC está
declarado con atenuación de 11 dB y fondo de escala de 3,1 V, así que la cuenta es
`4096 · V / 3,1`. El programa deshace las dos.

Medido con el motor sobre esta misma plantilla:

| Nivel | Tensión | Cuentas del ADC | Vuelve como |
|---|---|---|---|
| 30 dBA | 0,60 V | 796 | 30,1 dBA |
| 50 dBA | 1,00 V | 1324 | 50,1 dBA |
| 80 dBA | 1,60 V | 2118 | 80,1 dBA |
| 100 dBA | 2,00 V | 2646 | 100,1 dBA |
| 130 dBA | 2,60 V | 3440 | 130,2 dBA |

El error de ida y vuelta es de **0,2 dB**, por la cuantización del ADC. Queda bastante por debajo
del ±1,5 dB del propio sensor.

## Por qué el perfil de ADC está en el proyecto

En `project.json`, `sim.analogicoEsp` declara **qué tensión lee el ADC como 0 y cuál como fondo de
escala**, para qué GPIO y con qué atenuación. El emulador no trae una curva de fábrica: la
conversión es un dato del escenario, declarado con su fuente y sus condiciones.

La consecuencia práctica: **fuera del dominio declarado el ADC no inventa una cuenta, avisa.** Si
lees un GPIO sin canal declarado, o con otra atenuación, `read()` levanta un `OSError` con el
motivo (`SIN_MODELO_CANAL`). Por eso el programa lo atrapa y lo imprime en vez de callarse.

## Lo que no se simula

El nivel de sonido del ambiente es un **dato de la escena**, no una simulación acústica: lo pones
vos con la prop. Tampoco se modelan la ponderación A real del sensor (31,5 Hz a 8,5 kHz), su
constante de tiempo de 125 ms ni su error de ±1,5 dB.
