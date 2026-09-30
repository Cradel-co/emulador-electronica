# Plantilla MicroPython para el emulador.
# GPIO6 (botón, pull-up) -> GPIO7 (LED).
import time
from machine import Pin

boton = Pin(6, Pin.IN, Pin.PULL_UP)
led = Pin(7, Pin.OUT)

print("Hola desde MicroPython")

ultimo = None
while True:
    presionado = boton.value() == 0
    led.value(1 if presionado else 0)
    if presionado != ultimo:
        print("Boton", "PRESIONADO" if presionado else "suelto", "-> LED", 1 if presionado else 0)
        ultimo = presionado
    time.sleep_ms(50)
