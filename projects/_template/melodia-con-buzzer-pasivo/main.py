# Melodía con un buzzer pasivo.
#
# Un buzzer pasivo no tiene oscilador: no suena por recibir tensión, suena porque el
# programa le pone una señal alterna. Por eso puede tocar notas, y un buzzer activo no.
#
# El tono lo da la frecuencia del PWM; el volumen, el ciclo de trabajo (máximo al 50 %).
from machine import PWM, Pin
import time

GPIO_BUZZER = 5

# Frecuencias de las notas, en hertz (cuarta octava).
NOTAS = {
    'do': 262, 're': 294, 'mi': 330, 'fa': 349,
    'sol': 392, 'la': 440, 'si': 494, 'do5': 523,
}

# La escala, y después un arpegio. Cada par es (nota, milisegundos).
MELODIA = [
    ('do', 220), ('re', 220), ('mi', 220), ('fa', 220),
    ('sol', 220), ('la', 220), ('si', 220), ('do5', 440),
    (None, 220),
    ('do', 160), ('mi', 160), ('sol', 160), ('do5', 480),
]

buzzer = PWM(Pin(GPIO_BUZZER), freq=NOTAS['la'], duty_u16=0)


def tocar(nombre, ms):
    """Una nota: la frecuencia da el tono, el duty al 50 % da el volumen máximo.

    Se usa un solo `init()` y no `freq()` seguido de `duty_u16()`: cada llamada avisa al
    emulador por separado, y entre las dos el pin queda con la frecuencia nueva y el duty
    viejo. Saliendo de un silencio eso es un instante de silencio en cada nota.
    """
    if nombre is None:
        buzzer.duty_u16(0)                                  # sin señal alterna no hay sonido
    else:
        buzzer.init(freq=NOTAS[nombre], duty_u16=32768)     # 50 % de 65535: volumen máximo
    time.sleep_ms(ms)


try:
    while True:
        for nombre, ms in MELODIA:
            tocar(nombre, ms)
        buzzer.duty_u16(0)
        time.sleep_ms(900)
finally:
    # Libera el pin: avisa que dejó de hacer PWM, así el buzzer se calla.
    buzzer.deinit()
