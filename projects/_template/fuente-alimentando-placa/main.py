# Placa alimentada por una Fuente regulable (pin 5V), no por USB.
# GPIO6 (interruptor, pull-up) -> GPIO7 (LED): el código prende el LED, como en
# cualquier circuito normal (a diferencia de la plantilla "circuito-continuo",
# donde el LED prende por corriente directa, sin pasar por el firmware).
import time
from machine import Pin

interruptor = Pin(6, Pin.IN, Pin.PULL_UP)
led = Pin(7, Pin.OUT)

print("Hola desde MicroPython")

ultimo = None
while True:
    encendido = interruptor.value() == 0
    led.value(1 if encendido else 0)
    if encendido != ultimo:
        print("Interruptor", "ON" if encendido else "OFF", "-> LED", 1 if encendido else 0)
        ultimo = encendido
    time.sleep_ms(50)
